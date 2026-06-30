//! Dynamic model fetch from the Umans API for default config generation.
//!
//! At startup, when no config file exists, the gateway fetches the model
//! list from `https://api.code.umans.ai/v1/models/info` and builds a
//! `GatewayConfig` with all models at weight `1.0` and provider capacity
//! `4.0`. If the fetch fails (network, timeout, parse), a hardcoded
//! `fallback_config()` with the 6 known models is returned instead.
//!
//! The HTTP client follows the same pattern as `proxy::upstream::UpstreamClient`
//! (hyper-rustls with webpki roots, HTTP/1 only) but is self-contained to
//! avoid coupling to the proxy module.
//!
//! Fetched responses are cached in `~/.cache/umans-gate/models-info.json`
//! with a 24h TTL. On network failure, a stale cache is used as an offline
//! fallback before resorting to `fallback_config()`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use directories::ProjectDirs;
use http_body_util::{BodyExt, Empty};
use hyper::Method;
use hyper_rustls::HttpsConnectorBuilder;
use hyper_util::client::legacy::Client as HyperClient;
use hyper_util::rt::TokioExecutor;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};
use url::Url;

use crate::error::{GatewayError, Result};
use crate::types::{
    GatewayConfig, ModelConfig, ModelId, ProviderConfig, ProviderId, TimeoutConfig, Weight,
};

/// Default API endpoint for fetching model info.
const DEFAULT_MODELS_INFO_URL: &str = "https://api.code.umans.ai/v1/models/info";

/// Base upstream URL for the umans provider.
const UPSTREAM_URL: &str = "https://api.code.umans.ai";

/// Maximum time to wait for the API response (≤ 5s per spec).
const FETCH_TIMEOUT: Duration = Duration::from_secs(5);

/// Cache TTL: 24 hours.
const CACHE_TTL_SECS: u64 = 24 * 60 * 60;

/// Hardcoded fallback model list (6 known Umans models).
const FALLBACK_MODELS: &[&str] = &[
    "umans-kimi-k2.7",
    "umans-glm-5.2",
    "umans-coder",
    "umans-glm-5.2-nvfp4",
    "umans-flash",
    "umans-qwen3.6-35b-a3b",
];

/// Parsed response from `/v1/models/info`: a flat map keyed by model id.
#[derive(Debug, Deserialize)]
struct ModelInfoResponse(HashMap<String, ModelInfo>);

/// Per-model info from the API. `name` is required; other fields are
/// optional and currently unused (parsed for validation only).
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct ModelInfo {
    name: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    description: String,
}

/// Cached models info: the raw JSON body plus a Unix-seconds timestamp.
#[derive(Debug, Serialize, Deserialize)]
struct CachedModelsInfo {
    fetched_at: u64,
    body: String,
}

/// Resolve the models info URL: env var > config value > default.
///
/// `config_url` is the `models_info_url` from `GatewayConfig` (if a config
/// file was loaded). When `None`, only env var and default are considered.
fn resolve_models_info_url(config_url: Option<&str>) -> String {
    if let Ok(env_url) = std::env::var("UMANS_GATE_MODELS_INFO_URL") {
        if !env_url.is_empty() {
            return env_url;
        }
    }
    config_url
        .map(str::to_string)
        .unwrap_or_else(|| DEFAULT_MODELS_INFO_URL.to_string())
}

/// Cross-platform cache directory via `directories::ProjectDirs`.
fn project_dirs() -> Option<ProjectDirs> {
    ProjectDirs::from("", "", "umans-gate")
}

/// Path to the models-info cache file, if a project dir can be resolved.
fn cache_path() -> Option<PathBuf> {
    project_dirs().map(|d| d.cache_dir().join("models-info.json"))
}

/// Read and parse the cache file, if it exists and is valid.
fn read_cache(path: &Path) -> Option<CachedModelsInfo> {
    let data = std::fs::read(path).ok()?;
    serde_json::from_slice(&data).ok()
}

