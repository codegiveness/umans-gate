#![cfg(feature = "hot-reload")]

//! Integration tests: permit cooldown behavior of `forward_with_timeouts`.
//!
//! These tests exercise the real `forward_with_timeouts` through mock TCP
//! upstreams. The permit lifecycle is observed via `ProviderLimiter::snapshot`
//! in_flight weight — the single source of truth.

use std::sync::{Arc, Mutex, Once, OnceLock};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::BodyExt;
use hyper::{HeaderMap, Method, StatusCode};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::layer::SubscriberExt as _;
use uuid::Uuid;

use umans_gate::concurrency::{MetricUpdate, ProviderLimiter};
use umans_gate::dashboard::tracked_permit::TrackedPermit;
use umans_gate::dashboard::tracker::{ProtocolVersion, RequestTracker};
use umans_gate::proxy::timeouts::forward_with_timeouts;
use umans_gate::proxy::upstream::UpstreamClient;
use umans_gate::types::{ModelConfig, ModelId, ProviderConfig, ProviderId, TimeoutConfig, Weight};

// ---------------------------------------------------------------------------
// Helpers (duplicated from timeouts.rs::tests — integration tests cannot
// access private test helpers).
// ---------------------------------------------------------------------------

fn test_provider(timeouts: TimeoutConfig) -> ProviderConfig {
    ProviderConfig {
        id: ProviderId::new("test"),
        upstream_url: url::Url::parse("http://127.0.0.1").unwrap(),
        capacity: Weight::from(4.0),
        models: vec![ModelConfig {
            id: ModelId::new("gpt-4"),
            weight: Weight::from(1.0),
        }],
        timeouts,
    }
}

