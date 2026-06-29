#![cfg(feature = "hot-reload")]

//! Proxy request handler — extracts provider/model, acquires a weighted
//! concurrency permit, and forwards to upstream via [`forward_with_timeouts`].
//!
//! The permit is moved into the response body stream (inside
//! [`forward_with_timeouts`]); the handler never retains it after returning
//! `Ok(response)`.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::response::Response;
use http_body_util::BodyExt;
use serde_json::Value;

use crate::dashboard::tracker::ProtocolVersion;
use crate::error::{GatewayError, Result};
use crate::types::{ModelId, Weight};

use super::gating::acquire_for_request;
use super::router::ProxyState;
use super::timeouts::forward_with_timeouts;

/// Proxy handler — prefix-routed multi-provider passthrough.
///
/// Loads config once, resolves the provider from the first path segment,
/// parses the request body JSON for `"model"` and `"stream"`, acquires a
/// [`WeightedPermit`], and forwards the buffered body unchanged. The permit is
/// moved into the response body stream by [`forward_with_timeouts`]; this
/// function never holds it after return.
///
/// The `"stream"` flag is detected for logging/metrics only; it does not affect
/// routing or forwarding.
pub async fn proxy_handler(
    Path(path): Path<String>,
    State(state): State<Arc<ProxyState>>,
    req: axum::extract::Request,
) -> Result<Response> {
    let client_protocol = ProtocolVersion::from(req.version());
    let (parts, body) = req.into_parts();
    let method = parts.method;
    let headers = parts.headers;
    let body = body
        .collect()
        .await
        .map_err(|e| GatewayError::Upstream(format!("read body: {e}")))?
        .to_bytes();

    let config = state.config_store.load();

    // `axum` captures `/{*path}` without the leading `/`.
    let (provider_id, remainder) = path.split_once('/').unwrap_or((path.as_str(), ""));

    let provider_config = config
        .providers
        .iter()
        .find(|p| p.id.as_ref() == provider_id)
        .ok_or_else(|| GatewayError::UnknownProvider(provider_id.to_string()))?;

    let model_id = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|v| v.get("model")?.as_str().map(ModelId::new))
        .unwrap_or_else(|| ModelId::new(""));

    let stream = detect_stream(&body);
    tracing::debug!(stream, model = %model_id, provider = %provider_config.id, "proxy request");

    let weight = provider_config
        .model_weight(&model_id)
        .unwrap_or(Weight::from(1.0));

    let normalized_path = if remainder == "v1" || remainder.starts_with("v1/") {
        remainder.to_string()
    } else {
        format!("v1/{remainder}")
    };

    let permit = acquire_for_request(
        &state.limiter,
        &state.tracker,
        &provider_config.id,
        &model_id,
        weight,
        client_protocol,
        normalized_path.clone(),
    )
    .await?;

    let base = provider_config.upstream_url.as_str();
    let base = if base.ends_with('/') {
        base.to_string()
    } else {
        format!("{base}/")
    };

    let upstream_uri = format!("{base}{normalized_path}");

    let body = axum::body::Body::from(body);

    forward_with_timeouts(
        &state.upstream_client,
        provider_config,
        method,
        upstream_uri,
        headers,
        body,
        permit,
    )
    .await
}

