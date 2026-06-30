#![cfg(feature = "hot-reload")]

//! Integration test: all Wave 2 passthrough/concurrency changes working together.
//!
//! Exercises the full HTTP path: reqwest client -> manual HTTP/1-only accept
//! loop -> axum proxy_router -> mock upstream on 127.0.0.1.

use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::server::conn::auto::Builder;
use hyper_util::service::TowerToHyperService;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, oneshot};
use tokio::task::{JoinHandle, JoinSet};
use umans_gate::concurrency::{MetricUpdate, ProviderLimiter};
use umans_gate::config_store::ConfigStore;
use umans_gate::dashboard::tracker::RequestTracker;
use umans_gate::proxy::router::{proxy_router, ProxyState};
use umans_gate::proxy::upstream::UpstreamClient;
use umans_gate::shutdown::{ShutdownSignal, ShutdownToken};
use umans_gate::types::{
    GatewayConfig, ModelConfig, ModelId, ProviderConfig, ProviderId, TimeoutConfig, Weight,
};
use url::Url;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn test_timeouts() -> TimeoutConfig {
    TimeoutConfig {
        connect: Some(Duration::from_secs(10)),
        ttfb: Some(Duration::from_secs(30)),
        stream_idle: Some(Duration::from_secs(60)),
        total: Some(Duration::from_secs(300)),
        queuetimeout: Duration::from_secs(1),
        maxqueue: 2,
        ..Default::default()
    }
}

/// Build a ProxyState with one provider ("umans", capacity=1) pointing at the
/// mock upstream.  ConfigStore::new registers the provider with the limiter.
fn make_state(upstream_url: Url) -> Arc<ProxyState> {
    let config = GatewayConfig {
        providers: vec![ProviderConfig {
            id: ProviderId::new("umans"),
            upstream_url,
            capacity: Weight::from(1.0),
            models: vec![ModelConfig {
                id: ModelId::new("umans-kimi-k2.7"),
                weight: Weight::from(1.0),
            }],
            timeouts: test_timeouts(),
        }],
        bind: "0.0.0.0:0".parse().unwrap(),
        dashboard_bind: "0.0.0.0:0".parse().unwrap(),
        dashboard: None,
        models_info_url: String::new(),
    };
    let (tx, _rx) = broadcast::channel::<MetricUpdate>(16);
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

/// Spawn the proxy with a manual HTTP/1-only accept loop (mirrors serve.rs).
///
/// Returns (proxy_addr, shutdown_token, server_join_handle).  Call
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

/// Spawn a mock upstream that captures the raw request (line + headers + body)
/// via a oneshot channel, then replies with `response`.
fn spawn_mock_capture(listener: TcpListener, response: &'static [u8]) -> oneshot::Receiver<String> {
    let (tx, rx) = oneshot::channel();
    tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut buf = vec![0u8; 16384];
        let n = sock.read(&mut buf).await.unwrap();
        let captured = String::from_utf8_lossy(&buf[..n]).to_string();
        let _ = tx.send(captured);
        sock.write_all(response).await.unwrap();
        sock.flush().await.unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
    });
    rx
}

/// Build an HTTP/1.1-only reqwest client with no connection pooling.
fn http1_client() -> reqwest::Client {
    reqwest::Client::builder()
        .http1_only()
        .pool_max_idle_per_host(0)
        .build()
        .unwrap()
}

/// Hop-by-hop headers defined in RFC 7230 §6.1.
const HOP_BY_HOP: &[&str] = &[
    "connection",
    "keep-alive",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
    "proxy-authenticate",
    "proxy-authorization",
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// 1 + 7. POST /v1/chat/completions: request line, Host, hop-by-hop stripped,
/// JSON body fields preserved with stream_options injected, HTTP/1.1 response version.
#[tokio::test]
async fn full_chat_passthrough() {
    let mock_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mock_port = mock_listener.local_addr().unwrap().port();
    let upstream_url = Url::parse(&format!("http://127.0.0.1:{mock_port}")).unwrap();

    let rx = spawn_mock_capture(
        mock_listener,
        b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello",
    );

    let state = make_state(upstream_url);
    let (proxy_addr, token, server_handle) = spawn_proxy(state).await;

    let client = http1_client();
    let url = format!("http://{proxy_addr}{}", "/umans/v1/chat/completions");
    let body =
        r#"{"model":"umans-kimi-k2.7","messages":[{"role":"user","content":"hi"}],"stream":true}"#;

    let resp = client
        .post(&url)
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status().as_u16(), 200u16);
    assert_eq!(resp.version(), reqwest::Version::HTTP_11);
    let resp_body = resp.text().await.unwrap();
    assert_eq!(resp_body, "hello");

    let upstream_req = rx.await.unwrap();

    // 1. Request line with HTTP/1.1.
    assert!(
        upstream_req.contains("POST /v1/chat/completions HTTP/1.1"),
        "upstream request line missing: {upstream_req}"
    );

    // 2. Host = mock host.
    let lower = upstream_req.to_ascii_lowercase();
    assert!(
        lower.contains(&format!("host: 127.0.0.1:{mock_port}")),
        "host header not set to mock host: {upstream_req}"
    );

    // 3. No hop-by-hop headers.
    for hop in HOP_BY_HOP {
        assert!(
            !lower.contains(&format!("{hop}:")),
            "hop-by-hop header '{hop}' should be stripped: {upstream_req}"
        );
    }

    // 4. Body is streaming JSON with injected stream_options; assert fields,
    // not byte identity, because serde_json::Value reorders keys.
    let upstream_body = upstream_req.split("\r\n\r\n").nth(1).unwrap_or("");
    let upstream_value: Value =
        serde_json::from_str(upstream_body).expect("upstream body should be valid JSON");
    assert_eq!(upstream_value["model"], "umans-kimi-k2.7");
    assert_eq!(
        upstream_value["messages"],
        json!([{"role": "user", "content": "hi"}])
    );
    assert_eq!(upstream_value["stream"], true);
    assert_eq!(
        upstream_value["stream_options"],
        json!({"include_usage": true})
    );

    token.signal();
    let _ = tokio::time::timeout(Duration::from_secs(5), server_handle).await;
}