async fn make_permit() -> (Arc<ProviderLimiter>, TrackedPermit) {
    let (tx, _rx) = broadcast::channel::<MetricUpdate>(256);
    let lim = Arc::new(ProviderLimiter::new(tx));
    lim.register(
        &ProviderId::new("test"),
        Weight::from(4.0),
        Duration::from_secs(30),
        64,
    );
    let tracker = Arc::new(RequestTracker::new());
    let id = Uuid::new_v4();
    tracker.register_queued(
        id,
        &ProviderId::new("test"),
        &ModelId::new("gpt-4"),
        Weight::from(1.0),
        ProtocolVersion::Http11,
    );
    let permit = lim
        .acquire(
            &ProviderId::new("test"),
            &ModelId::new("gpt-4"),
            Weight::from(1.0),
        )
        .await
        .unwrap();
    tracker.mark_running(id, None);
    let tracked = TrackedPermit::new(permit, id, Arc::clone(&tracker));
    (lim, tracked)
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

async fn wait_for_in_flight_zero(lim: &ProviderLimiter, timeout_ms: u64) {
    for _ in 0..(timeout_ms / 10).max(1) {
        if (lim.snapshot().into_iter().next().unwrap().in_flight - 0.0).abs() < 1e-6 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_in_flight(lim, 0.0);
}

fn empty_body() -> axum::body::Body {
    axum::body::Body::new(http_body_util::Empty::<Bytes>::new())
}

// ---------------------------------------------------------------------------
// Tracing capture for `diagnostic_logs_present`.
// ---------------------------------------------------------------------------

static TRACING_BUF: OnceLock<Arc<Mutex<Vec<u8>>>> = OnceLock::new();
static TRACING_INIT: Once = Once::new();

#[derive(Clone)]
struct BufferMakeWriter {
    buf: Arc<Mutex<Vec<u8>>>,
}

struct BufferWriter {
    buf: Arc<Mutex<Vec<u8>>>,
}

impl std::io::Write for BufferWriter {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        self.buf.lock().unwrap().extend_from_slice(data);
        Ok(data.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for BufferMakeWriter {
    type Writer = BufferWriter;
    fn make_writer(&'a self) -> Self::Writer {
        BufferWriter {
            buf: self.buf.clone(),
        }
    }
}

fn init_tracing() -> Arc<Mutex<Vec<u8>>> {
    let buf = TRACING_BUF
        .get_or_init(|| Arc::new(Mutex::new(Vec::new())))
        .clone();
    TRACING_INIT.call_once(|| {
        let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("umans_gate=debug"));
        let stderr_layer = tracing_subscriber::fmt::layer()
            .with_ansi(false)
            .with_writer(std::io::stderr);
        let buffer_layer = tracing_subscriber::fmt::layer()
            .with_ansi(false)
            .with_writer(BufferMakeWriter {
                buf: TRACING_BUF.get().unwrap().clone(),
            });
        let subscriber = tracing_subscriber::registry()
            .with(env_filter)
            .with(stderr_layer)
            .with(buffer_layer);
        let _ = tracing::subscriber::set_global_default(subscriber);
    });
    buf
}

// ---------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

// Test 1: permit held during cooldown after downstream disconnect.
#[tokio::test]
async fn permit_held_during_cooldown_after_downstream_disconnect() {
    let _ = init_tracing();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut buf = vec![0u8; 1024];
        let _ = sock.read(&mut buf).await;
        sock.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n")
            .await
            .unwrap();
        sock.flush().await.unwrap();
        tokio::time::sleep(Duration::from_secs(10)).await;
    });

    let (lim, permit) = make_permit().await;
    let client = UpstreamClient::new();
    let provider = test_provider(TimeoutConfig {
        connect: Duration::from_secs(2),
        ttfb: Duration::from_secs(2),
        stream_idle: Duration::from_secs(2),
        total: Duration::from_secs(10),
        permit_cooldown: Duration::from_millis(500),
        ..Default::default()
    });

    let resp = forward_with_timeouts(
        &client,
        &provider,
        Method::GET,
        format!("http://127.0.0.1:{port}/"),
        HeaderMap::new(),
        empty_body(),
        permit,
    )
    .await
    .expect("forward succeeds");

    assert_eq!(resp.status(), StatusCode::OK);

    // Drop response body — simulates downstream disconnect.
    // The first frame was already polled during TTFB check inside
    // forward_with_timeouts, so the stream has started.
    drop(resp);

    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_in_flight(&lim, 1.0);

    wait_for_in_flight_zero(&lim, 2000).await;
}

// -----------------------------------------------------------------------
// Test 2: permit released immediately on normal completion.
#[tokio::test]
async fn permit_released_immediately_on_normal_completion() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut buf = vec![0u8; 1024];
        let _ = sock.read(&mut buf).await;
        sock.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello")
            .await
            .unwrap();
        sock.flush().await.unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
    });

    let (lim, permit) = make_permit().await;
    let client = UpstreamClient::new();
    let provider = test_provider(TimeoutConfig {
        connect: Duration::from_secs(2),
        ttfb: Duration::from_secs(2),
        stream_idle: Duration::from_secs(2),
        total: Duration::from_secs(5),
        permit_cooldown: Duration::from_millis(500),
        ..Default::default()
    });

    let resp = forward_with_timeouts(
        &client,
        &provider,
        Method::GET,
        format!("http://127.0.0.1:{port}/"),
        HeaderMap::new(),
        empty_body(),
        permit,
    )
    .await
    .expect("forward succeeds");

    assert_eq!(resp.status(), StatusCode::OK);

    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(&bytes[..], b"hello");

    wait_for_in_flight_zero(&lim, 500).await;
}