/// Write the cache file with the current timestamp. Failures are logged
/// and non-fatal (the fetch itself already succeeded).
fn write_cache(path: &Path, body: &[u8]) {
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            warn!(error = %e, "failed to create cache directory");
            return;
        }
    }
    let cached = CachedModelsInfo {
        fetched_at: now_secs(),
        body: String::from_utf8_lossy(body).into_owned(),
    };
    match serde_json::to_vec_pretty(&cached) {
        Ok(data) => {
            if let Err(e) = std::fs::write(path, data) {
                warn!(error = %e, "failed to write models info cache");
            }
        }
        Err(e) => warn!(error = %e, "failed to serialize models info cache"),
    }
}

/// Whether the cached entry is within the 24h TTL.
fn is_cache_fresh(cached: &CachedModelsInfo) -> bool {
    let now = now_secs();
    now.saturating_sub(cached.fetched_at) < CACHE_TTL_SECS
}

/// Current time as Unix seconds (0 on clock errors).
fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Fetch the default gateway config from the Umans API.
///
/// GETs the resolved models info URL, parses the JSON map, and builds a
/// `GatewayConfig` with provider `umans`, capacity `4.0`, and all fetched
/// models at weight `1.0`. On any failure (network, timeout, non-200, parse
/// error) it tries the cache (stale or fresh), then falls back to
/// `fallback_config()`.
pub async fn fetch_default_config() -> Result<GatewayConfig> {
    let url = resolve_models_info_url(None);
    let upstream_url = Url::parse(UPSTREAM_URL).expect("valid upstream url literal");
    let cache = cache_path();

    if let Some(ref cache_path) = cache {
        if let Some(cached) = read_cache(cache_path) {
            if is_cache_fresh(&cached) {
                if let Ok(cfg) =
                    build_config_from_bytes(cached.body.as_bytes(), upstream_url.clone())
                {
                    info!("using fresh cached models info");
                    return Ok(cfg);
                }
            }
        }
    }

    match try_fetch(&url).await {
        Ok(bytes) => {
            let cfg = build_config_from_bytes(&bytes, upstream_url)?;
            if let Some(ref cache_path) = cache {
                write_cache(cache_path, &bytes);
            }
            Ok(cfg)
        }
        Err(e) => {
            warn!(error = %e, "models info fetch failed, trying cache");
            if let Some(ref cache_path) = cache {
                if let Some(cached) = read_cache(cache_path) {
                    if let Ok(cfg) = build_config_from_bytes(cached.body.as_bytes(), upstream_url) {
                        warn!("using stale cached models info (offline fallback)");
                        return Ok(cfg);
                    }
                }
            }
            warn!("using hardcoded fallback config");
            Ok(fallback_config())
        }
    }
}

/// Perform the HTTP fetch and return the raw response body bytes.
async fn try_fetch(url: &str) -> Result<Vec<u8>> {
    let https = HttpsConnectorBuilder::new()
        .with_webpki_roots()
        .https_or_http()
        .enable_http1()
        .build();
    let client = HyperClient::builder(TokioExecutor::new()).build(https);

    let req = hyper::Request::builder()
        .method(Method::GET)
        .uri(url)
        .body(Empty::<Bytes>::new())
        .map_err(|e| GatewayError::Upstream(format!("request build error: {e}")))?;

    let resp = tokio::time::timeout(FETCH_TIMEOUT, client.request(req))
        .await
        .map_err(|_| GatewayError::Timeout("models info fetch exceeded 5s".into()))?
        .map_err(|e| GatewayError::Upstream(format!("request error: {e}")))?;

    let status = resp.status();
    if !status.is_success() {
        return Err(GatewayError::Upstream(format!(
            "models info returned status {status}"
        )));
    }

    let bytes = BodyExt::collect(resp.into_body())
        .await
        .map_err(|e| GatewayError::Upstream(format!("body read error: {e}")))?
        .to_bytes();

    Ok(bytes.to_vec())
}