/// 2. POST /v1/messages: request line with HTTP/1.1.
#[tokio::test]
async fn full_messages_passthrough() {
    let mock_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mock_port = mock_listener.local_addr().unwrap().port();
    let upstream_url = Url::parse(&format!("http://127.0.0.1:{mock_port}")).unwrap();

    let rx = spawn_mock_capture(
        mock_listener,
        b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello",
    );

    let state = make_state(upstream_url);
    let (proxy_addr, token, server_handle) = spawn_proxy(state).await;

    let client = http1_client();
    let url = format!("http://{proxy_addr}{}", "/umans/v1/messages");
    let body = r#"{"model":"claude-3","messages":[{"role":"user","content":"hi"}]}"#;

    let resp = client
        .post(&url)
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status().as_u16(), 200u16);
    let resp_body = resp.text().await.unwrap();
    assert_eq!(resp_body, "hello");

    let upstream_req = rx.await.unwrap();
    assert!(
        upstream_req.contains("POST /v1/messages HTTP/1.1"),
        "upstream request line missing: {upstream_req}"
    );

    token.signal();
    let _ = tokio::time::timeout(Duration::from_secs(5), server_handle).await;
}

/// 3. GET /health -> 200 "ok" (catch-all didn't swallow).
#[tokio::test]
async fn health_check() {
    let mock_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mock_port = mock_listener.local_addr().unwrap().port();
    let upstream_url = Url::parse(&format!("http://127.0.0.1:{mock_port}")).unwrap();
    // No mock handler needed — /health is served directly by the router.
    drop(mock_listener);

    let state = make_state(upstream_url);
    let (proxy_addr, token, server_handle) = spawn_proxy(state).await;

    let client = http1_client();
    let url = format!("http://{proxy_addr}/health");
    let resp = client.get(&url).send().await.unwrap();

    assert_eq!(resp.status().as_u16(), 200u16);
    let body = resp.text().await.unwrap();
    assert_eq!(body, "ok");

    token.signal();
    let _ = tokio::time::timeout(Duration::from_secs(5), server_handle).await;
}

/// 4. SSE streaming: mock sends chunked response -> client receives chunks
///    incrementally (not buffered).
#[tokio::test]
async fn sse_streaming() {
    let mock_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mock_port = mock_listener.local_addr().unwrap().port();
    let upstream_url = Url::parse(&format!("http://127.0.0.1:{mock_port}")).unwrap();

    // Mock: send chunked SSE response with delays between chunks.
    tokio::spawn(async move {
        let (mut sock, _) = mock_listener.accept().await.unwrap();
        let mut buf = vec![0u8; 8192];
        let _ = sock.read(&mut buf).await.unwrap();

        // Headers + first chunk.
        sock.write_all(
            b"HTTP/1.1 200 OK\r\n\
             Content-Type: text/event-stream\r\n\
             Transfer-Encoding: chunked\r\n\
             Cache-Control: no-cache\r\n\
             \r\n\
             9\r\ndata: 1\n\n\r\n",
        )
        .await
        .unwrap();
        sock.flush().await.unwrap();

        tokio::time::sleep(Duration::from_millis(150)).await;

        sock.write_all(b"9\r\ndata: 2\n\n\r\n").await.unwrap();
        sock.flush().await.unwrap();

        tokio::time::sleep(Duration::from_millis(150)).await;

        sock.write_all(b"9\r\ndata: 3\n\n\r\n").await.unwrap();
        sock.write_all(b"0\r\n\r\n").await.unwrap();
        sock.flush().await.unwrap();

        tokio::time::sleep(Duration::from_millis(50)).await;
    });

    let state = make_state(upstream_url);
    let (proxy_addr, token, server_handle) = spawn_proxy(state).await;

    let client = http1_client();
    let url = format!("http://{proxy_addr}{}", "/umans/v1/chat/completions");
    let body =
        r#"{"model":"umans-kimi-k2.7","messages":[{"role":"user","content":"hi"}],"stream":true}"#;

    let resp = client
        .post(&url)
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status().as_u16(), 200u16);
    assert_eq!(
        resp.headers()
            .get("content-type")
            .map(|v| v.to_str().unwrap()),
        Some("text/event-stream")
    );

    let mut stream = resp.bytes_stream();
    let mut chunks = Vec::new();
    while let Some(chunk) = stream.next().await {
        chunks.push(chunk.unwrap());
    }

    assert!(
        chunks.len() >= 3,
        "expected at least 3 separate stream items, got {}",
        chunks.len()
    );

    let all: Vec<u8> = chunks.iter().flat_map(|c| c.iter().copied()).collect();
    let text = String::from_utf8_lossy(&all);
    assert!(text.contains("data: 1"), "missing chunk 1: {text}");
    assert!(text.contains("data: 2"), "missing chunk 2: {text}");
    assert!(text.contains("data: 3"), "missing chunk 3: {text}");

    token.signal();
    let _ = tokio::time::timeout(Duration::from_secs(5), server_handle).await;
}

