#![cfg(feature = "hot-reload")]

//! Integration tests for the per-request tracking layer.
//!
//! Exercises the production proxy path end-to-end: reqwest client -> axum
//! proxy_router -> mock upstream on 127.0.0.1. Asserts the RequestTracker
//! lifecycle (Queued -> Running -> Done), concurrent safety, pruning,
//! rejection tracking, UUID v4 format, and panic safety of TrackedPermit::Drop.

use std::sync::Arc;
use std::time::Duration;

use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::server::conn::auto::Builder;
use hyper_util::service::TowerToHyperService;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, oneshot, Barrier};
use tokio::task::{JoinHandle, JoinSet};
use umans_gate::concurrency::{MetricUpdate, ProviderLimiter};
use umans_gate::config_store::ConfigStore;
use umans_gate::dashboard::tracker::{ProtocolVersion, RequestStatus, RequestTracker};
use umans_gate::proxy::gating::acquire_for_request;
use umans_gate::proxy::router::{proxy_router, ProxyState};
use umans_gate::proxy::upstream::UpstreamClient;
use umans_gate::shutdown::{ShutdownSignal, ShutdownToken};
use umans_gate::types::{
    GatewayConfig, ModelConfig, ModelId, ProviderConfig, ProviderId, TimeoutConfig, Weight,
};
use url::Url;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Helpers (mirror integration_passthrough.rs patterns)
// ---------------------------------------------------------------------------

fn test_timeouts(maxqueue: usize) -> TimeoutConfig {
    TimeoutConfig {
        connect: Some(Duration::from_secs(10)),
        ttfb: Some(Duration::from_secs(30)),
        stream_idle: Some(Duration::from_secs(60)),
        total: Some(Duration::from_secs(300)),
        queuetimeout: Duration::from_secs(30),
        maxqueue,
        ..Default::default()
    }
}

/// Build a ProxyState with one provider ("umans") pointing at the mock upstream.
/// Returns (state, tracker_clone) so tests can inspect the tracker directly.
fn make_state(
    upstream_url: Url,
    capacity: f32,
    maxqueue: usize,
) -> (Arc<ProxyState>, Arc<RequestTracker>) {
    let config = GatewayConfig {
        providers: vec![ProviderConfig {
            id: ProviderId::new("umans"),
            upstream_url,
            capacity: Weight::from(capacity),
            models: vec![ModelConfig {
                id: ModelId::new("umans-kimi-k2.7"),
                weight: Weight::from(1.0),
            }],
            timeouts: test_timeouts(maxqueue),
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

fn http1_client() -> reqwest::Client {
    reqwest::Client::builder()
        .http1_only()
        .pool_max_idle_per_host(0)
        .build()
        .unwrap()
}

/// Spawn a background prune task (mirrors serve.rs pattern). Uses a 2s interval
/// for test speed instead of the production 5s.
fn spawn_prune_task(tracker: Arc<RequestTracker>, interval: Duration) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(interval).await;
            tracker.prune_stale(interval);
        }
    })
}

/// Spawn a mock upstream that accepts one connection, reads the request,
/// waits for the release signal, then responds.
fn spawn_signal_mock(
    listener: TcpListener,
    release_rx: oneshot::Receiver<()>,
    response: &'static [u8],
) {
    tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut buf = vec![0u8; 8192];
        let _ = sock.read(&mut buf).await;
        let _ = release_rx.await;
        let _ = sock.write_all(response).await;
        let _ = sock.flush().await;
        tokio::time::sleep(Duration::from_millis(50)).await;
    });
}

/// Spawn a mock upstream that accepts connections in a loop, reads each
/// request, delays `delay`, then responds. Each connection is handled in its
/// own task so multiple connections can be served concurrently.
fn spawn_delayed_mock(listener: TcpListener, delay: Duration, response: &'static [u8]) {
    tokio::spawn(async move {
        loop {
            let (mut sock, _) = match listener.accept().await {
                Ok(v) => v,
                Err(_) => break,
            };
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let _ = sock.read(&mut buf).await;
                tokio::time::sleep(delay).await;
                let _ = sock.write_all(response).await;
                let _ = sock.flush().await;
            });
        }
    });
}

