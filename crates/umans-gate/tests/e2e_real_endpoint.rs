#![cfg(feature = "hot-reload")]

//! E2E test: gateway against the real upstream `https://api.code.umans.ai`.
//!
//! Loads `examples/config.yaml` (single `umans` provider, upstream_url
//! `https://api.code.umans.ai`, capacity 4.0) and drives a GET
//! `/v1/models/info` through the gateway using the same manual HTTP/1-only
//! accept loop as `integration_passthrough.rs`.
//!
//! Marked `#[ignore]` because it requires outbound network to the real
//! upstream. Run with:
//!
//! ```bash
//! cargo test --workspace --features hot-reload --test e2e_real_endpoint -- --ignored
//! ```

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::server::conn::auto::Builder;
use hyper_util::service::TowerToHyperService;
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tokio::task::{JoinHandle, JoinSet};
use umans_gate::concurrency::{MetricUpdate, ProviderLimiter};
use umans_gate::config_store::ConfigStore;
use umans_gate::proxy::router::{proxy_router, ProxyState};
use umans_gate::proxy::upstream::UpstreamClient;
use umans_gate::shutdown::{ShutdownSignal, ShutdownToken};
use umans_gate::types::GatewayConfig;

// ---------------------------------------------------------------------------
// Helpers (mirror crates/umans-gate/tests/integration_passthrough.rs)
// ---------------------------------------------------------------------------

/// Spawn the proxy with a manual HTTP/1-only accept loop (mirrors serve.rs).
///
/// Returns (proxy_addr, shutdown_token, server_join_handle). Call
/// `token.signal()` to stop accepting and drain in-flight connections.
async fn spawn_proxy(state: Arc<ProxyState>) -> (std::net::SocketAddr, ShutdownToken, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let (sig, _rx) = ShutdownSignal::new(Duration::from_secs(5));
    let shutdown = Arc::new(sig);
    let token = shutdown.token();

    let app = proxy_router(state);
    let service = TowerToHyperService::new(app);

    let handle = tokio::spawn(async move {
        let mut connections = JoinSet::new();
        loop {
            tokio::select! {
                biased;
                _ = shutdown.watch_for_shutdown() => break,
                accept = listener.accept() => {
                    let (stream, _) = match accept {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    let service = service.clone();
                    let shutdown = Arc::clone(&shutdown);
                    connections.spawn(async move {
                        let builder = Builder::new(TokioExecutor::new()).http1_only();
                        let mut conn = std::pin::pin!(
                            builder.serve_connection_with_upgrades(
                                TokioIo::new(stream),
                                service,
                            )
                        );
                        let _ = tokio::select! {
                            biased;
                            _ = shutdown.watch_for_shutdown() => {
                                conn.as_mut().graceful_shutdown();
                                conn.await
                            }
                            res = conn.as_mut() => res,
                        };
                    });
                }
            }
        }
        while connections.join_next().await.is_some() {}
    });

    // Give the listener a moment to start accepting.
    tokio::time::sleep(Duration::from_millis(50)).await;
    (addr, token, handle)
}

/// Build an HTTP/1.1-only reqwest client with no connection pooling.
fn http1_client() -> reqwest::Client {
    reqwest::Client::builder()
        .http1_only()
        .pool_max_idle_per_host(0)
        .build()
        .unwrap()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// E2E: GET /v1/models/info through the gateway against the real upstream
/// `https://api.code.umans.ai`.
///
/// Requires outbound network. Ignored by default; run with `--ignored`.
#[tokio::test]
#[ignore]
async fn e2e_real_models_info() {
    // 1. Load examples/config.yaml (single umans provider, real upstream).
    let config_path: PathBuf = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("examples")
        .join("config.yaml");
    let mut config = GatewayConfig::load(&config_path).expect("load examples/config.yaml");

    // 2. Override bind/dashboard_bind to ephemeral ports so the test does
    //    not require 8080/9090 to be free.
    config.bind = "127.0.0.1:0".parse().unwrap();
    config.dashboard_bind = "127.0.0.1:0".parse().unwrap();

    // 3. Create ProxyState. ConfigStore::new registers providers with limiter.
    let (tx, _rx) = broadcast::channel::<MetricUpdate>(16);
    let limiter = Arc::new(ProviderLimiter::new(tx));
    let config_store = Arc::new(ConfigStore::new(config, limiter.clone()));
    let upstream_client = Arc::new(UpstreamClient::new());
    let state = Arc::new(ProxyState {
        config_store,
        limiter,
        upstream_client,
    });

    // 4. Spawn the proxy.
    let (proxy_addr, token, server_handle) = spawn_proxy(state).await;

    // 5. Build HTTP/1.1-only reqwest client.
    let client = http1_client();

    // 6. GET /umans/v1/models/info with a generous timeout (TLS handshake + upstream latency).
    let url = format!("http://{proxy_addr}{path}", path="/umans/v1/models/info");
    let resp = tokio::time::timeout(
        Duration::from_secs(30),
        client.get(&url).send(),
    )
    .await
    .expect("request did not complete within 30s")
    .expect("request failed");

    // 7. Assert HTTP 200.
    assert!(
        resp.status().is_success(),
        "expected 2xx, got {}",
        resp.status()
    );

    // 8. Assert HTTP/1.1 response version.
    assert_eq!(
        resp.version(),
        reqwest::Version::HTTP_11,
        "expected HTTP/1.1 response, got {:?}",
        resp.version()
    );

    // 9. Parse body as JSON and assert it is a non-empty models payload.
    //    The real `/v1/models/info` endpoint returns a flat map keyed by model
    //    id (`{"umans-coder": {...}, ...}`) rather than `{models: [...]}` or
    //    `{data: [...]}`; accept either shape.
    let bytes = resp.bytes().await.expect("read response body");
    let body: serde_json::Value =
        serde_json::from_slice(&bytes).expect("response body is not valid JSON");
    assert!(
        body.is_object(),
        "response JSON is not an object: {body}"
    );
    let obj = body.as_object().unwrap();
    assert!(
        !obj.is_empty(),
        "response JSON object is empty: {body}"
    );
    let has_models_field = obj.contains_key("models") || obj.contains_key("data");
    let has_model_entries = obj.keys().any(|k| k.starts_with("umans-"));
    assert!(
        has_models_field || has_model_entries,
        "response JSON has neither `models`/`data` field nor `umans-*` model entries: {body}"
    );

    // 10. Cleanup.
    token.signal();
    let _ = tokio::time::timeout(Duration::from_secs(10), server_handle).await;
}
