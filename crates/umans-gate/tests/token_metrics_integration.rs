#![cfg(feature = "hot-reload")]

//! End-to-end integration tests for token metrics extraction.
//!
//! Spawns the proxy with a mock upstream that returns SSE responses with
//! token usage data, then asserts the RequestTracker history record has
//! the expected token fields populated (prompt, completion, cached, tps).

use std::sync::Arc;
use std::time::Duration;

use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::server::conn::auto::Builder;
use hyper_util::service::TowerToHyperService;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::broadcast;
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
// Helpers (mirror integration_passthrough.rs and dashboard_tracking.rs)
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

/// Build a ProxyState with one provider pointing at the mock upstream.
/// Returns (state, tracker_clone) so tests can inspect the tracker directly.
fn make_state(
    upstream_url: Url,
    provider_id: &str,
    model_id: &str,
) -> (Arc<ProxyState>, Arc<RequestTracker>) {
    let config = GatewayConfig {
        providers: vec![ProviderConfig {
            id: ProviderId::new(provider_id),
            upstream_url,
            capacity: Weight::from(1.0),
            models: vec![ModelConfig {
                id: ModelId::new(model_id),
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
    let tracker = Arc::new(RequestTracker::new());
    let state = Arc::new(ProxyState {
        config_store,
        limiter,
        tracker: Arc::clone(&tracker),
        upstream_client,
    });
    (state, tracker)
}

/// Spawn the proxy with a manual HTTP/1-only accept loop (mirrors serve.rs).
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

    tokio::time::sleep(Duration::from_millis(50)).await;
    (addr, token, handle)
}

/// Build an HTTP/1.1 chunked SSE response from a list of SSE event strings.
///
/// Each event string is sent as one chunk in the chunked transfer encoding.
fn build_chunked_sse_response(events: &[&str]) -> Vec<u8> {
    let mut response = Vec::new();
    response.extend_from_slice(b"HTTP/1.1 200 OK\r\n");
    response.extend_from_slice(b"Content-Type: text/event-stream\r\n");
    response.extend_from_slice(b"Transfer-Encoding: chunked\r\n");
    response.extend_from_slice(b"Cache-Control: no-cache\r\n");
    response.extend_from_slice(b"\r\n");
    for event in events {
        let chunk = event.as_bytes();
        response.extend_from_slice(format!("{:x}\r\n", chunk.len()).as_bytes());
        response.extend_from_slice(chunk);
        response.extend_from_slice(b"\r\n");
    }
    response.extend_from_slice(b"0\r\n\r\n");
    response
}

/// Spawn a mock upstream that accepts one connection, reads the request,
/// then writes the given response bytes and closes.
fn spawn_sse_mock(listener: TcpListener, response: Vec<u8>) {
    tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut buf = vec![0u8; 16384];
        let _ = sock.read(&mut buf).await;
        sock.write_all(&response).await.unwrap();
        sock.flush().await.unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
    });
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

/// Send an OpenAI-format streaming request through the proxy against a mock
/// upstream that returns SSE with content chunks and a final usage chunk
/// (including `prompt_tokens_details.cached_tokens`). Assert the history record
/// has prompt_tokens, completion_tokens, cached_tokens, and tps all populated.
#[tokio::test]
async fn integration_openai_token_metrics_populated() {
    let mock_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mock_port = mock_listener.local_addr().unwrap().port();
    let upstream_url = Url::parse(&format!("http://127.0.0.1:{mock_port}")).unwrap();

    let sse_events: &[&str] = &[
        "data: {\"id\":\"chatcmpl-1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"},\"finish_reason\":null}]}\n\n",
        "data: {\"id\":\"chatcmpl-1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hello\"},\"finish_reason\":null}]}\n\n",
        "data: {\"id\":\"chatcmpl-1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":18,\"completion_tokens\":50,\"prompt_tokens_details\":{\"cached_tokens\":7}}}\n\n",
        "data: [DONE]\n\n",
    ];
    let response = build_chunked_sse_response(sse_events);
    spawn_sse_mock(mock_listener, response);

    let (state, tracker) = make_state(upstream_url, "umans", "umans-kimi-k2.7");
    let (proxy_addr, token, server_handle) = spawn_proxy(state).await;

    let client = http1_client();
    let url = format!("http://{proxy_addr}/umans/v1/chat/completions");
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
    // Fully consume the response to trigger clean upstream EOS.
    let _ = resp.text().await.unwrap();

    // Wait for permit drop and history migration.
    tokio::time::sleep(Duration::from_millis(100)).await;

    let history = tracker.history();
    assert!(
        !history.is_empty(),
        "history should have at least one record"
    );
    let record = &history[0];
    assert_eq!(
        record.prompt_tokens,
        Some(18),
        "prompt_tokens should be 18, got {:?}",
        record.prompt_tokens
    );
    assert_eq!(
        record.completion_tokens,
        Some(50),
        "completion_tokens should be 50, got {:?}",
        record.completion_tokens
    );
    assert_eq!(
        record.cached_tokens,
        Some(7),
        "cached_tokens should be 7, got {:?}",
        record.cached_tokens
    );
    assert!(
        record.tps.is_some(),
        "tps should be Some, got {:?}",
        record.tps
    );

    token.signal();
    let _ = tokio::time::timeout(Duration::from_secs(5), server_handle).await;
}

/// Send an Anthropic-format streaming request through the proxy against a mock
/// upstream that returns `event: message_start` with cache_creation_input_tokens
/// and cache_read_input_tokens, and `event: message_delta` with output_tokens.
/// Assert cached_tokens equals the combined value and completion_tokens is Some.
#[tokio::test]
async fn integration_anthropic_token_metrics_populated() {
    let mock_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mock_port = mock_listener.local_addr().unwrap().port();
    let upstream_url = Url::parse(&format!("http://127.0.0.1:{mock_port}")).unwrap();

    let sse_events: &[&str] = &[
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":12,\"cache_creation_input_tokens\":100,\"cache_read_input_tokens\":50,\"output_tokens\":0}}}\n\n",
        "event: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":3}}\n\n",
    ];
    let response = build_chunked_sse_response(sse_events);
    spawn_sse_mock(mock_listener, response);

    let (state, tracker) = make_state(upstream_url, "anthropic", "claude-3");
    let (proxy_addr, token, server_handle) = spawn_proxy(state).await;

    let client = http1_client();
    let url = format!("http://{proxy_addr}/anthropic/v1/messages");
    let body = r#"{"model":"claude-3","messages":[{"role":"user","content":"hi"}],"stream":true}"#;

    let resp = client
        .post(&url)
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status().as_u16(), 200u16);
    // Fully consume the response to trigger clean upstream EOS.
    let _ = resp.text().await.unwrap();

    // Wait for permit drop and history migration.
    tokio::time::sleep(Duration::from_millis(100)).await;

    let history = tracker.history();
    assert!(
        !history.is_empty(),
        "history should have at least one record"
    );
    let record = &history[0];
    assert_eq!(
        record.cached_tokens,
        Some(150),
        "cached_tokens should be 100 + 50 = 150, got {:?}",
        record.cached_tokens
    );
    assert!(
        record.completion_tokens.is_some(),
        "completion_tokens should be Some, got {:?}",
        record.completion_tokens
    );
    assert_eq!(
        record.completion_tokens,
        Some(3),
        "completion_tokens should be 3, got {:?}",
        record.completion_tokens
    );
    assert_eq!(
        record.prompt_tokens,
        Some(12),
        "prompt_tokens should be 12, got {:?}",
        record.prompt_tokens
    );

    token.signal();
    let _ = tokio::time::timeout(Duration::from_secs(5), server_handle).await;
}