/// Parse `"stream": true` from the request body (default `false`).
///
/// Returns `false` when the body is not valid JSON or the field is absent.
/// Used for logging/metrics only — never affects routing.
fn detect_stream(body: &[u8]) -> bool {
    serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|v| v.get("stream")?.as_bool())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::concurrency::{MetricUpdate, ProviderLimiter};
    use crate::config_store::ConfigStore;
    use crate::dashboard::tracker::RequestTracker;
    use crate::proxy::router::{proxy_router, ProxyState};
    use crate::proxy::upstream::UpstreamClient;
    use crate::types::{
        GatewayConfig, ModelConfig, ModelId, ProviderConfig, ProviderId, TimeoutConfig, Weight,
    };
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use axum::response::IntoResponse;
    use http_body_util::BodyExt;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::broadcast;
    use tower::ServiceExt;
    use url::Url;

    /// Like [`make_state`] but with a configurable provider id. Used by the
    /// prefix-routing tests which need provider id `"umans"`.
    fn make_state_with_provider(
        provider_id: &str,
        upstream_url: Url,
        timeouts: TimeoutConfig,
    ) -> Arc<ProxyState> {
        let config = GatewayConfig {
            providers: vec![ProviderConfig {
                id: ProviderId::new(provider_id),
                upstream_url,
                capacity: Weight::from(4.0),
                models: vec![ModelConfig {
                    id: ModelId::new("test-model"),
                    weight: Weight::from(1.0),
                }],
                timeouts,
            }],
            bind: "0.0.0.0:0".parse().unwrap(),
            dashboard_bind: "0.0.0.0:0".parse().unwrap(),
        };
        let (tx, _rx) = broadcast::channel::<MetricUpdate>(64);
        let limiter = Arc::new(ProviderLimiter::new(tx));
        let config_store = Arc::new(ConfigStore::new(config, limiter.clone()));
        let upstream_client = Arc::new(UpstreamClient::new());
        Arc::new(ProxyState {
            config_store,
            limiter,
            tracker: Arc::new(RequestTracker::new()),
            upstream_client,
        })
    }

    fn make_state(upstream_url: Url, timeouts: TimeoutConfig) -> Arc<ProxyState> {
        let config = GatewayConfig {
            providers: vec![ProviderConfig {
                id: ProviderId::new("openai"),
                upstream_url,
                capacity: Weight::from(4.0),
                models: vec![ModelConfig {
                    id: ModelId::new("gpt-4"),
                    weight: Weight::from(1.0),
                }],
                timeouts,
            }],
            bind: "0.0.0.0:0".parse().unwrap(),
            dashboard_bind: "0.0.0.0:0".parse().unwrap(),
        };
        let (tx, _rx) = broadcast::channel::<MetricUpdate>(64);
        let limiter = Arc::new(ProviderLimiter::new(tx));
        let config_store = Arc::new(ConfigStore::new(config, limiter.clone()));
        let upstream_client = Arc::new(UpstreamClient::new());
        Arc::new(ProxyState {
            config_store,
            limiter,
            tracker: Arc::new(RequestTracker::new()),
            upstream_client,
        })
    }

    async fn body_string(resp: Response) -> String {
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    fn assert_in_flight(lim: &ProviderLimiter, expected: f32) {
        let snap = lim.snapshot().into_iter().next().unwrap();
        assert!(
            (snap.in_flight - expected).abs() < 1e-6,
            "in_flight {} != {}",
            snap.in_flight,
            expected
        );
    }

    /// Spawn a mock upstream that captures the raw request line + headers + body
    /// via a oneshot channel, then replies with `response` bytes.
    fn spawn_mock(
        listener: TcpListener,
        response: &'static [u8],
    ) -> tokio::sync::oneshot::Receiver<String> {
        let (tx, rx) = tokio::sync::oneshot::channel::<String>();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 8192];
            let n = sock.read(&mut buf).await.unwrap();
            let captured = String::from_utf8_lossy(&buf[..n]).to_string();
            let _ = tx.send(captured);
            sock.write_all(response).await.unwrap();
            sock.flush().await.unwrap();
            tokio::time::sleep(Duration::from_millis(50)).await;
        });
        rx
    }

    #[tokio::test]
    async fn chat_completions_passthrough() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let rx = spawn_mock(
            listener,
            b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello",
        );

        let upstream_url = Url::parse(&format!("http://127.0.0.1:{port}")).unwrap();
        let state = make_state(upstream_url, TimeoutConfig::default());
        let app = proxy_router(state.clone());

        let expected_body = r#"{"model":"umans-kimi-k2.7","messages":[],"stream":true}"#;
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/openai/v1/chat/completions")
                    .header("authorization", "Bearer sk-test")
                    .header("content-type", "application/json")
                    .body(Body::from(expected_body))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_string(resp).await, "hello");

        let upstream_req = rx.await.unwrap();
        assert!(
            upstream_req.contains("POST /v1/chat/completions"),
            "upstream request line missing: {upstream_req}"
        );
        assert!(
            upstream_req.contains("authorization: Bearer sk-test"),
            "authorization header missing: {upstream_req}"
        );
        let upstream_body = upstream_req.split("\r\n\r\n").nth(1).unwrap_or("");
        assert_eq!(
            upstream_body, expected_body,
            "upstream body was not byte-identical: {upstream_req}"
        );

        assert_in_flight(&state.limiter, 0.0);
    }

    #[tokio::test]
    async fn messages_passthrough() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let rx = spawn_mock(
            listener,
            b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello",
        );

        let upstream_url = Url::parse(&format!("http://127.0.0.1:{port}")).unwrap();
        let state = make_state(upstream_url, TimeoutConfig::default());
        let app = proxy_router(state);

        let expected_body = r#"{"model":"claude-3","messages":[]}"#;
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/openai/v1/messages")
                    .header("content-type", "application/json")
                    .body(Body::from(expected_body))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_string(resp).await, "hello");

        let upstream_req = rx.await.unwrap();
        assert!(
            upstream_req.contains("POST /v1/messages"),
            "upstream request line missing: {upstream_req}"
        );
        let upstream_body = upstream_req.split("\r\n\r\n").nth(1).unwrap_or("");
        assert_eq!(
            upstream_body, expected_body,
            "upstream body was not byte-identical: {upstream_req}"
        );
    }

    #[tokio::test]
    async fn models_passthrough() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let rx = spawn_mock(
            listener,
            b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nmodels",
        );

        let upstream_url = Url::parse(&format!("http://127.0.0.1:{port}")).unwrap();
        let state = make_state(upstream_url, TimeoutConfig::default());
        let app = proxy_router(state);

        let resp = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/openai/v1/models")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_string(resp).await, "models");

        let upstream_req = rx.await.unwrap();
        assert!(
            upstream_req.contains("GET /v1/models"),
            "upstream request line missing: {upstream_req}"
        );
    }

    #[tokio::test]
    async fn unknown_path_passthrough() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let rx = spawn_mock(listener, b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");

        let upstream_url = Url::parse(&format!("http://127.0.0.1:{port}")).unwrap();
        let state = make_state(upstream_url, TimeoutConfig::default());
        let app = proxy_router(state);

        let expected_body = r#"{"model":"anything"}"#;
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/openai/v1/foo/bar")
                    .header("content-type", "application/json")
                    .body(Body::from(expected_body))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_string(resp).await, "ok");

        let upstream_req = rx.await.unwrap();
        assert!(
            upstream_req.contains("POST /v1/foo/bar"),
            "upstream request line missing: {upstream_req}"
        );
        let upstream_body = upstream_req.split("\r\n\r\n").nth(1).unwrap_or("");
        assert_eq!(
            upstream_body, expected_body,
            "upstream body was not byte-identical: {upstream_req}"
        );
    }

    #[tokio::test]
    async fn permit_acquired_during_request_and_released_after() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let rx = spawn_mock(
            listener,
            b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello",
        );

        let upstream_url = Url::parse(&format!("http://127.0.0.1:{port}")).unwrap();
        let state = make_state(upstream_url, TimeoutConfig::default());
        let app = proxy_router(state.clone());

        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/openai/v1/chat/completions")
                    .body(Body::from(r#"{"model":"gpt-4"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::OK);
        assert_in_flight(&state.limiter, 1.0);

        let _ = resp.into_body().collect().await;

        assert_in_flight(&state.limiter, 0.0);

        let upstream_req = rx.await.unwrap();
        assert!(
            upstream_req.contains("POST /v1/chat/completions"),
            "upstream request line missing: {upstream_req}"
        );
    }

    #[test]
    fn stream_flag_detection() {
        assert!(detect_stream(br#"{"stream":true}"#));
        assert!(!detect_stream(br#"{"stream":false}"#));
        assert!(!detect_stream(br#"{"model":"gpt-4"}"#));
        assert!(!detect_stream(br#"not json at all"#));
        assert!(!detect_stream(br#"{"stream":"yes"}"#));
    }

    #[tokio::test]
    async fn invalid_json_body_still_forwards() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let rx = spawn_mock(listener, b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");

        let upstream_url = Url::parse(&format!("http://127.0.0.1:{port}")).unwrap();
        let state = make_state(upstream_url, TimeoutConfig::default());

        let expected_body = "not json";
        let req = Request::builder()
            .method("POST")
            .uri("/openai/v1/chat/completions")
            .body(Body::from(expected_body))
            .unwrap();
        let resp = proxy_handler(
            Path("openai/v1/chat/completions".to_string()),
            State(state),
            req,
        )
        .await
        .unwrap();

        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_string(resp).await, "ok");

        let upstream_req = rx.await.unwrap();
        assert!(
            upstream_req.contains("POST /v1/chat/completions"),
            "upstream request line missing: {upstream_req}"
        );
        let upstream_body = upstream_req.split("\r\n\r\n").nth(1).unwrap_or("");
        assert_eq!(
            upstream_body, expected_body,
            "non-JSON body should forward byte-identical: {upstream_req}"
        );
    }

    // --- TDD RED phase: prefix-based provider routing & v1 normalization ---
    //
    // These tests drive the implementation of prefix extraction (strip the
    // provider id from the path) and /v1/ normalization (prepend `v1/` when
    // absent, never duplicate it).  They are expected to FAIL until the
    // routing logic is implemented (Task 5).

    /// Extract the HTTP status from a `proxy_handler` result, converting
    /// `GatewayError` via `IntoResponse` so 404 tests work both when the
    /// handler returns `Ok` (RED: 200 from upstream) and `Err` (GREEN: 404).
    fn handler_status(result: Result<Response>) -> StatusCode {
        match result {
            Ok(resp) => resp.status(),
            Err(err) => err.into_response().status(),
        }
    }

    #[tokio::test]
    async fn prefix_extraction() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let rx = spawn_mock(listener, b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");

        let upstream_url = Url::parse(&format!("http://127.0.0.1:{port}")).unwrap();
        let state = make_state_with_provider("umans", upstream_url, TimeoutConfig::default());

        let req = Request::builder()
            .method("POST")
            .uri("/umans/v1/chat/completions")
            .body(Body::from(r#"{"model":"test-model"}"#))
            .unwrap();
        let resp = proxy_handler(
            Path("umans/v1/chat/completions".to_string()),
            State(state),
            req,
        )
        .await
        .unwrap();

        assert_eq!(resp.status(), StatusCode::OK);

        let upstream_req = rx.await.unwrap();
        assert!(
            upstream_req.contains("POST /v1/chat/completions"),
            "prefix should be stripped — expected POST /v1/chat/completions, got: {upstream_req}"
        );
        assert!(
            !upstream_req.contains("umans/"),
            "provider prefix leaked into upstream path: {upstream_req}"
        );
    }

    #[tokio::test]
    async fn v1_already_present_no_double_v1() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let rx = spawn_mock(listener, b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");

        let upstream_url = Url::parse(&format!("http://127.0.0.1:{port}")).unwrap();
        let state = make_state_with_provider("umans", upstream_url, TimeoutConfig::default());

        let req = Request::builder()
            .method("POST")
            .uri("/umans/v1/chat/completions")
            .body(Body::from(r#"{"model":"test-model"}"#))
            .unwrap();
        let resp = proxy_handler(
            Path("umans/v1/chat/completions".to_string()),
            State(state),
            req,
        )
        .await
        .unwrap();

        assert_eq!(resp.status(), StatusCode::OK);

        let upstream_req = rx.await.unwrap();
        assert!(
            upstream_req.contains("POST /v1/chat/completions"),
            "expected POST /v1/chat/completions, got: {upstream_req}"
        );
        assert!(
            !upstream_req.contains("v1/v1"),
            "double v1 detected — must not prepend v1 when already present: {upstream_req}"
        );
    }

    #[tokio::test]
    async fn v1_missing_prepended() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let rx = spawn_mock(listener, b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");

        let upstream_url = Url::parse(&format!("http://127.0.0.1:{port}")).unwrap();
        let state = make_state_with_provider("umans", upstream_url, TimeoutConfig::default());

        let req = Request::builder()
            .method("POST")
            .uri("/umans/chat/completions")
            .body(Body::from(r#"{"model":"test-model"}"#))
            .unwrap();
        let resp = proxy_handler(
            Path("umans/chat/completions".to_string()),
            State(state),
            req,
        )
        .await
        .unwrap();

        assert_eq!(resp.status(), StatusCode::OK);

        let upstream_req = rx.await.unwrap();
        assert!(
            upstream_req.contains("POST /v1/chat/completions"),
            "v1 should be prepended — expected POST /v1/chat/completions, got: {upstream_req}"
        );
    }

    #[tokio::test]
    async fn v1_edge_case_path_equals_v1() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let rx = spawn_mock(listener, b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");

        let upstream_url = Url::parse(&format!("http://127.0.0.1:{port}")).unwrap();
        let state = make_state_with_provider("umans", upstream_url, TimeoutConfig::default());

        let req = Request::builder()
            .method("POST")
            .uri("/umans/v1")
            .body(Body::from(r#"{"model":"test-model"}"#))
            .unwrap();
        let resp = proxy_handler(Path("umans/v1".to_string()), State(state), req)
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::OK);

        let upstream_req = rx.await.unwrap();
        assert!(
            upstream_req.contains("POST /v1 HTTP"),
            "expected POST /v1, got: {upstream_req}"
        );
        assert!(
            !upstream_req.contains("v1/v1"),
            "double v1 detected for path==v1: {upstream_req}"
        );
    }

    #[tokio::test]
    async fn unknown_provider_returns_404() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let _rx = spawn_mock(listener, b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");

        let upstream_url = Url::parse(&format!("http://127.0.0.1:{port}")).unwrap();
        let state = make_state_with_provider("umans", upstream_url, TimeoutConfig::default());

        let req = Request::builder()
            .method("GET")
            .uri("/unknown/v1/models")
            .body(Body::empty())
            .unwrap();
        let status = handler_status(
            proxy_handler(
                Path("unknown/v1/models".to_string()),
                State(state),
                req,
            )
            .await,
        );

        assert_eq!(
            status,
            StatusCode::NOT_FOUND,
            "unknown provider prefix should return 404"
        );
    }

    #[tokio::test]
    async fn no_prefix_returns_404() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let _rx = spawn_mock(listener, b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");

        let upstream_url = Url::parse(&format!("http://127.0.0.1:{port}")).unwrap();
        let state = make_state_with_provider("umans", upstream_url, TimeoutConfig::default());

        let req = Request::builder()
            .method("GET")
            .uri("/v1/models")
            .body(Body::empty())
            .unwrap();
        let status = handler_status(
            proxy_handler(Path("v1/models".to_string()), State(state), req).await,
        );

        assert_eq!(
            status,
            StatusCode::NOT_FOUND,
            "path without provider prefix should return 404"
        );
    }

    #[tokio::test]
    async fn empty_path_returns_404() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let _rx = spawn_mock(listener, b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");

        let upstream_url = Url::parse(&format!("http://127.0.0.1:{port}")).unwrap();
        let state = make_state_with_provider("umans", upstream_url, TimeoutConfig::default());

        let req = Request::builder()
            .method("GET")
            .uri("/")
            .body(Body::empty())
            .unwrap();
        let status = handler_status(
            proxy_handler(Path(String::new()), State(state), req).await,
        );

        assert_eq!(
            status,
            StatusCode::NOT_FOUND,
            "empty path should return 404"
        );
    }
}