const OK_RESPONSE: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok";
const REQUEST_BODY: &str = r#"{"model":"umans-kimi-k2.7","messages":[]}"#;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// AC1 GATE TEST: send a proxied request through the production router/gating
/// path and assert the tracker shows it transitioning Queued -> Running -> Done.
///
/// Uses a pre-acquired permit to block capacity so the request enters Queued,
/// then releases it to observe Running, then completes the upstream to observe
/// Done.
#[tokio::test]
async fn production_path_lifecycle() {
    let mock_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mock_port = mock_listener.local_addr().unwrap().port();
    let upstream_url = Url::parse(&format!("http://127.0.0.1:{mock_port}")).unwrap();

    let (release_tx, release_rx) = oneshot::channel::<()>();
    spawn_signal_mock(mock_listener, release_rx, OK_RESPONSE);

    // capacity=1 so a single pre-acquired permit blocks all incoming requests.
    let (state, tracker) = make_state(upstream_url, 1.0, 64);

    // Pre-acquire a permit directly from the limiter to block capacity.
    // This is NOT tracked by the tracker (no acquire_for_request call).
    let blocking_permit = state
        .limiter
        .acquire(
            &ProviderId::new("umans"),
            &ModelId::new("umans-kimi-k2.7"),
            Weight::from(1.0),
        )
        .await
        .expect("pre-acquire should succeed");

    let (proxy_addr, token, server_handle) = spawn_proxy(state).await;

    let client = http1_client();
    let url = format!("http://{proxy_addr}/umans/v1/chat/completions");

    let client_clone = client.clone();
    let url_clone = url.clone();
    let body = REQUEST_BODY.to_string();
    let resp_handle = tokio::spawn(async move {
        client_clone
            .post(&url_clone)
            .header("content-type", "application/json")
            .body(body)
            .send()
            .await
    });

    // Wait for the request to register in the tracker (Queued).
    tokio::time::sleep(Duration::from_millis(100)).await;

    let snap = tracker.snapshot();
    assert_eq!(snap.len(), 1, "should have 1 tracked request");
    assert_eq!(
        snap[0].status,
        RequestStatus::Queued,
        "request should be Queued while capacity is blocked"
    );
    let request_id = snap[0].id;

    // Release capacity — request should transition to Running.
    drop(blocking_permit);
    tokio::time::sleep(Duration::from_millis(100)).await;

    let snap = tracker.snapshot();
    let req = snap
        .iter()
        .find(|r| r.id == request_id)
        .expect("request should exist after capacity release");
    assert_eq!(
        req.status,
        RequestStatus::Running,
        "request should be Running after capacity is released"
    );

    // Signal mock to respond — request should transition to Done.
    let _ = release_tx.send(());
    let resp = resp_handle
        .await
        .expect("resp task should not panic")
        .expect("request should succeed");
    assert_eq!(resp.status(), reqwest::StatusCode::OK);
    let _ = resp.text().await;

    // Give TrackedPermit::Drop a moment to fire after body consumption.
    tokio::time::sleep(Duration::from_millis(50)).await;

    let snap = tracker.snapshot();
    let req = snap
        .iter()
        .find(|r| r.id == request_id)
        .expect("request should exist after completion");
    assert_eq!(
        req.status,
        RequestStatus::Done,
        "request should be Done after response completes"
    );

    token.signal();
    let _ = tokio::time::timeout(Duration::from_secs(5), server_handle).await;
}

/// Spawn 100 concurrent proxied requests with a tiny weight, assert the tracker
/// snapshot has exactly 100 entries at peak, no duplicates, no races.
#[tokio::test]
async fn concurrent_safety() {
    let mock_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mock_port = mock_listener.local_addr().unwrap().port();
    let upstream_url = Url::parse(&format!("http://127.0.0.1:{mock_port}")).unwrap();

    // Mock: 500ms delay so all 100 requests are in-flight simultaneously.
    spawn_delayed_mock(mock_listener, Duration::from_millis(500), OK_RESPONSE);

    // capacity=100, weight=1 -> 100 requests fit exactly.
    let (state, tracker) = make_state(upstream_url, 100.0, 64);
    let (proxy_addr, token, server_handle) = spawn_proxy(state).await;

    let client = http1_client();
    let url = format!("http://{proxy_addr}/umans/v1/chat/completions");

    let total = 100usize;
    let barrier = Arc::new(Barrier::new(total));
    let mut handles = Vec::with_capacity(total);

    for _ in 0..total {
        let barrier = Arc::clone(&barrier);
        let client = client.clone();
        let url = url.clone();
        handles.push(tokio::spawn(async move {
            barrier.wait().await;
            client
                .post(&url)
                .header("content-type", "application/json")
                .body(REQUEST_BODY.to_string())
                .send()
                .await
        }));
    }

    // Wait for all requests to be in-flight.
    tokio::time::sleep(Duration::from_millis(300)).await;

    let snap = tracker.snapshot();
    assert_eq!(
        snap.len(),
        total,
        "expected {} entries at peak, got {}",
        total,
        snap.len()
    );

    // No duplicate IDs.
    let mut ids: Vec<Uuid> = snap.iter().map(|r| r.id).collect();
    ids.sort();
    let original_len = ids.len();
    ids.dedup();
    assert_eq!(ids.len(), original_len, "found duplicate UUIDs after dedup");

    // All should be Running.
    let running = snap
        .iter()
        .filter(|r| r.status == RequestStatus::Running)
        .count();
    assert_eq!(
        running, total,
        "all {} entries should be Running, got {} Running",
        total, running
    );

    // Wait for all to complete.
    for handle in handles {
        let resp = handle
            .await
            .expect("task should not panic")
            .expect("request should succeed");
        assert_eq!(resp.status(), reqwest::StatusCode::OK);
    }

    token.signal();
    let _ = tokio::time::timeout(Duration::from_secs(10), server_handle).await;
}