/// Parse the raw JSON response body into a `GatewayConfig`.
///
/// Expects a flat JSON object keyed by model id:
/// `{"umans-coder": {"name": "umans-coder", ...}, ...}`.
fn build_config_from_bytes(body: &[u8], upstream_url: Url) -> Result<GatewayConfig> {
    let response: ModelInfoResponse = serde_json::from_slice(body)
        .map_err(|e| GatewayError::Upstream(format!("json parse error: {e}")))?;

    let mut models: Vec<ModelConfig> = response
        .0
        .into_keys()
        .map(|name| ModelConfig {
            id: ModelId::new(name),
            weight: Weight::from(1.0),
        })
        .collect();
    models.sort_by(|a, b| a.id.as_ref().cmp(b.id.as_ref()));

    if models.is_empty() {
        return Err(GatewayError::Upstream(
            "models info returned empty map".into(),
        ));
    }

    Ok(GatewayConfig {
        providers: vec![ProviderConfig {
            id: ProviderId::new("umans"),
            upstream_url,
            capacity: Weight::from(4.0),
            models,
            timeouts: TimeoutConfig::default(),
        }],
        bind: "0.0.0.0:8080".parse().expect("valid bind addr literal"),
        dashboard_bind: "127.0.0.1:9090"
            .parse()
            .expect("valid dashboard bind addr literal"),
        dashboard: None,
        models_info_url: DEFAULT_MODELS_INFO_URL.to_string(),
    })
}

