#![cfg(feature = "hot-reload")]

//! Catch-all proxy router: Axum routes every path to the upstream-aware
//! handler while keeping `/health` explicit.
//!
//! Routing only — the handler in [`super::handler`] loads config once per
//! request, acquires a weighted concurrency permit, and forwards upstream.

use std::sync::Arc;

use axum::routing::{any, get};
use axum::Router;

use crate::concurrency::ProviderLimiter;
use crate::config_store::ConfigStore;
use crate::proxy::upstream::UpstreamClient;

use super::handler::proxy_handler;

/// Shared state threaded through every proxy request.
///
/// `config_store` provides wait-free config reads (load once per request),
/// `limiter` is the per-provider weighted concurrency engine, and
/// `upstream_client` is the pooled HTTPS forwarder.
pub struct ProxyState {
    pub config_store: Arc<ConfigStore>,
    pub limiter: Arc<ProviderLimiter>,
    pub upstream_client: Arc<UpstreamClient>,
}

/// Build the proxy router with `/health` and the catch-all `/{*path}`.
///
/// `/health` is registered first so it does not fall through to the proxy
/// handler. State is consumed via `with_state`, so the returned router is
/// ready to serve.
pub fn proxy_router(state: Arc<ProxyState>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/{*path}", any(proxy_handler))
        .with_state(state)
}

async fn health() -> &'static str {
    "ok"
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::broadcast;
    use tokio::time::sleep;
    use tower::ServiceExt;
    use url::Url;

    use crate::concurrency::MetricUpdate;
    use crate::types::{
        GatewayConfig, ModelConfig, ModelId, ProviderConfig, ProviderId, TimeoutConfig, Weight,
    };

    fn full_config(upstream_url: Url) -> GatewayConfig {
        let mut cfg = GatewayConfig::default();
        cfg.providers.clear();
        cfg.providers.push(ProviderConfig {
            id: ProviderId::new("openai"),
            upstream_url,
            capacity: Weight::from(2.0),
            models: vec![ModelConfig {
                id: ModelId::new("claude-3"),
                weight: Weight::from(1.0),
            }],
            timeouts: TimeoutConfig::default(),
        });
        cfg
    }

    fn make_state(upstream_url: Url) -> Arc<ProxyState> {
        let (tx, _rx) = broadcast::channel::<MetricUpdate>(64);
        let limiter = Arc::new(ProviderLimiter::new(tx));
        let config_store = Arc::new(ConfigStore::new(full_config(upstream_url), limiter.clone()));
        let upstream_client = Arc::new(UpstreamClient::new());
        Arc::new(ProxyState {
            config_store,
            limiter,
            upstream_client,
        })
    }

    /// Spawn a mock upstream that accepts a single request and replies with `response`.
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
            sleep(Duration::from_millis(50)).await;
        });
        rx
    }

    async fn body_string(resp: axum::response::Response) -> String {
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    #[tokio::test]
    async fn health_returns_ok() {
        let app = proxy_router(make_state(Url::parse("http://127.0.0.1:1").unwrap()));
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_string(resp).await, "ok");
    }

    #[tokio::test]
    async fn catchall_routes_chat_completions() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let rx = spawn_mock(
            listener,
            b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello",
        );

        let upstream_url = Url::parse(&format!("http://127.0.0.1:{port}")).unwrap();
        let app = proxy_router(make_state(upstream_url));
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/openai/v1/chat/completions")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"model":"umans-kimi-k2.7","messages":[]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::OK,
            "catch-all should route /v1/chat/completions to the handler"
        );

        let upstream_req = rx.await.unwrap();
        assert!(
            upstream_req.contains("POST /v1/chat/completions"),
            "upstream request line missing: {upstream_req}"
        );
    }

    #[tokio::test]
    async fn catchall_routes_messages() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let rx = spawn_mock(
            listener,
            b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello",
        );

        let upstream_url = Url::parse(&format!("http://127.0.0.1:{port}")).unwrap();
        let app = proxy_router(make_state(upstream_url));
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/openai/v1/messages")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"model":"claude-3","messages":[]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::OK,
            "catch-all should route /v1/messages to the handler"
        );

        let upstream_req = rx.await.unwrap();
        assert!(
            upstream_req.contains("POST /v1/messages"),
            "upstream request line missing: {upstream_req}"
        );
    }

    #[tokio::test]
    async fn catchall_routes_unknown_path() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let rx = spawn_mock(
            listener,
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok",
        );

        let upstream_url = Url::parse(&format!("http://127.0.0.1:{port}")).unwrap();
        let app = proxy_router(make_state(upstream_url));
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/openai/v1/foo/bar")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"model":"anything"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::OK,
            "catch-all should route /v1/foo/bar to the handler"
        );

        let upstream_req = rx.await.unwrap();
        assert!(
            upstream_req.contains("POST /v1/foo/bar"),
            "upstream request line missing: {upstream_req}"
        );
    }
}