/// Trigger a request, wait for completion, sleep 6 seconds, assert the request
/// ID is gone from the snapshot (prune_stale ran).
#[tokio::test]
async fn pruning() {
    let mock_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mock_port = mock_listener.local_addr().unwrap().port();
    let upstream_url = Url::parse(&format!("http://127.0.0.1:{mock_port}")).unwrap();

    spawn_delayed_mock(mock_listener, Duration::from_millis(10), OK_RESPONSE);

    let (state, tracker) = make_state(upstream_url, 1.0, 64);
    let (proxy_addr, token, server_handle) = spawn_proxy(state).await;

    let client = http1_client();
    let url = format!("http://{proxy_addr}/umans/v1/chat/completions");

    let resp = client
        .post(&url)
        .header("content-type", "application/json")
        .body(REQUEST_BODY.to_string())
        .send()
        .await
        .expect("request should succeed");
    assert_eq!(resp.status(), reqwest::StatusCode::OK);
    let _ = resp.text().await;

    // Wait for Done transition.
    tokio::time::sleep(Duration::from_millis(50)).await;

    let snap = tracker.snapshot();
    assert_eq!(snap.len(), 1, "should have 1 entry after completion");
    assert_eq!(snap[0].status, RequestStatus::Done);
    let request_id = snap[0].id;

    // Spawn prune task with 2s interval (faster than production 5s for test
    // speed). At t=2s the entry is ~2s old (borderline); at t=4s it is
    // definitely older than 2s and will be pruned.
    let _prune_handle = spawn_prune_task(Arc::clone(&tracker), Duration::from_secs(2));

    // Sleep 6 seconds — prune has run at t=2s and t=4s.
    tokio::time::sleep(Duration::from_secs(6)).await;

    let snap = tracker.snapshot();
    assert!(
        snap.iter().all(|r| r.id != request_id),
        "request {} should have been pruned after 6s",
        request_id
    );

    token.signal();
    let _ = tokio::time::timeout(Duration::from_secs(5), server_handle).await;
}