/// Hardcoded fallback config with the 6 known Umans models.
///
/// Used when the API is unreachable at startup and no cache exists. All
/// models are at weight `1.0`, provider capacity `4.0`.
pub fn fallback_config() -> GatewayConfig {
    let upstream_url = Url::parse(UPSTREAM_URL).expect("valid upstream url literal");
    let models = FALLBACK_MODELS
        .iter()
        .map(|&name| ModelConfig {
            id: ModelId::new(name),
            weight: Weight::from(1.0),
        })
        .collect();

    GatewayConfig {
        providers: vec![ProviderConfig {
            id: ProviderId::new("umans"),
            upstream_url,
            capacity: Weight::from(4.0),
            models,
            timeouts: TimeoutConfig::default(),
        }],
        bind: "0.0.0.0:8080".parse().expect("valid bind addr literal"),
        dashboard_bind: "127.0.0.1:9090"
            .parse()
            .expect("valid dashboard bind addr literal"),
        dashboard: None,
        models_info_url: DEFAULT_MODELS_INFO_URL.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    fn env_guard() -> std::sync::MutexGuard<'static, ()> {
        ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .expect("env lock poisoned")
    }

    #[test]
    fn fallback_config_has_6_models() {
        let cfg = fallback_config();
        assert_eq!(cfg.providers.len(), 1, "exactly one provider");
        let p = &cfg.providers[0];
        assert_eq!(p.id.as_ref(), "umans");
        assert_eq!(p.capacity.to_milliunits(), 4000, "capacity 4.0");
        assert_eq!(p.models.len(), 6, "6 fallback models");
        for m in &p.models {
            assert_eq!(m.weight.to_milliunits(), 1000, "weight 1.0");
        }
        assert_eq!(p.upstream_url.as_str(), "https://api.code.umans.ai/");
        let names: Vec<&str> = p.models.iter().map(|m| m.id.as_ref()).collect();
        for &expected in FALLBACK_MODELS {
            assert!(
                names.contains(&expected),
                "fallback missing model: {expected}"
            );
        }
        assert_eq!(
            cfg.bind,
            "0.0.0.0:8080".parse::<std::net::SocketAddr>().unwrap()
        );
        assert_eq!(
            cfg.dashboard_bind,
            "127.0.0.1:9090".parse::<std::net::SocketAddr>().unwrap()
        );
        assert_eq!(cfg.models_info_url, DEFAULT_MODELS_INFO_URL);
    }

    #[test]
    fn build_config_from_mock_json() {
        let json = br#"{
            "umans-coder": {"name": "umans-coder", "display_name": "Coder", "description": "code"},
            "umans-flash": {"name": "umans-flash"}
        }"#;
        let url = Url::parse("https://api.code.umans.ai").unwrap();
        let cfg = build_config_from_bytes(json, url).unwrap();
        assert_eq!(cfg.providers.len(), 1);
        let p = &cfg.providers[0];
        assert_eq!(p.id.as_ref(), "umans");
        assert_eq!(p.capacity.to_milliunits(), 4000);
        assert_eq!(p.models.len(), 2);
        for m in &p.models {
            assert_eq!(m.weight.to_milliunits(), 1000);
        }
    }

    #[test]
    fn build_config_rejects_empty_map() {
        let json = b"{}";
        let url = Url::parse("https://api.code.umans.ai").unwrap();
        assert!(build_config_from_bytes(json, url).is_err());
    }

    #[test]
    fn build_config_rejects_invalid_json() {
        let json = b"not json at all";
        let url = Url::parse("https://api.code.umans.ai").unwrap();
        assert!(build_config_from_bytes(json, url).is_err());
    }

    #[test]
    fn build_config_rejects_array() {
        let json = b"[1, 2, 3]";
        let url = Url::parse("https://api.code.umans.ai").unwrap();
        assert!(build_config_from_bytes(json, url).is_err());
    }

    #[test]
    fn resolve_url_prefers_env_var() {
        let _guard = env_guard();
        let prev = std::env::var("UMANS_GATE_MODELS_INFO_URL").ok();
        std::env::set_var("UMANS_GATE_MODELS_INFO_URL", "https://env.example.com/info");
        let url = resolve_models_info_url(Some("https://config.example.com/info"));
        assert_eq!(url, "https://env.example.com/info");
        match prev {
            Some(v) => std::env::set_var("UMANS_GATE_MODELS_INFO_URL", v),
            None => std::env::remove_var("UMANS_GATE_MODELS_INFO_URL"),
        }
    }

    #[test]
    fn resolve_url_uses_config_when_no_env() {
        let _guard = env_guard();
        std::env::remove_var("UMANS_GATE_MODELS_INFO_URL");
        let url = resolve_models_info_url(Some("https://config.example.com/info"));
        assert_eq!(url, "https://config.example.com/info");
    }

    #[test]
    fn resolve_url_uses_default_when_nothing_set() {
        let _guard = env_guard();
        std::env::remove_var("UMANS_GATE_MODELS_INFO_URL");
        let url = resolve_models_info_url(None);
        assert_eq!(url, DEFAULT_MODELS_INFO_URL);
    }

    #[test]
    fn cached_models_info_roundtrip() {
        let cached = CachedModelsInfo {
            fetched_at: 1234567890,
            body: r#"{"umans-coder":{"name":"umans-coder"}}"#.to_string(),
        };
        let json = serde_json::to_string(&cached).unwrap();
        let back: CachedModelsInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(back.fetched_at, 1234567890);
        assert_eq!(back.body, cached.body);
    }

    #[test]
    fn is_cache_fresh_check() {
        let now = now_secs();
        let fresh = CachedModelsInfo {
            fetched_at: now,
            body: "{}".to_string(),
        };
        assert!(is_cache_fresh(&fresh));
        let stale = CachedModelsInfo {
            fetched_at: now - CACHE_TTL_SECS - 1,
            body: "{}".to_string(),
        };
        assert!(!is_cache_fresh(&stale));
    }

    /// Real network fetch — requires outbound HTTPS to api.code.umans.ai.
    /// Ignored by default; run with `--ignored`.
    #[tokio::test]
    #[ignore]
    async fn fetch_default_config_real() {
        let cfg = fetch_default_config()
            .await
            .expect("fetch should not error (falls back)");
        assert_eq!(cfg.providers.len(), 1);
        let p = &cfg.providers[0];
        assert_eq!(p.id.as_ref(), "umans");
        assert_eq!(p.capacity.to_milliunits(), 4000);
        assert!(!p.models.is_empty(), "should have at least one model");
        for m in &p.models {
            assert_eq!(m.weight.to_milliunits(), 1000, "all weights 1.0");
        }
        assert_eq!(
            cfg.bind,
            "0.0.0.0:8080".parse::<std::net::SocketAddr>().unwrap()
        );
        assert_eq!(
            cfg.dashboard_bind,
            "127.0.0.1:9090".parse::<std::net::SocketAddr>().unwrap()
        );
    }
}