// -----------------------------------------------------------------------
// Test 3: permit released on upstream timeout.
#[tokio::test]
async fn permit_released_on_upstream_timeout() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut buf = vec![0u8; 1024];
        let _ = sock.read(&mut buf).await;
        sock.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n")
            .await
            .unwrap();
        sock.flush().await.unwrap();
        tokio::time::sleep(Duration::from_secs(10)).await;
    });

    let (lim, permit) = make_permit().await;
    let client = UpstreamClient::new();
    let provider = test_provider(TimeoutConfig {
        connect: Duration::from_secs(2),
        ttfb: Duration::from_secs(2),
        stream_idle: Duration::from_millis(200),
        total: Duration::from_secs(10),
        permit_cooldown: Duration::from_millis(500),
        ..Default::default()
    });

    let resp = forward_with_timeouts(
        &client,
        &provider,
        Method::GET,
        format!("http://127.0.0.1:{port}/"),
        HeaderMap::new(),
        empty_body(),
        permit,
    )
    .await
    .expect("forward succeeds");

    assert_eq!(resp.status(), StatusCode::OK);

    let result = resp.into_body().collect().await;
    assert!(result.is_err(), "body should error on stream-idle timeout");

    wait_for_in_flight_zero(&lim, 1000).await;
}

// -----------------------------------------------------------------------
// Test 4: cooldown cancelled by upstream EOS.
#[tokio::test]
async fn cooldown_cancelled_by_upstream_eos() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut buf = vec![0u8; 1024];
        let _ = sock.read(&mut buf).await;
        sock.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n")
            .await
            .unwrap();
        sock.flush().await.unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        let _ = sock.write_all(b"0\r\n\r\n").await;
        let _ = sock.flush().await;
        tokio::time::sleep(Duration::from_secs(5)).await;
    });

    let (lim, permit) = make_permit().await;
    let client = UpstreamClient::new();
    let provider = test_provider(TimeoutConfig {
        connect: Duration::from_secs(2),
        ttfb: Duration::from_secs(2),
        stream_idle: Duration::from_secs(2),
        total: Duration::from_secs(10),
        permit_cooldown: Duration::from_millis(500),
        ..Default::default()
    });

    let resp = forward_with_timeouts(
        &client,
        &provider,
        Method::GET,
        format!("http://127.0.0.1:{port}/"),
        HeaderMap::new(),
        empty_body(),
        permit,
    )
    .await
    .expect("forward succeeds");

    assert_eq!(resp.status(), StatusCode::OK);

    // Drop response — disconnect triggers cooldown.
    drop(resp);

    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_in_flight(&lim, 1.0);

    // Upstream EOS cancels cooldown — permit drops before 500ms elapses.
    wait_for_in_flight_zero(&lim, 1500).await;
}

// -----------------------------------------------------------------------
// Test 5: cooldown cancelled by total deadline.
#[tokio::test]
async fn cooldown_cancelled_by_total_deadline() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut buf = vec![0u8; 1024];
        let _ = sock.read(&mut buf).await;
        sock.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n")
            .await
            .unwrap();
        sock.flush().await.unwrap();
        tokio::time::sleep(Duration::from_secs(10)).await;
    });

    let (lim, permit) = make_permit().await;
    let client = UpstreamClient::new();
    let provider = test_provider(TimeoutConfig {
        connect: Duration::from_secs(2),
        ttfb: Duration::from_secs(2),
        stream_idle: Duration::from_secs(2),
        total: Duration::from_millis(400),
        permit_cooldown: Duration::from_millis(500),
        ..Default::default()
    });

    let resp = forward_with_timeouts(
        &client,
        &provider,
        Method::GET,
        format!("http://127.0.0.1:{port}/"),
        HeaderMap::new(),
        empty_body(),
        permit,
    )
    .await
    .expect("forward succeeds");

    assert_eq!(resp.status(), StatusCode::OK);

    // Drop response — disconnect triggers cooldown.
    drop(resp);

    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_in_flight(&lim, 1.0);

    // Total deadline cancels cooldown — permit drops.
    wait_for_in_flight_zero(&lim, 1000).await;
}

