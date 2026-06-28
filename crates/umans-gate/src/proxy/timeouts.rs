//! Timeout hierarchy for upstream forwarding (connect / TTFB / stream-idle / total).
//!
//! Wraps [`UpstreamClient::forward`] with a four-tier timeout hierarchy sourced
//! from [`TimeoutConfig`]. The [`WeightedPermit`] is moved into the response body
//! stream so it drops on stream completion or client disconnect — the handler
//! never retains it (RAII pattern, same as [`proxy::gating`]).
//!
//! ## Timeout layers
//!
//! 1. **Connect** — wraps `client.forward(...)` (TCP connect + TLS + request send
//!    + response headers). Elapsed → [`GatewayError::Timeout`] `"connect timeout"`.
//! 2. **TTFB** — polls the first response body frame after `forward` returns.
//!    Elapsed → `"ttfb timeout"`.
//! 3. **Stream-idle** — wraps each subsequent body frame poll inside the returned
//!    streaming body. Elapsed → body yields `io::Error(TimedOut)`.
//! 4. **Total** — hard deadline (`Instant::now() + total`) that applies to
//!    connect, TTFB, and every body frame poll. Elapsed → `"total timeout"`
//!    (pre-response) or body yields `io::Error(TimedOut)` (mid-stream).

use std::time::Duration;

use async_stream::stream;
use bytes::Bytes;
use http_body_util::BodyExt;
use hyper::{HeaderMap, Method};
use tokio::sync::mpsc;
use tokio::time::{timeout, timeout_at, Instant};
use tracing::{debug, warn};

use crate::dashboard::tracked_permit::TrackedPermit;
use crate::dashboard::tracker::ProtocolVersion;
use crate::error::{GatewayError, Result};
use crate::types::ProviderConfig;

use super::upstream::UpstreamClient;