/// Exhaust maxqueue (set queue depth to 1), send an extra request, assert it
/// appears with status Rejected in the tracker, then wait 5s and assert pruned.
#[tokio::test]
async fn rejected_tracking() {
    let mock_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mock_port = mock_listener.local_addr().unwrap().port();
    let upstream_url = Url::parse(&format!("http://127.0.0.1:{mock_port}")).unwrap();

    // Mock: 2s delay so request A holds capacity while B queues and C is sent.
    spawn_delayed_mock(mock_listener, Duration::from_secs(2), OK_RESPONSE);

    // capacity=1, maxqueue=1 -> one in-flight, one queued, third is rejected.
    let (state, tracker) = make_state(upstream_url, 1.0, 1);
    let (proxy_addr, token, server_handle) = spawn_proxy(state).await;

    let client = http1_client();
    let url = format!("http://{proxy_addr}/umans/v1/chat/completions");

    // Request A: acquires the permit, holds it (slow upstream).
    let client_a = client.clone();
    let url_a = url.clone();
    tokio::spawn(async move {
        let _ = client_a
            .post(&url_a)
            .header("content-type", "application/json")
            .body(REQUEST_BODY.to_string())
            .send()
            .await;
    });

    // Wait for A to be in-flight.
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Request B: queues (maxqueue=1 allows 1 in queue).
    let client_b = client.clone();
    let url_b = url.clone();
    tokio::spawn(async move {
        let _ = client_b
            .post(&url_b)
            .header("content-type", "application/json")
            .body(REQUEST_BODY.to_string())
            .send()
            .await;
    });

    // Wait for B to queue.
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Request C: should be immediately rejected (maxqueue exceeded).
    let start = std::time::Instant::now();
    let resp_c = client
        .post(&url)
        .header("content-type", "application/json")
        .body(REQUEST_BODY.to_string())
        .send()
        .await
        .expect("request should succeed");
    let elapsed = start.elapsed();

    assert_eq!(
        resp_c.status(),
        reqwest::StatusCode::SERVICE_UNAVAILABLE,
        "request C should get 503"
    );
    assert!(
        elapsed < Duration::from_millis(500),
        "rejection should be fast, took {:?}",
        elapsed
    );

    // Assert tracker has a Rejected entry.
    let snap = tracker.snapshot();
    let rejected: Vec<_> = snap
        .iter()
        .filter(|r| r.status == RequestStatus::Rejected)
        .collect();
    assert!(
        !rejected.is_empty(),
        "at least one request should be Rejected in the tracker"
    );
    let rejected_id = rejected[0].id;

    // Spawn prune task and wait for pruning.
    let _prune_handle = spawn_prune_task(Arc::clone(&tracker), Duration::from_secs(2));
    tokio::time::sleep(Duration::from_secs(5)).await;

    let snap = tracker.snapshot();
    assert!(
        snap.iter().all(|r| r.id != rejected_id),
        "rejected request should have been pruned after 5s"
    );

    token.signal();
    let _ = tokio::time::timeout(Duration::from_secs(10), server_handle).await;
}

/// Generate 1000 IDs and assert they all match UUID v4 format:
/// ^[0-9a-f]{8}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$
#[test]
fn uuid_v4_format() {
    /// Validate that a string matches the RFC 4122 v4 layout:
    /// `xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx` (lowercase hex).
    fn is_valid_v4(s: &str) -> bool {
        let parts: Vec<&str> = s.split('-').collect();
        parts.len() == 5
            && parts[0].len() == 8
            && parts[1].len() == 4
            && parts[2].len() == 4
            && parts[3].len() == 4
            && parts[4].len() == 12
            && parts[2].starts_with('4')
            && parts[3].chars().next().is_some_and(|c| "89ab".contains(c))
            && parts.iter().all(|p| {
                p.chars()
                    .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
            })
    }

    for _ in 0..1000 {
        let id = Uuid::new_v4();
        let s = id.to_string();
        assert!(
            is_valid_v4(&s),
            "UUID {} does not match RFC 4122 v4 format",
            s
        );
        assert_eq!(s.len(), 36, "unexpected UUID string length: {}", s);
    }
}

/// Verify that a panic while holding TrackedPermit transitions the entry to
/// Done (Drop runs during unwinding).
#[tokio::test]
async fn panic_safety() {
    use std::panic::{catch_unwind, AssertUnwindSafe};

    let (tx, _rx) = broadcast::channel::<MetricUpdate>(256);
    let limiter = Arc::new(ProviderLimiter::new(tx));
    limiter.register(
        &ProviderId::new("test"),
        Weight::from(4.0),
        Duration::from_secs(30),
        64,
    );
    let tracker = Arc::new(RequestTracker::new());

    // Acquire a TrackedPermit through the production hook function.
    let permit = acquire_for_request(
        &limiter,
        &tracker,
        &ProviderId::new("test"),
        &ModelId::new("gpt-4"),
        Weight::from(1.0),
        ProtocolVersion::Http11,
        "/v1/chat/completions".to_string(),
    )
    .await
    .expect("acquire should succeed");

    let request_id = permit.id();

    // While the permit is alive, status should be Running.
    let snap = tracker.snapshot();
    let req = snap
        .iter()
        .find(|r| r.id == request_id)
        .expect("request should be tracked");
    assert_eq!(
        req.status,
        RequestStatus::Running,
        "request should be Running while permit is held"
    );

    // Panic while holding the guard — Drop must still run during unwinding.
    let result = catch_unwind(AssertUnwindSafe(|| {
        let _guard = permit;
        panic!("simulated failure");
    }));
    assert!(result.is_err(), "catch_unwind should have caught a panic");

    // The guard was dropped during unwinding — mark_done must have run.
    let snap = tracker.snapshot();
    let req = snap
        .iter()
        .find(|r| r.id == request_id)
        .expect("request should still be tracked after unwind");
    assert_eq!(
        req.status,
        RequestStatus::Done,
        "Drop must run during unwinding and call mark_done"
    );
}