// -----------------------------------------------------------------------
// Test 6: permit cooldown clamped to max (500ms).
#[tokio::test]
async fn permit_cooldown_clamped_to_max() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut buf = vec![0u8; 1024];
        let _ = sock.read(&mut buf).await;
        sock.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n")
            .await
            .unwrap();
        sock.flush().await.unwrap();
        tokio::time::sleep(Duration::from_secs(10)).await;
    });

    let (lim, permit) = make_permit().await;
    let client = UpstreamClient::new();
    let provider = test_provider(TimeoutConfig {
        connect: Duration::from_secs(2),
        ttfb: Duration::from_secs(2),
        stream_idle: Duration::from_secs(2),
        total: Duration::from_secs(10),
        permit_cooldown: Duration::from_secs(10),
        ..Default::default()
    });

    let resp = forward_with_timeouts(
        &client,
        &provider,
        Method::GET,
        format!("http://127.0.0.1:{port}/"),
        HeaderMap::new(),
        empty_body(),
        permit,
    )
    .await
    .expect("forward succeeds");

    assert_eq!(resp.status(), StatusCode::OK);

    // Drop response — disconnect triggers cooldown.
    drop(resp);

    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_in_flight(&lim, 1.0);

    // Clamped cooldown (500ms, not 10s) elapses — permit released.
    wait_for_in_flight_zero(&lim, 2000).await;
}

// -----------------------------------------------------------------------
// Test 7: permit_cooldown zero disables cooldown.
#[tokio::test]
async fn permit_cooldown_zero_disables_cooldown() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut buf = vec![0u8; 1024];
        let _ = sock.read(&mut buf).await;
        sock.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n")
            .await
            .unwrap();
        sock.flush().await.unwrap();
        tokio::time::sleep(Duration::from_secs(10)).await;
    });

    let (lim, permit) = make_permit().await;
    let client = UpstreamClient::new();
    let provider = test_provider(TimeoutConfig {
        connect: Duration::from_secs(2),
        ttfb: Duration::from_secs(2),
        stream_idle: Duration::from_secs(2),
        total: Duration::from_secs(10),
        permit_cooldown: Duration::ZERO,
        ..Default::default()
    });

    let resp = forward_with_timeouts(
        &client,
        &provider,
        Method::GET,
        format!("http://127.0.0.1:{port}/"),
        HeaderMap::new(),
        empty_body(),
        permit,
    )
    .await
    .expect("forward succeeds");

    assert_eq!(resp.status(), StatusCode::OK);

    // Drop response — disconnect triggers cooldown path (but cooldown=0).
    drop(resp);

    // No cooldown — permit drops immediately after disconnect.
    wait_for_in_flight_zero(&lim, 500).await;
}

// -----------------------------------------------------------------------
// Test 8: diagnostic logs present.
#[tokio::test]
async fn diagnostic_logs_present() {
    let buf = init_tracing();
    buf.lock().unwrap().clear();

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut buf = vec![0u8; 1024];
        let _ = sock.read(&mut buf).await;
        sock.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n")
            .await
            .unwrap();
        sock.flush().await.unwrap();
        tokio::time::sleep(Duration::from_secs(10)).await;
    });

    let (lim, permit) = make_permit().await;
    let client = UpstreamClient::new();
    let provider = test_provider(TimeoutConfig {
        connect: Duration::from_secs(2),
        ttfb: Duration::from_secs(2),
        stream_idle: Duration::from_secs(2),
        total: Duration::from_secs(10),
        permit_cooldown: Duration::from_millis(500),
        ..Default::default()
    });

    let resp = forward_with_timeouts(
        &client,
        &provider,
        Method::GET,
        format!("http://127.0.0.1:{port}/"),
        HeaderMap::new(),
        empty_body(),
        permit,
    )
    .await
    .expect("forward succeeds");

    // Drop response — triggers cooldown path with tracing events.
    drop(resp);

    wait_for_in_flight_zero(&lim, 2000).await;
    tokio::time::sleep(Duration::from_millis(50)).await;

    let logs = String::from_utf8(buf.lock().unwrap().clone()).unwrap();

    assert!(
        logs.contains("reason=\"downstream_disconnect\""),
        "expected reason=\"downstream_disconnect\" in logs: {logs}"
    );
    assert!(
        logs.contains("reason=\"cooldown_elapsed\"")
            || logs.contains("reason=\"upstream_eos_during_cooldown\""),
        "expected cooldown_elapsed or upstream_eos_during_cooldown in logs: {logs}"
    );
}