/// Forward a request upstream with the AI-tuned timeout hierarchy.
///
/// `provider_config.timeouts` is the source of truth (defaults: connect 10s,
/// ttfb 30s, stream_idle 60s, total 300s — see [`crate::types::TimeoutConfig`]).
///
/// The `WeightedPermit` is moved into the returned body stream (`let _permit =
/// permit;` as the first statement of the generator), so it drops on stream
/// completion or client disconnect. The caller MUST NOT retain the permit after
/// this call returns `Ok`.
pub async fn forward_with_timeouts(
    client: &UpstreamClient,
    provider_config: &ProviderConfig,
    method: Method,
    upstream_uri: String,
    headers: HeaderMap,
    body: axum::body::Body,
    permit: TrackedPermit,
) -> Result<axum::response::Response> {
    let t = &provider_config.timeouts;
    let total_deadline = Instant::now() + t.total;

    // Phase 1: connect timeout wraps client.forward().
    // Nested: timeout_at(total_deadline, timeout(connect, forward)).
    // - Outer Err(Elapsed) → total deadline hit.
    // - Inner Err(Elapsed) → connect elapsed.
    let upstream_resp = timeout_at(
        total_deadline,
        timeout(
            t.connect,
            client.forward(
                method,
                upstream_uri,
                &provider_config.upstream_url,
                headers,
                body,
            ),
        ),
    )
    .await
    .map_err(|_| GatewayError::Timeout("total timeout".into()))?
    .map_err(|_| GatewayError::Timeout("connect timeout".into()))?;

    let upstream_resp = upstream_resp?;

    let upstream_version = upstream_resp.version;
    let status = upstream_resp.status;
    let resp_headers = upstream_resp.headers;
    let mut body = upstream_resp.body;

    // Phase 2: TTFB timeout on first body frame.
    let first_frame = timeout_at(total_deadline, timeout(t.ttfb, body.frame()))
        .await
        .map_err(|_| GatewayError::Timeout("total timeout".into()))?
        .map_err(|_| GatewayError::Timeout("ttfb timeout".into()))?;

    let first_data: Option<Bytes> = match first_frame {
        None => None,
        Some(Ok(frame)) => frame.into_data().ok(),
        Some(Err(e)) => return Err(GatewayError::Upstream(format!("body read: {e}"))),
    };

    // Phase 3 + 4: stream-idle + total enforced inside the body stream.
    let stream_idle = t.stream_idle;
    permit
        .tracker()
        .set_upstream_protocol(permit.request_id(), ProtocolVersion::from(upstream_version));
    // Clamp cooldown at use site: bounded permit retention after downstream
    // disconnect, but never exceed the configured value or 500ms.
    let cooldown = provider_config
        .timeouts
        .permit_cooldown
        .min(Duration::from_millis(500));

    let (tx, mut rx) = mpsc::channel::<std::result::Result<Bytes, std::io::Error>>(8);

    // Spawn a detached task that owns the permit and drains the upstream body
    // into the channel. The permit drops when the task exits — immediately on
    // clean upstream EOS or upstream timeout, or after `cooldown` following
    // downstream disconnect (capped by `total_deadline`).
    tokio::spawn(async move {
        let _permit = permit;
        let mut body = body;

        // Forward first frame data (already polled — TTFB applied above).
        if let Some(data) = first_data {
            let _ = tx.send(Ok(data)).await;
        }

        // Drain loop: forward upstream frames, detect downstream disconnect.
        loop {
            tokio::select! {
                () = tx.closed() => break,
                result = timeout_at(total_deadline, timeout(stream_idle, body.frame())) => {
                    match result {
                        // Total deadline hit — send error then return (permit drops).
                        Err(_) => {
                            let _ = tx
                                .send(Err(std::io::Error::new(
                                    std::io::ErrorKind::TimedOut,
                                    "total timeout",
                                )))
                                .await;
                            return;
                        }
                        // Stream-idle elapsed — send error then return (permit drops).
                        Ok(Err(_)) => {
                            let _ = tx
                                .send(Err(std::io::Error::new(
                                    std::io::ErrorKind::TimedOut,
                                    "stream-idle timeout",
                                )))
                                .await;
                            return;
                        }
                        // Clean upstream EOS — return (permit drops immediately).
                        Ok(Ok(None)) => return,
                        // Upstream body read error — return (permit drops immediately).
                        Ok(Ok(Some(Err(_)))) => return,
                        // Got a frame — forward data bytes.
                        Ok(Ok(Some(Ok(frame)))) => {
                            if let Ok(data) = frame.into_data() {
                                match timeout_at(total_deadline, tx.send(Ok(data))).await {
                                    Ok(Ok(())) => {}
                                    Ok(Err(_)) | Err(_) => break,
                                }
                            }
                        }
                    }
                }
            }
        }

        // Cooldown phase: hold the permit briefly after downstream disconnect.
        if cooldown == Duration::ZERO {
            return;
        }
        debug!(reason = "downstream_disconnect", "entering permit cooldown");

        tokio::select! {
            // Cooldown elapsed — release permit.
            () = tokio::time::sleep(cooldown) => {
                debug!(reason = "cooldown_elapsed", "permit cooldown complete");
            }
            // Upstream EOS or error during cooldown.
            res = body.frame() => {
                let _ = res;
                debug!(
                    reason = "upstream_eos_during_cooldown",
                    "upstream ended during cooldown"
                );
            }
            // Total deadline hit during cooldown.
            () = tokio::time::sleep_until(total_deadline) => {
                warn!(
                    reason = "total_deadline",
                    "total timeout during permit cooldown"
                );
            }
        }
    });

    let stream = stream! {
        while let Some(res) = rx.recv().await {
            match res {
                Ok(bytes) => yield Ok::<Bytes, std::io::Error>(bytes),
                Err(io_err) => yield Err(io_err),
            }
        }
    };
    let body = axum::body::Body::from_stream(stream);
    let mut resp = hyper::Response::new(body);
    *resp.status_mut() = status;
    *resp.headers_mut() = resp_headers;
    Ok(resp)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::concurrency::{MetricUpdate, ProviderLimiter};
    use crate::dashboard::tracked_permit::TrackedPermit;
    use crate::dashboard::tracker::{ProtocolVersion, RequestTracker};
    use crate::types::{ModelConfig, ModelId, ProviderId, TimeoutConfig, Weight};
    use hyper::StatusCode;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::broadcast;
    use uuid::Uuid;

    /// Build a provider config with the given timeouts.
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
            std::time::Duration::from_secs(30),
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

    /// Assert in_flight weight for the test provider matches `expected`.
    fn assert_in_flight(lim: &ProviderLimiter, expected: f32) {
        let snap = lim.snapshot().into_iter().next().unwrap();
        assert!(
            (snap.in_flight - expected).abs() < 1e-6,
            "in_flight {} != {}",
            snap.in_flight,
            expected
        );
    }

    /// Poll `in_flight` until it reaches zero, or panic after `timeout_ms`.
    /// Needed because the permit now lives in a spawned task — its drop is
    /// asynchronous w.r.t. downstream body consumption.
    async fn wait_for_in_flight_zero(lim: &ProviderLimiter, timeout_ms: u64) {
        for _ in 0..(timeout_ms / 10).max(1) {
            if (lim.snapshot().into_iter().next().unwrap().in_flight - 0.0).abs() < 1e-6 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_in_flight(lim, 0.0);
    }

    /// Empty request body for tests (Empty<Bytes> wrapped in axum Body).
    fn empty_body() -> axum::body::Body {
        axum::body::Body::new(http_body_util::Empty::<Bytes>::new())
    }

    // -----------------------------------------------------------------------
    // Test 1: connect timeout — mock accepts TCP but never sends response.
    // forward() hangs → connect timeout fires.
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn connect_timeout_unreachable_address() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 1024];
            let _ = sock.read(&mut buf).await;
            // Never send response — hold connection open.
            tokio::time::sleep(Duration::from_secs(10)).await;
        });

        let (lim, permit) = make_permit().await;
        assert_in_flight(&lim, 1.0);

        let client = UpstreamClient::new();
        let provider = test_provider(TimeoutConfig {
            connect: Duration::from_millis(200),
            ttfb: Duration::from_secs(5),
            stream_idle: Duration::from_secs(5),
            total: Duration::from_secs(10),
            ..Default::default()
        });

        let err = forward_with_timeouts(
            &client,
            &provider,
            Method::GET,
            format!("http://127.0.0.1:{port}/"),
            HeaderMap::new(),
            empty_body(),
            permit,
        )
        .await
        .unwrap_err();

        assert!(
            matches!(err, GatewayError::Timeout(ref msg) if msg.contains("connect")),
            "expected connect timeout, got: {err:?}"
        );
        // Stream never created → permit dropped in function scope → capacity released.
        assert_in_flight(&lim, 0.0);
    }

    // -----------------------------------------------------------------------
    // Test 2: TTFB timeout — mock sends response headers but no body.
    // forward() returns, body.frame() hangs → TTFB fires.
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn ttfb_timeout_mock_sends_no_body() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 1024];
            let _ = sock.read(&mut buf).await;
            // Send headers only — no body bytes.
            sock.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n")
                .await
                .unwrap();
            sock.flush().await.unwrap();
            // Never send body — hold connection open.
            tokio::time::sleep(Duration::from_secs(10)).await;
        });

        let (lim, permit) = make_permit().await;
        assert_in_flight(&lim, 1.0);

        let client = UpstreamClient::new();
        let provider = test_provider(TimeoutConfig {
            connect: Duration::from_secs(5),
            ttfb: Duration::from_millis(200),
            stream_idle: Duration::from_secs(5),
            total: Duration::from_secs(10),
            ..Default::default()
        });

        let err = forward_with_timeouts(
            &client,
            &provider,
            Method::GET,
            format!("http://127.0.0.1:{port}/"),
            HeaderMap::new(),
            empty_body(),
            permit,
        )
        .await
        .unwrap_err();

        assert!(
            matches!(err, GatewayError::Timeout(ref msg) if msg.contains("ttfb")),
            "expected ttfb timeout, got: {err:?}"
        );
        assert_in_flight(&lim, 0.0);
    }

    // -----------------------------------------------------------------------
    // Test 3: stream-idle timeout — mock sends headers + one chunk then stalls.
    // forward() returns, first frame arrives (TTFB ok), second frame stalls
    // → stream-idle fires inside the body stream.
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn stream_idle_timeout_mock_stalls_after_first_chunk() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 1024];
            let _ = sock.read(&mut buf).await;
            // Send headers + one chunked-data chunk.
            sock.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n")
                .await
                .unwrap();
            sock.flush().await.unwrap();
            // Stall — never send the final 0-length chunk.
            tokio::time::sleep(Duration::from_secs(10)).await;
        });

        let (lim, permit) = make_permit().await;

        let client = UpstreamClient::new();
        let provider = test_provider(TimeoutConfig {
            connect: Duration::from_secs(5),
            ttfb: Duration::from_secs(5),
            stream_idle: Duration::from_millis(200),
            total: Duration::from_secs(10),
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
        .expect("forward succeeds — headers + first chunk arrive");

        assert_eq!(resp.status(), StatusCode::OK);
        assert_in_flight(&lim, 1.0); // permit held by body stream

        // Consume body — first chunk arrives, then stream-idle fires → error.
        let result = resp.into_body().collect().await;
        assert!(result.is_err(), "body should error on stream-idle timeout");

        // Stream ended → permit dropped (async) → capacity released.
        wait_for_in_flight_zero(&lim, 1000).await;
    }

    // -----------------------------------------------------------------------
    // Test 4: total timeout — mock sends data slowly beyond short total.
    // Generous connect/TTFB/stream-idle, but total=300ms → body stream fails
    // because total deadline is exceeded mid-stream.
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn total_timeout_mock_sends_slowly() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 1024];
            let _ = sock.read(&mut buf).await;
            // Send headers immediately.
            sock.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
                .await
                .unwrap();
            sock.flush().await.unwrap();
            // Send chunks slowly — one every 50ms.
            for _ in 0..100 {
                tokio::time::sleep(Duration::from_millis(50)).await;
                let _ = sock.write_all(b"1\r\na\r\n").await;
                let _ = sock.flush().await;
            }
        });

        let (lim, permit) = make_permit().await;

        let client = UpstreamClient::new();
        let provider = test_provider(TimeoutConfig {
            connect: Duration::from_secs(5),
            ttfb: Duration::from_secs(5),
            stream_idle: Duration::from_secs(5),
            total: Duration::from_millis(300),
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
        .expect("forward succeeds — headers arrive before total");

        assert_eq!(resp.status(), StatusCode::OK);
        assert_in_flight(&lim, 1.0);

        // Consume body — total deadline fires during streaming → error.
        let result = resp.into_body().collect().await;
        assert!(result.is_err(), "body should error on total timeout");

        wait_for_in_flight_zero(&lim, 1000).await;
    }

    // -----------------------------------------------------------------------
    // Happy path — mock sends a complete response. Body drains, permit drops.
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn happy_path_streams_body() {
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
        assert_in_flight(&lim, 1.0);

        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&bytes[..], b"hello");

        wait_for_in_flight_zero(&lim, 1000).await;
    }
}
