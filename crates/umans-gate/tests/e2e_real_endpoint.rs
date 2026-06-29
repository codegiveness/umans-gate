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
use std::time::{Duration, Instant};

use http_body_util::BodyExt;
use hyper::header::{AUTHORIZATION, CONTENT_TYPE};
use hyper::{HeaderMap, Method};
use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::server::conn::auto::Builder;
use hyper_util::service::TowerToHyperService;
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::sleep;
use tokio_util::sync::CancellationToken;
use umans_gate::concurrency::{MetricUpdate, ProviderLimiter};
use umans_gate::config_store::ConfigStore;
use umans_gate::dashboard::tracked_permit::TrackedPermit;
use umans_gate::dashboard::tracker::{ProtocolVersion, RequestTracker};
use umans_gate::proxy::router::{proxy_router, ProxyState};
use umans_gate::proxy::timeouts::forward_with_timeouts;
use umans_gate::proxy::upstream::UpstreamClient;
use umans_gate::shutdown::{ShutdownSignal, ShutdownToken};
use umans_gate::types::{
    GatewayConfig, ModelConfig, ModelId, ProviderConfig, ProviderId, TimeoutConfig, Weight,
};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Helpers (mirror crates/umans-gate/tests/integration_passthrough.rs)
// ---------------------------------------------------------------------------

/// Spawn the proxy with a manual HTTP/1-only accept loop (mirrors serve.rs).
///
/// Returns (proxy_addr, shutdown_token, server_join_handle). Call
/// `token.signal()` to stop accepting and drain in-flight connections.
async fn spawn_proxy(
    state: Arc<ProxyState>,
) -> (std::net::SocketAddr, ShutdownToken, JoinHandle<()>) {
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
        tracker: Arc::new(RequestTracker::new()),
        upstream_client,
    });

    // 4. Spawn the proxy.
    let (proxy_addr, token, server_handle) = spawn_proxy(state).await;

    // 5. Build HTTP/1.1-only reqwest client.
    let client = http1_client();

    // 6. GET /umans/v1/models/info with a generous timeout (TLS handshake + upstream latency).
    let url = format!("http://{proxy_addr}{path}", path = "/umans/v1/models/info");
    let resp = tokio::time::timeout(Duration::from_secs(30), client.get(&url).send())
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
    assert!(body.is_object(), "response JSON is not an object: {body}");
    let obj = body.as_object().unwrap();
    assert!(!obj.is_empty(), "response JSON object is empty: {body}");
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

/// Build a `TrackedPermit` against the shared live limiter/tracker.
async fn make_live_permit(
    limiter: &Arc<ProviderLimiter>,
    tracker: &Arc<RequestTracker>,
) -> TrackedPermit {
    let provider_id = ProviderId::new("umans");
    let model_id = ModelId::new("umans-flash");
    let id = Uuid::new_v4();

    tracker.register_queued(
        id,
        &provider_id,
        &model_id,
        Weight::from(1.0),
        ProtocolVersion::Http11,
        "/v1/chat/completions".to_string(),
    );

    let permit = limiter
        .acquire(&provider_id, &model_id, Weight::from(1.0))
        .await
        .expect("acquire live permit");

    tracker.mark_running(id, Some(ProtocolVersion::Http11));
    let token = tracker
        .cancellation_token(id)
        .unwrap_or_else(CancellationToken::new);
    TrackedPermit::new(permit, id, Arc::clone(tracker), token)
}

/// Fetch `/v1/usage` for the account and return the JSON value.
async fn fetch_usage(client: &reqwest::Client, api_key: &str) -> Option<serde_json::Value> {
    client
        .get("https://api.code.umans.ai/v1/usage")
        .header("Authorization", format!("Bearer {api_key}"))
        .send()
        .await
        .ok()?
        .json::<serde_json::Value>()
        .await
        .ok()
}