/// 5. Queue timeout: capacity=1, 2 concurrent requests, 2nd gets 503 within 1.5s.
#[tokio::test]
async fn queue_timeout() {
    let mock_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mock_port = mock_listener.local_addr().unwrap().port();
    let upstream_url = Url::parse(&format!("http://127.0.0.1:{mock_port}")).unwrap();

    // Mock: accept, read request, signal, sleep 5s, respond (ignore write errors).
    let (signal_tx, signal_rx) = oneshot::channel();
    tokio::spawn(async move {
        let (mut sock, _) = mock_listener.accept().await.unwrap();
        let mut buf = vec![0u8; 8192];
        let _ = sock.read(&mut buf).await.unwrap();
        let _ = signal_tx.send(());
        tokio::time::sleep(Duration::from_secs(5)).await;
        // Ignore write errors — proxy may have closed the connection during shutdown.
        let _ = sock
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
            .await;
        let _ = sock.flush().await;
        tokio::time::sleep(Duration::from_millis(50)).await;
    });

    let state = make_state(upstream_url);
    let (proxy_addr, token, server_handle) = spawn_proxy(state).await;

    let client = http1_client();
    let url = format!("http://{proxy_addr}{}", "/umans/v1/chat/completions");
    let body = r#"{"model":"umans-kimi-k2.7","messages":[{"role":"user","content":"hi"}]}"#;

    // Send Request A (spawned, don't wait for response).
    let client_a = client.clone();
    let url_a = url.clone();
    let body_a = body.to_string();
    tokio::spawn(async move {
        let _ = client_a
            .post(&url_a)
            .header("content-type", "application/json")
            .body(body_a)
            .send()
            .await;
    });

    // Wait for mock to receive Request A (permit is now held).
    signal_rx.await.unwrap();

    // Send Request B — should get 503 within 1.5s.
    let start = std::time::Instant::now();
    let resp_b = tokio::time::timeout(
        Duration::from_millis(1500),
        client
            .post(&url)
            .header("content-type", "application/json")
            .body(body.to_string())
            .send(),
    )
    .await;
    let elapsed = start.elapsed();

    assert!(
        elapsed < Duration::from_millis(1500),
        "Request B took too long: {elapsed:?}"
    );

    let resp = resp_b
        .expect("Request B should return within 1.5s")
        .expect("Request B send should succeed");
    assert_eq!(resp.status().as_u16(), 503u16);

    let body_text = resp.text().await.unwrap();
    assert!(
        body_text.contains("concurrency_limit"),
        "expected concurrency_limit in body: {body_text}"
    );

    token.signal();
    let _ = tokio::time::timeout(Duration::from_secs(10), server_handle).await;
}

/// 6. HTTP/1.1: assert response protocol is HTTP/1.1.
#[tokio::test]
async fn http1_version() {
    let mock_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mock_port = mock_listener.local_addr().unwrap().port();
    let upstream_url = Url::parse(&format!("http://127.0.0.1:{mock_port}")).unwrap();

    let _rx = spawn_mock_capture(
        mock_listener,
        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok",
    );

    let state = make_state(upstream_url);
    let (proxy_addr, token, server_handle) = spawn_proxy(state).await;

    let client = http1_client();
    let url = format!("http://{proxy_addr}{}", "/umans/v1/models");
    let resp = client.get(&url).send().await.unwrap();

    assert_eq!(resp.version(), reqwest::Version::HTTP_11);

    token.signal();
    let _ = tokio::time::timeout(Duration::from_secs(5), server_handle).await;
}