/// Live QA regression: after one of two concurrent SSE streams is dropped,
/// the provider-side `concurrent_sessions` count must never spike above 2.
///
/// Requires `UMANS_API_KEY` and outbound network to `api.code.umans.ai`.
/// Ignored by default; run with `--ignored`.
#[tokio::test]
#[ignore]
async fn live_429_regression_cooldown_holds_permit() {
    let api_key = std::env::var("UMANS_API_KEY").unwrap_or_default();
    if api_key.is_empty() {
        eprintln!("skipping live_429_regression_cooldown_holds_permit: UMANS_API_KEY not set");
        return;
    }

    let usage_client = http1_client();
    let Some(usage) = fetch_usage(&usage_client, &api_key).await else {
        eprintln!("skipping live_429_regression_cooldown_holds_permit: /v1/usage unreachable");
        return;
    };
    let boxed = usage["usage"]["priority"]["boxed_until"]
        .as_str()
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    if boxed {
        eprintln!(
            "skipping live_429_regression_cooldown_holds_permit: account is boxed until {:?}",
            usage["usage"]["priority"]["boxed_until"]
        );
        return;
    }

    eprintln!(
        "live_429_regression: baseline concurrent_sessions = {:?}",
        usage["usage"]["concurrent_sessions"]
    );

    let provider = ProviderConfig {
        id: ProviderId::new("umans"),
        upstream_url: url::Url::parse("https://api.code.umans.ai").unwrap(),
        capacity: Weight::from(4.0),
        models: vec![ModelConfig {
            id: ModelId::new("umans-flash"),
            weight: Weight::from(1.0),
        }],
        timeouts: TimeoutConfig {
            stream_idle: Some(Duration::from_secs(60)),
            total: Some(Duration::from_secs(300)),
            ..Default::default()
        },
    };

    let (tx, _rx) = broadcast::channel::<MetricUpdate>(16);
    let limiter = Arc::new(ProviderLimiter::new(tx));
    limiter.register(
        &provider.id,
        provider.capacity,
        provider.timeouts.queuetimeout,
        provider.timeouts.maxqueue,
    );
    let tracker = Arc::new(RequestTracker::new());
    let client = UpstreamClient::new();

    let permit_a = make_live_permit(&limiter, &tracker).await;
    let permit_b = make_live_permit(&limiter, &tracker).await;
    let token_a = permit_a.token();
    let token_b = permit_b.token();

    let body_json = serde_json::json!({
        "model": "umans-flash",
        "messages": [{"role": "user", "content": "hi"}],
        "max_tokens": 3,
        "stream": true
    })
    .to_string();
    let upstream_uri = "/v1/chat/completions".to_string();

    let mut headers = HeaderMap::new();
    headers.insert(
        AUTHORIZATION,
        format!("Bearer {api_key}")
            .parse()
            .expect("valid bearer header"),
    );
    headers.insert(
        CONTENT_TYPE,
        "application/json".parse().expect("valid content-type"),
    );

    let (result_a, result_b) = tokio::join!(
        forward_with_timeouts(
            &client,
            &provider,
            Method::POST,
            upstream_uri.clone(),
            headers.clone(),
            axum::body::Body::from(body_json.clone()),
            permit_a,
            token_a,
        ),
        forward_with_timeouts(
            &client,
            &provider,
            Method::POST,
            upstream_uri,
            headers,
            axum::body::Body::from(body_json),
            permit_b,
            token_b,
        ),
    );

    let resp_a = result_a.expect("first stream connect+ttfb failed");
    let resp_b = result_b.expect("second stream connect+ttfb failed");
    assert!(
        resp_a.status().is_success(),
        "first stream not 2xx: {}",
        resp_a.status()
    );
    assert!(
        resp_b.status().is_success(),
        "second stream not 2xx: {}",
        resp_b.status()
    );

    let mut body_a = resp_a.into_body();
    let frame = body_a
        .frame()
        .await
        .expect("stream A ended before first frame")
        .expect("stream A first frame error");
    let _first_chunk = frame.into_data().expect("stream A first frame is not data");
    let disconnect_at = Instant::now();
    eprintln!(
        "live_429_regression: dropped stream A at {:?}",
        disconnect_at
    );
    drop(body_a);

    let mut first_below_two: Option<Instant> = None;
    for _ in 0..20 {
        if let Some(usage) = fetch_usage(&usage_client, &api_key).await {
            let sessions = usage["usage"]["concurrent_sessions"].as_i64().unwrap_or(-1);
            assert!(
                sessions <= 2,
                "provider concurrent_sessions spiked above 2: {}",
                sessions
            );
            if sessions < 2 && first_below_two.is_none() {
                first_below_two = Some(Instant::now());
                let latency = disconnect_at.elapsed();
                eprintln!(
                    "live_429_regression: first usage sample <2 after disconnect: {:?}",
                    latency
                );
                if latency > Duration::from_millis(500) {
                    eprintln!(
                        "WARNING: permit cooldown exceeded 500ms; hyper may be pooling the upstream connection"
                    );
                }
            }
        }
        sleep(Duration::from_millis(100)).await;
    }

    let elapsed = disconnect_at.elapsed();
    if elapsed < Duration::from_millis(700) {
        sleep(Duration::from_millis(700) - elapsed).await;
    }
    if let Some(usage) = fetch_usage(&usage_client, &api_key).await {
        let sessions = usage["usage"]["concurrent_sessions"].as_i64().unwrap_or(-1);
        assert_eq!(
            sessions, 1,
            "expected exactly 1 remaining live session ~700ms after disconnect, got {}",
            sessions
        );
    } else {
        panic!("failed to fetch /v1/usage at 700ms checkpoint");
    }

    let _remaining = resp_b
        .into_body()
        .collect()
        .await
        .expect("consume remaining stream B failed");

    if let Some(usage) = fetch_usage(&usage_client, &api_key).await {
        let sessions = usage["usage"]["concurrent_sessions"].as_i64().unwrap_or(-1);
        assert_eq!(
            sessions, 0,
            "expected zero provider concurrent_sessions after stream B ended, got {}",
            sessions
        );
    } else {
        panic!("failed to fetch /v1/usage after stream B completed");
    }
}
