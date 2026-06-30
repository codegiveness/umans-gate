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

use std::future::Future;
use std::time::Duration;

use async_stream::stream;
use bytes::Bytes;
use http_body_util::BodyExt;
use hyper::{HeaderMap, Method};
use tokio::sync::mpsc;
use tokio::time::{timeout, timeout_at, Instant};
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

use crate::dashboard::tracked_permit::TrackedPermit;
use crate::dashboard::tracker::{ApiKind, ProtocolVersion};
use crate::error::{GatewayError, Result};
use crate::types::ProviderConfig;

use super::upstream::UpstreamClient;

/// Build the provider-native SSE error frame for an in-stream kill.
///
/// - **Anthropic**: `event: error\ndata: {"type":"error","error":{"type":"invalid_request_error","message":"..."}}`
/// - **OpenAI**: `data: {"error":{...},"choices":[{"index":0,"delta":{},"finish_reason":"error"}]}\n\ndata: [DONE]`
fn kill_sse_error_frame(api_kind: ApiKind) -> Vec<u8> {
    match api_kind {
        ApiKind::Anthropic => {
            b"event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"Request killed from umans dashboard\"}}\n\n".to_vec()
        }
        ApiKind::OpenAI | ApiKind::Unknown => {
            b"data: {\"error\":{\"message\":\"Request killed from umans dashboard\",\"type\":\"invalid_request_error\",\"param\":null,\"code\":null},\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"error\"}]}\n\ndata: [DONE]\n\n".to_vec()
        }
    }
}

/// Discriminant for which timeout fired when wrapping a future with both an
/// optional total deadline and an optional per-phase timeout.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TimeoutElapsed {
    Total,
    Phase,
}

/// Wrap `fut` with an optional per-phase timeout (`dur`) and an optional total
/// deadline. Returns `Ok(value)` on success, or `Err(TimeoutElapsed)`
/// indicating which timeout fired.
///
/// - `dur = None` → no per-phase timeout.
/// - `total_deadline = None` → no total deadline.
async fn wrap_timeouts<F, T>(
    total_deadline: Option<Instant>,
    dur: Option<Duration>,
    fut: F,
) -> std::result::Result<T, TimeoutElapsed>
where
    F: Future<Output = T>,
{
    match (total_deadline, dur) {
        (Some(td), Some(d)) => match timeout_at(td, timeout(d, fut)).await {
            Err(_) => Err(TimeoutElapsed::Total),
            Ok(Err(_)) => Err(TimeoutElapsed::Phase),
            Ok(Ok(v)) => Ok(v),
        },
        (Some(td), None) => match timeout_at(td, fut).await {
            Err(_) => Err(TimeoutElapsed::Total),
            Ok(v) => Ok(v),
        },
        (None, Some(d)) => match timeout(d, fut).await {
            Err(_) => Err(TimeoutElapsed::Phase),
            Ok(v) => Ok(v),
        },
        (None, None) => Ok(fut.await),
    }
}

/// Lightweight SSE/JSON token usage inspector for the upstream drain loop.
///
/// Inspects response bytes as they flow through the drain loop and extracts
/// token usage metrics (prompt_tokens, completion_tokens, cached_tokens).
/// Fail-closed: on any parse error, fields remain `None` and the stream
/// continues unchanged.
struct TokenTap {
    api_kind: ApiKind,
    is_sse: bool,
    line_buf: Vec<u8>,
    body_buf: Vec<u8>,
    done: bool,
    prompt_tokens: Option<usize>,
    completion_tokens: Option<usize>,
    cached_tokens: Option<usize>,
}

impl TokenTap {
    fn new(api_kind: ApiKind, is_sse: bool) -> Self {
        TokenTap {
            api_kind,
            is_sse,
            line_buf: Vec::new(),
            body_buf: Vec::new(),
            done: false,
            prompt_tokens: None,
            completion_tokens: None,
            cached_tokens: None,
        }
    }

    fn feed(&mut self, data: &Bytes) {
        if self.done {
            return;
        }
        if self.is_sse {
            self.line_buf.extend_from_slice(data);
            while let Some(pos) = self.line_buf.iter().position(|&b| b == b'\n') {
                let line_bytes: Vec<u8> = self.line_buf.drain(..=pos).collect();
                let line = std::str::from_utf8(&line_bytes).unwrap_or("").trim_end();
                self.process_sse_line(line);
                if self.done {
                    break;
                }
            }
        } else {
            self.body_buf.extend_from_slice(data);
        }
    }

    fn finish(&mut self) {
        if self.done {
            return;
        }
        if self.is_sse {
            if !self.line_buf.is_empty() {
                let remaining = std::mem::take(&mut self.line_buf);
                let line = std::str::from_utf8(&remaining).unwrap_or("").trim_end();
                self.process_sse_line(line);
            }
        } else {
            self.parse_non_sse_body();
        }
        self.done = true;
    }

    fn process_sse_line(&mut self, line: &str) {
        let payload = match line.strip_prefix("data: ") {
            Some(p) => p,
            None => return,
        };
        if payload == "[DONE]" {
            return;
        }
        let json: serde_json::Value = match serde_json::from_str(payload) {
            Ok(v) => v,
            Err(_) => return,
        };
        match self.api_kind {
            ApiKind::OpenAI => self.extract_openai_sse(&json),
            ApiKind::Anthropic => self.extract_anthropic_sse(&json),
            ApiKind::Unknown => {}
        }
    }

    fn extract_openai_sse(&mut self, json: &serde_json::Value) {
        let usage = match json.get("usage") {
            Some(u) if !u.is_null() => u,
            _ => return,
        };
        self.prompt_tokens = opt_u64(usage.get("prompt_tokens"));
        self.completion_tokens = opt_u64(usage.get("completion_tokens"));
        self.cached_tokens = opt_u64(
            usage
                .get("prompt_tokens_details")
                .and_then(|d| d.get("cached_tokens")),
        );
        self.done = true;
    }

    fn extract_anthropic_sse(&mut self, json: &serde_json::Value) {
        let msg_type = json.get("type").and_then(|v| v.as_str());
        match msg_type {
            Some("message_start") => {
                if let Some(usage) = json.get("message").and_then(|m| m.get("usage")) {
                    self.prompt_tokens = opt_u64(usage.get("input_tokens"));
                    let cache_creation =
                        opt_u64(usage.get("cache_creation_input_tokens")).unwrap_or(0);
                    let cache_read = opt_u64(usage.get("cache_read_input_tokens")).unwrap_or(0);
                    self.cached_tokens = Some(cache_creation + cache_read);
                }
            }
            Some("message_delta") => {
                if let Some(output) =
                    opt_u64(json.get("usage").and_then(|u| u.get("output_tokens")))
                {
                    self.completion_tokens = Some(output);
                    self.done = true;
                }
            }
            _ => {}
        }
    }

    fn parse_non_sse_body(&mut self) {
        if self.body_buf.is_empty() {
            return;
        }
        let json: serde_json::Value = match serde_json::from_slice(&self.body_buf) {
            Ok(v) => v,
            Err(_) => return,
        };
        let usage = match json.get("usage") {
            Some(u) if !u.is_null() => u,
            _ => return,
        };
        match self.api_kind {
            ApiKind::OpenAI => {
                self.prompt_tokens = opt_u64(usage.get("prompt_tokens"));
                self.completion_tokens = opt_u64(usage.get("completion_tokens"));
                self.cached_tokens = opt_u64(
                    usage
                        .get("prompt_tokens_details")
                        .and_then(|d| d.get("cached_tokens")),
                );
            }
            ApiKind::Anthropic => {
                self.prompt_tokens = opt_u64(usage.get("input_tokens"));
                self.completion_tokens = opt_u64(usage.get("output_tokens"));
                self.cached_tokens = opt_u64(usage.get("cache_read_input_tokens"));
            }
            ApiKind::Unknown => {}
        }
    }

    fn prompt(&self) -> Option<usize> {
        self.prompt_tokens
    }

    fn completion(&self) -> Option<usize> {
        self.completion_tokens
    }

    fn cached(&self) -> Option<usize> {
        self.cached_tokens
    }
}

fn opt_u64(v: Option<&serde_json::Value>) -> Option<usize> {
    v.and_then(|v| v.as_u64()).map(|v| v as usize)
}

/// Forward a request upstream with the AI-tuned timeout hierarchy.
///
/// `provider_config.timeouts` is the source of truth (defaults: connect None,
/// ttfb None, stream_idle 300s, total None — see [`crate::types::TimeoutConfig`]).
///
/// The `WeightedPermit` is moved into the returned body stream (`let _permit =
/// permit;` as the first statement of the generator), so it drops on stream
/// completion or client disconnect. The caller MUST NOT retain the permit after
/// this call returns `Ok`.
#[allow(clippy::too_many_arguments)]
pub async fn forward_with_timeouts(
    client: &UpstreamClient,
    provider_config: &ProviderConfig,
    method: Method,
    upstream_uri: String,
    headers: HeaderMap,
    body: axum::body::Body,
    permit: TrackedPermit,
    token: CancellationToken,
) -> Result<axum::response::Response> {
    let t = &provider_config.timeouts;
    let total_deadline = t.total.map(|d| Instant::now() + d);

    // Phase 1: connect timeout wraps client.forward().
    // Nested: timeout_at(total_deadline, timeout(connect, forward)).
    // - Outer Err(Elapsed) → total deadline hit.
    // - Inner Err(Elapsed) → connect elapsed.
    let forward_fut = client.forward(
        method,
        upstream_uri,
        &provider_config.upstream_url,
        headers,
        body,
    );
    let upstream_resp = tokio::select! {
        result = wrap_timeouts(total_deadline, t.connect, forward_fut) => {
            match result {
                Ok(resp) => resp,
                Err(TimeoutElapsed::Total) => {
                    let id = permit.request_id();
                    permit.tracker().mark_timeout(id);
                    return Err(GatewayError::Timeout("total timeout".into()));
                }
                Err(TimeoutElapsed::Phase) => {
                    let id = permit.request_id();
                    permit.tracker().mark_timeout(id);
                    return Err(GatewayError::Timeout("connect timeout".into()));
                }
            }
        }
        () = token.cancelled() => {
            return Err(GatewayError::Cancelled);
        }
    };

    let upstream_resp = upstream_resp?;

    let upstream_version = upstream_resp.version;
    let status = upstream_resp.status;
    let resp_headers = upstream_resp.headers;
    let mut body = upstream_resp.body;

    // Phase 2: TTFB timeout on first body frame.
    let first_frame = tokio::select! {
        result = wrap_timeouts(total_deadline, t.ttfb, body.frame()) => {
            match result {
                Ok(frame) => frame,
                Err(TimeoutElapsed::Total) => {
                    let id = permit.request_id();
                    permit.tracker().mark_timeout(id);
                    return Err(GatewayError::Timeout("total timeout".into()));
                }
                Err(TimeoutElapsed::Phase) => {
                    let id = permit.request_id();
                    permit.tracker().mark_timeout(id);
                    return Err(GatewayError::Timeout("ttfb timeout".into()));
                }
            }
        }
        () = token.cancelled() => {
            return Err(GatewayError::Cancelled);
        }
    };

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
    permit
        .tracker()
        .set_upstream_status_and_ttft(permit.request_id(), status.as_u16());
    let is_sse = resp_headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|s| s.contains("text/event-stream"));
    let api_kind = permit
        .tracker()
        .api_kind(permit.request_id())
        .unwrap_or(ApiKind::Unknown);
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
        let mut tap = TokenTap::new(api_kind, is_sse);

        // Forward first frame data (already polled — TTFB applied above).
        if let Some(data) = first_data {
            tap.feed(&data);
            let _ = tx.send(Ok(data)).await;
        }

        // Drain loop: forward upstream frames, detect downstream disconnect.
        loop {
            tokio::select! {
                () = tx.closed() => break,
                () = token.cancelled() => {
                    debug!(reason = "cancelled", "upstream drain aborted by cancellation token");
                    if is_sse {
                        let frame = kill_sse_error_frame(api_kind);
                        let _ = tx.send(Ok(Bytes::from(frame))).await;
                    }
                    return;
                }
                result = wrap_timeouts(total_deadline, stream_idle, body.frame()) => {
                    match result {
                        // Total deadline hit — send error then return (permit drops).
                        Err(TimeoutElapsed::Total) => {
                            let id = _permit.request_id();
                            _permit.tracker().mark_timeout(id);
                            let _ = tx
                                .send(Err(std::io::Error::new(
                                    std::io::ErrorKind::TimedOut,
                                    "total timeout",
                                )))
                                .await;
                            return;
                        }
                        // Stream-idle elapsed — send error then return (permit drops).
                        Err(TimeoutElapsed::Phase) => {
                            let id = _permit.request_id();
                            _permit.tracker().mark_timeout(id);
                            let _ = tx
                                .send(Err(std::io::Error::new(
                                    std::io::ErrorKind::TimedOut,
                                    "stream-idle timeout",
                                )))
                                .await;
                            return;
                        }
                        // Clean upstream EOS — finish tap, apply usage, return.
                        Ok(None) => {
                            tap.finish();
                            _permit.tracker().set_token_usage(
                                _permit.request_id(),
                                tap.prompt(),
                                tap.completion(),
                                tap.cached(),
                            );
                            return;
                        }
                        // Upstream body read error — return (permit drops immediately).
                        Ok(Some(Err(_))) => return,
                        // Got a frame — forward data bytes.
                        Ok(Some(Ok(frame))) => {
                            if let Ok(data) = frame.into_data() {
                                tap.feed(&data);
                                match wrap_timeouts(total_deadline, None, tx.send(Ok(data))).await {
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

        if let Some(td) = total_deadline {
            tokio::select! {
                () = token.cancelled() => {
                    debug!(reason = "cancelled", "permit cooldown aborted by cancellation token");
                }
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
                () = tokio::time::sleep_until(td) => {
                    let id = _permit.request_id();
                    _permit.tracker().mark_timeout(id);
                    warn!(
                        reason = "total_deadline",
                        "total timeout during permit cooldown"
                    );
                }
            }
        } else {
            tokio::select! {
                () = token.cancelled() => {
                    debug!(reason = "cancelled", "permit cooldown aborted by cancellation token");
                }
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
mod test_helpers {
    use crate::concurrency::{MetricUpdate, ProviderLimiter};
    use crate::dashboard::tracked_permit::TrackedPermit;
    use crate::dashboard::tracker::{ProtocolVersion, RequestTracker};
    use crate::types::{ModelConfig, ModelId, ProviderConfig, ProviderId, TimeoutConfig, Weight};
    use axum::body::Body;
    use bytes::Bytes;
    use http_body_util::Empty;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::broadcast;
    use uuid::Uuid;

    /// Build a provider config with the given timeouts.
    pub fn test_provider(timeouts: TimeoutConfig) -> ProviderConfig {
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

    pub async fn make_permit() -> (Arc<ProviderLimiter>, TrackedPermit) {
        make_permit_with_path("/v1/chat/completions").await
    }

    pub async fn make_permit_with_path(path: &str) -> (Arc<ProviderLimiter>, TrackedPermit) {
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
            path.to_string(),
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
        let token = tracker.cancellation_token(id).unwrap_or_default();
        let tracked = TrackedPermit::new(permit, id, Arc::clone(&tracker), token);
        (lim, tracked)
    }

    /// Assert in_flight weight for the test provider matches `expected`.
    pub fn assert_in_flight(lim: &ProviderLimiter, expected: f32) {
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
    pub async fn wait_for_in_flight_zero(lim: &ProviderLimiter, timeout_ms: u64) {
        for _ in 0..(timeout_ms / 10).max(1) {
            if (lim.snapshot().into_iter().next().unwrap().in_flight - 0.0).abs() < 1e-6 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_in_flight(lim, 0.0);
    }

    /// Empty request body for tests (Empty<Bytes> wrapped in axum Body).
    pub fn empty_body() -> Body {
        Body::new(Empty::<Bytes>::new())
    }
}

#[cfg(test)]
mod tests {
    // Stop-gate regression baseline — these 22 tests must keep passing after
    // every wave. They protect the weighted-permit concurrency invariants:
    //
    // cargo test -p umans-gate --features hot-reload -- \
    //   concurrency::acquire_releases_correctly \
    //   concurrency::weighted_accounting \
    //   concurrency::concurrent_no_overcommit \
    //   concurrency::try_acquire_rejects_when_full \
    //   concurrency::permit_drop_on_disconnect \
    //   concurrency::broadcast_receives_acquired_and_released \
    //   gating::queue_timeout_fires \
    //   gating::maxqueue_rejects \
    //   gating::counter_no_leak_on_timeout \
    //   gating::tracker_marks_rejected_on_maxqueue \
    //   gating::permit_releases_on_stream_complete \
    //   gating::permit_releases_on_client_disconnect \
    //   gating::permit_not_in_handler_scope \
    //   gating::permit_released_after_completion \
    //   timeouts::connect_timeout_unreachable_address \
    //   timeouts::ttfb_timeout_mock_sends_no_body \
    //   timeouts::stream_idle_timeout_mock_stalls_after_first_chunk \
    //   timeouts::total_timeout_mock_sends_slowly \
    //   timeouts::happy_path_streams_body \
    //   tracked_permit::drop_calls_mark_done \
    //   tracked_permit::drop_during_unwinding_still_marks_done \
    //   handler::permit_acquired_during_request_and_released_after

    use super::test_helpers::*;
    use super::*;
    use crate::types::TimeoutConfig;
    use hyper::StatusCode;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

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
        let token = permit.token();
        assert_in_flight(&lim, 1.0);

        let client = UpstreamClient::new();
        let provider = test_provider(TimeoutConfig {
            connect: Some(Duration::from_millis(200)),
            ttfb: Some(Duration::from_secs(5)),
            stream_idle: Some(Duration::from_secs(5)),
            total: Some(Duration::from_secs(10)),
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
            token,
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
        let token = permit.token();
        assert_in_flight(&lim, 1.0);

        let client = UpstreamClient::new();
        let provider = test_provider(TimeoutConfig {
            connect: Some(Duration::from_secs(5)),
            ttfb: Some(Duration::from_millis(200)),
            stream_idle: Some(Duration::from_secs(5)),
            total: Some(Duration::from_secs(10)),
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
            token,
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
        let token = permit.token();

        let client = UpstreamClient::new();
        let provider = test_provider(TimeoutConfig {
            connect: Some(Duration::from_secs(5)),
            ttfb: Some(Duration::from_secs(5)),
            stream_idle: Some(Duration::from_millis(200)),
            total: Some(Duration::from_secs(10)),
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
            token,
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
        let token = permit.token();

        let client = UpstreamClient::new();
        let provider = test_provider(TimeoutConfig {
            connect: Some(Duration::from_secs(5)),
            ttfb: Some(Duration::from_secs(5)),
            stream_idle: Some(Duration::from_secs(5)),
            total: Some(Duration::from_millis(300)),
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
            token,
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
        let token = permit.token();

        let client = UpstreamClient::new();
        let provider = test_provider(TimeoutConfig {
            connect: Some(Duration::from_secs(2)),
            ttfb: Some(Duration::from_secs(2)),
            stream_idle: Some(Duration::from_secs(2)),
            total: Some(Duration::from_secs(5)),
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
            token,
        )
        .await
        .expect("forward succeeds");

        assert_eq!(resp.status(), StatusCode::OK);
        assert_in_flight(&lim, 1.0);

        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&bytes[..], b"hello");

        wait_for_in_flight_zero(&lim, 1000).await;
    }

    // -----------------------------------------------------------------------
    // None timeouts: all four timeout fields are None. The mock responds
    // normally — no timeout wrapper should fire.
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn timeout_none_skips_wrapper() {
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
        let token = permit.token();

        let client = UpstreamClient::new();
        let provider = test_provider(TimeoutConfig {
            connect: None,
            ttfb: None,
            stream_idle: None,
            total: None,
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
            token,
        )
        .await
        .expect("forward succeeds with no timeouts");

        assert_eq!(resp.status(), StatusCode::OK);
        assert_in_flight(&lim, 1.0);

        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&bytes[..], b"hello");

        wait_for_in_flight_zero(&lim, 1000).await;
    }

    // -----------------------------------------------------------------------
    // total: None — no total deadline. Mock sends body with a delay that
    // would exceed a hypothetical short total timeout, but since total is
    // None, the stream completes successfully.
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn timeout_total_none_no_deadline() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 1024];
            let _ = sock.read(&mut buf).await;
            sock.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
                .await
                .unwrap();
            sock.flush().await.unwrap();
            tokio::time::sleep(Duration::from_millis(400)).await;
            sock.write_all(b"5\r\nhello\r\n0\r\n\r\n").await.unwrap();
            sock.flush().await.unwrap();
            tokio::time::sleep(Duration::from_millis(50)).await;
        });

        let (lim, permit) = make_permit().await;
        let token = permit.token();

        let client = UpstreamClient::new();
        let provider = test_provider(TimeoutConfig {
            connect: Some(Duration::from_secs(2)),
            ttfb: Some(Duration::from_secs(2)),
            stream_idle: Some(Duration::from_secs(2)),
            total: None,
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
            token,
        )
        .await
        .expect("forward succeeds — no total deadline");

        assert_eq!(resp.status(), StatusCode::OK);
        assert_in_flight(&lim, 1.0);

        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&bytes[..], b"hello");

        wait_for_in_flight_zero(&lim, 1000).await;
    }
}

#[cfg(test)]
mod permit_cooldown {
    //! Unit tests for the downstream-disconnect cooldown path in
    //! [`super::forward_with_timeouts`].

    use super::test_helpers::*;
    use super::*;
    use crate::types::TimeoutConfig;
    use hyper::{Method, StatusCode};
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    // Downstream disconnect triggers the cooldown path (`tx.closed()` at line
    // 128 of the production function). The permit must stay held for the
    // cooldown duration and then release.
    #[tokio::test]
    async fn permit_cooldown_holds_after_disconnect() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 1024];
            let _ = sock.read(&mut buf).await;
            // Send headers + one chunk, then stall forever.
            sock.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n")
                .await
                .unwrap();
            sock.flush().await.unwrap();
            tokio::time::sleep(Duration::from_secs(60)).await;
        });

        let (lim, permit) = make_permit().await;
        let token = permit.token();

        let client = UpstreamClient::new();
        let provider = test_provider(TimeoutConfig {
            connect: Some(Duration::from_secs(5)),
            ttfb: Some(Duration::from_secs(5)),
            stream_idle: Some(Duration::from_secs(5)),
            total: Some(Duration::from_secs(60)),
            permit_cooldown: Duration::from_millis(200),
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
            token,
        )
        .await
        .expect("forward succeeds — headers + first chunk arrive");

        assert_eq!(resp.status(), StatusCode::OK);
        assert_in_flight(&lim, 1.0);

        // Downstream disconnect: drop the response body. This closes the mpsc
        // receiver, so the upstream task sees `tx.closed()` and enters the
        // cooldown `select!`.
        drop(resp);

        // Permit must still be held during cooldown (200ms).
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_in_flight(&lim, 1.0);

        // After cooldown elapses, the spawned task returns and the permit
        // drops. `wait_for_in_flight_zero` accounts for async drop latency.
        wait_for_in_flight_zero(&lim, 1000).await;
    }

    // Cancellation token aborts the cooldown early, releasing the permit.
    #[tokio::test]
    async fn kill_during_cooldown_cancels() {
        let (lim, permit) = make_permit().await;
        let token = permit.token();
        assert_in_flight(&lim, 1.0);

        let task_token = token.clone();

        tokio::spawn(async move {
            let _permit = permit;
            let cooldown = Duration::from_millis(500);
            tokio::select! {
                () = tokio::time::sleep(cooldown) => {}
                () = task_token.cancelled() => {}
            }
        });

        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_in_flight(&lim, 1.0);

        token.cancel();
        wait_for_in_flight_zero(&lim, 1000).await;
    }
}

#[cfg(test)]
mod cancellation {
    use super::test_helpers::*;
    use super::*;
    use crate::dashboard::tracker::RequestStatus;
    use crate::types::TimeoutConfig;
    use hyper::{Method, StatusCode};
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    // Cancel mid-stream: the drain loop's token.cancelled() branch fires,
    // the spawned task exits, the permit drops, and capacity is released.
    #[tokio::test]
    async fn cancellation_token_cancelled_aborts_upstream() {
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
            for _ in 0..100 {
                tokio::time::sleep(Duration::from_millis(50)).await;
                let _ = sock.write_all(b"1\r\na\r\n").await;
                let _ = sock.flush().await;
            }
        });

        let (lim, permit) = make_permit().await;
        let token = permit.token();
        let tracker = Arc::clone(permit.tracker());
        let id = permit.request_id();

        let client = UpstreamClient::new();
        let provider = test_provider(TimeoutConfig {
            connect: Some(Duration::from_secs(5)),
            ttfb: Some(Duration::from_secs(5)),
            stream_idle: Some(Duration::from_secs(5)),
            total: Some(Duration::from_secs(60)),
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
            token,
        )
        .await
        .expect("forward succeeds — headers + first chunk arrive");

        assert_eq!(resp.status(), StatusCode::OK);
        assert_in_flight(&lim, 1.0);

        assert!(
            tracker.cancel(id),
            "cancel should return true for live record"
        );

        wait_for_in_flight_zero(&lim, 2000).await;

        let snap = tracker.snapshot();
        let record = snap.iter().find(|r| r.id == id).expect("record exists");
        assert_eq!(
            record.status,
            RequestStatus::Cancelled,
            "record should be Cancelled after tracker.cancel()"
        );
    }

    // Cancel during cooldown: the cooldown select!'s token.cancelled() branch
    // fires, the task exits early, and the permit is released before the
    // cooldown duration elapses.
    #[tokio::test]
    async fn cancellation_during_cooldown_releases_permit() {
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
            tokio::time::sleep(Duration::from_secs(60)).await;
        });

        let (lim, permit) = make_permit().await;
        let token = permit.token();
        let tracker = Arc::clone(permit.tracker());
        let id = permit.request_id();

        let client = UpstreamClient::new();
        let provider = test_provider(TimeoutConfig {
            connect: Some(Duration::from_secs(5)),
            ttfb: Some(Duration::from_secs(5)),
            stream_idle: Some(Duration::from_secs(5)),
            total: Some(Duration::from_secs(60)),
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
            token,
        )
        .await
        .expect("forward succeeds — headers + first chunk arrive");

        assert_eq!(resp.status(), StatusCode::OK);
        assert_in_flight(&lim, 1.0);

        drop(resp);

        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_in_flight(&lim, 1.0);

        assert!(
            tracker.cancel(id),
            "cancel should return true for live record"
        );

        wait_for_in_flight_zero(&lim, 1000).await;

        let snap = tracker.snapshot();
        let record = snap.iter().find(|r| r.id == id).expect("record exists");
        assert_eq!(
            record.status,
            RequestStatus::Cancelled,
            "record should be Cancelled after tracker.cancel()"
        );
    }
}

#[cfg(test)]
#[tokio::test]
async fn ttft_captured_from_first_frame() {
    use crate::types::TimeoutConfig;
    use hyper::StatusCode;
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

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

    let (lim, permit) = test_helpers::make_permit().await;
    let token = permit.token();
    let tracker = Arc::clone(permit.tracker());
    let id = permit.request_id();

    let client = UpstreamClient::new();
    let provider = test_helpers::test_provider(TimeoutConfig {
        connect: Some(Duration::from_secs(2)),
        ttfb: Some(Duration::from_secs(2)),
        stream_idle: Some(Duration::from_secs(2)),
        total: Some(Duration::from_secs(5)),
        ..Default::default()
    });

    let resp = forward_with_timeouts(
        &client,
        &provider,
        Method::GET,
        format!("http://127.0.0.1:{port}/"),
        HeaderMap::new(),
        test_helpers::empty_body(),
        permit,
        token,
    )
    .await
    .expect("forward succeeds");

    assert_eq!(resp.status(), StatusCode::OK);

    let snap = tracker.snapshot();
    let record = snap.iter().find(|r| r.id == id).expect("record exists");
    assert_eq!(
        record.upstream_status,
        Some(200),
        "upstream_status should be captured from first frame"
    );
    assert!(
        record.ttft.is_some(),
        "ttft should be captured from first frame"
    );

    let _ = resp.into_body().collect().await;
    test_helpers::wait_for_in_flight_zero(&lim, 1000).await;
}

#[cfg(test)]
mod token_tap {
    use super::*;
    use bytes::Bytes;

    #[test]
    fn token_tap_openai_stream_with_usage() {
        let mut tap = TokenTap::new(ApiKind::OpenAI, true);

        tap.feed(&Bytes::from(
            r#"data: {"choices":[{"delta":{"content":"Hello"}}]}"#,
        ));
        tap.feed(&Bytes::from("\n\n"));

        // Usage frame split across two chunks (tests line buffer).
        tap.feed(&Bytes::from(r#"data: {"choices":[],"usage":{"prompt_tok"#));
        tap.feed(&Bytes::from(
            r#"ens":12,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":2}}}"#,
        ));
        tap.feed(&Bytes::from("\n\n"));

        tap.feed(&Bytes::from("data: [DONE]\n\n"));

        tap.finish();
        assert_eq!(tap.prompt(), Some(12));
        assert_eq!(tap.completion(), Some(3));
        assert_eq!(tap.cached(), Some(2));
    }

    #[test]
    fn token_tap_openai_stream_without_usage() {
        let mut tap = TokenTap::new(ApiKind::OpenAI, true);

        tap.feed(&Bytes::from(
            r#"data: {"choices":[{"delta":{"content":"Hello"}}]}"#,
        ));
        tap.feed(&Bytes::from("\n\n"));
        tap.feed(&Bytes::from("data: [DONE]\n\n"));

        tap.finish();
        assert_eq!(tap.prompt(), None);
        assert_eq!(tap.completion(), None);
        assert_eq!(tap.cached(), None);
    }

    #[test]
    fn token_tap_openai_stream_with_cached_tokens() {
        let mut tap = TokenTap::new(ApiKind::OpenAI, true);

        tap.feed(&Bytes::from(
            r#"data: {"choices":[{"delta":{"content":"Hello"}}]}"#,
        ));
        tap.feed(&Bytes::from("\n\n"));

        tap.feed(&Bytes::from(
            r#"data: {"id":"chatcmpl-test","choices":[{"index":0,"delta":{}}],"usage":{"prompt_tokens":18,"completion_tokens":50,"prompt_tokens_details":{"cached_tokens":7}}}"#,
        ));
        tap.feed(&Bytes::from("\n\n"));

        tap.feed(&Bytes::from("data: [DONE]\n\n"));

        tap.finish();
        assert_eq!(tap.prompt(), Some(18));
        assert_eq!(tap.completion(), Some(50));
        assert_eq!(tap.cached(), Some(7));
    }

    #[test]
    fn token_tap_openai_stream_no_usage() {
        let mut tap = TokenTap::new(ApiKind::OpenAI, true);

        tap.feed(&Bytes::from(
            r#"data: {"choices":[{"delta":{"content":"Hello"}}]}"#,
        ));
        tap.feed(&Bytes::from("\n\n"));
        tap.feed(&Bytes::from("data: [DONE]\n\n"));

        tap.finish();
        assert_eq!(tap.prompt(), None);
        assert_eq!(tap.completion(), None);
        assert_eq!(tap.cached(), None);
    }

    #[test]
    fn token_tap_anthropic_stream() {
        let mut tap = TokenTap::new(ApiKind::Anthropic, true);

        // message_start: input_tokens=12, cache_read=2 (output_tokens=0 placeholder, ignore).
        tap.feed(&Bytes::from("event: message_start\n"));
        tap.feed(&Bytes::from(
            r#"data: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_read_input_tokens":2,"output_tokens":0}}}"#,
        ));
        tap.feed(&Bytes::from("\n\n"));

        // Content delta (should be skipped).
        tap.feed(&Bytes::from("event: content_block_delta\n"));
        tap.feed(&Bytes::from(
            r#"data: {"type":"content_block_delta","delta":{"text":"Hello"}}"#,
        ));
        tap.feed(&Bytes::from("\n\n"));

        // message_delta: output_tokens=3 (cumulative — overwrite placeholder).
        tap.feed(&Bytes::from("event: message_delta\n"));
        tap.feed(&Bytes::from(
            r#"data: {"type":"message_delta","usage":{"output_tokens":3}}"#,
        ));
        tap.feed(&Bytes::from("\n\n"));

        tap.finish();
        assert_eq!(tap.prompt(), Some(12));
        assert_eq!(tap.completion(), Some(3));
        assert_eq!(tap.cached(), Some(2));
    }

    #[test]
    fn token_tap_anthropic_cache_creation_combined() {
        let mut tap = TokenTap::new(ApiKind::Anthropic, true);

        tap.feed(&Bytes::from("event: message_start\n"));
        tap.feed(&Bytes::from(
            r#"data: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_creation_input_tokens":100,"cache_read_input_tokens":50,"output_tokens":0}}}"#,
        ));
        tap.feed(&Bytes::from("\n\n"));

        tap.feed(&Bytes::from("event: message_delta\n"));
        tap.feed(&Bytes::from(
            r#"data: {"type":"message_delta","usage":{"output_tokens":3}}"#,
        ));
        tap.feed(&Bytes::from("\n\n"));

        tap.finish();
        assert_eq!(tap.prompt(), Some(12));
        assert_eq!(tap.completion(), Some(3));
        assert_eq!(tap.cached(), Some(150));
    }

    #[test]
    fn token_tap_anthropic_message_delta_not_missed() {
        let mut tap = TokenTap::new(ApiKind::Anthropic, true);

        tap.feed(&Bytes::from("event: message_start\n"));
        tap.feed(&Bytes::from(
            r#"data: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_creation_input_tokens":100,"cache_read_input_tokens":50,"output_tokens":0}}}"#,
        ));
        tap.feed(&Bytes::from("\n\n"));

        tap.feed(&Bytes::from("event: message_delta\n"));
        tap.feed(&Bytes::from(
            r#"data: {"type":"message_delta","usage":{"output_tokens":3}}"#,
        ));
        tap.feed(&Bytes::from("\n\n"));

        tap.finish();
        assert_eq!(tap.completion(), Some(3));
        assert_eq!(tap.cached(), Some(150));
    }

    #[test]
    fn token_tap_non_sse() {
        // OpenAI non-SSE.
        {
            let mut tap = TokenTap::new(ApiKind::OpenAI, false);
            let body = r#"{"id":"chatcmpl-1","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":2}}}"#;
            tap.feed(&Bytes::from(body));
            tap.finish();
            assert_eq!(tap.prompt(), Some(12));
            assert_eq!(tap.completion(), Some(3));
            assert_eq!(tap.cached(), Some(2));
        }
        // Anthropic non-SSE.
        {
            let mut tap = TokenTap::new(ApiKind::Anthropic, false);
            let body =
                r#"{"usage":{"input_tokens":12,"output_tokens":3,"cache_read_input_tokens":2}}"#;
            tap.feed(&Bytes::from(body));
            tap.finish();
            assert_eq!(tap.prompt(), Some(12));
            assert_eq!(tap.completion(), Some(3));
            assert_eq!(tap.cached(), Some(2));
        }
    }

    #[test]
    fn token_tap_parse_error_fails_closed() {
        let mut tap = TokenTap::new(ApiKind::OpenAI, true);

        // Malformed JSON in SSE data line.
        tap.feed(&Bytes::from("data: {invalid json}\n\n"));
        // A valid-looking frame with missing usage (should still not set tokens).
        tap.feed(&Bytes::from(r#"data: {"choices":[]}"#));
        tap.feed(&Bytes::from("\n\n"));
        tap.feed(&Bytes::from("data: [DONE]\n\n"));

        tap.finish();
        assert_eq!(tap.prompt(), None);
        assert_eq!(tap.completion(), None);
        assert_eq!(tap.cached(), None);
    }

    #[test]
    fn tps_computed_correctly() {
        use crate::dashboard::tracker::compute_tps;
        use std::time::Duration;

        // 10 tokens in 2 seconds = 5.0 TPS.
        let tps = compute_tps(Some(10), Some(Duration::from_secs(2)));
        assert!(tps.is_some());
        assert!((tps.unwrap() - 5.0).abs() < 0.001);

        // Missing completion_tokens.
        assert_eq!(compute_tps(None, Some(Duration::from_secs(2))), None);

        // Missing streaming_elapsed.
        assert_eq!(compute_tps(Some(10), None), None);

        // Zero elapsed (avoid division by zero).
        assert_eq!(compute_tps(Some(10), Some(Duration::ZERO)), None);
    }
}

#[cfg(test)]
#[tokio::test]
async fn kill_pre_stream_returns_400() {
    use crate::types::TimeoutConfig;
    use std::sync::Arc;
    use std::time::Duration;

    let (lim, permit) = test_helpers::make_permit().await;
    let token = permit.token();
    let tracker = Arc::clone(permit.tracker());
    let id = permit.request_id();

    let client = UpstreamClient::new();
    let provider = test_helpers::test_provider(TimeoutConfig {
        connect: Some(Duration::from_secs(60)),
        ttfb: Some(Duration::from_secs(60)),
        stream_idle: Some(Duration::from_secs(60)),
        total: Some(Duration::from_secs(60)),
        ..Default::default()
    });

    assert!(tracker.cancel(id), "cancel should return true");

    let err = forward_with_timeouts(
        &client,
        &provider,
        Method::GET,
        "http://127.0.0.1:1/".to_string(),
        HeaderMap::new(),
        test_helpers::empty_body(),
        permit,
        token,
    )
    .await
    .unwrap_err();

    assert!(
        matches!(err, GatewayError::Cancelled),
        "expected GatewayError::Cancelled, got: {err:?}"
    );

    test_helpers::assert_in_flight(&lim, 0.0);
}

#[cfg(test)]
#[tokio::test]
async fn kill_in_stream_emits_sse_error_anthropic() {
    use crate::types::TimeoutConfig;
    use hyper::StatusCode;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut buf = vec![0u8; 1024];
        let _ = sock.read(&mut buf).await;
        let sse_data = b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"Hi\"}}\n\n";
        let chunk_header = format!("{:x}\r\n", sse_data.len());
        sock.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").await.unwrap();
        sock.write_all(chunk_header.as_bytes()).await.unwrap();
        sock.write_all(sse_data).await.unwrap();
        sock.write_all(b"\r\n").await.unwrap();
        sock.flush().await.unwrap();
        tokio::time::sleep(Duration::from_secs(60)).await;
    });

    let (lim, permit) = test_helpers::make_permit_with_path("/v1/messages").await;
    let token = permit.token();
    let tracker = Arc::clone(permit.tracker());
    let id = permit.request_id();

    let client = UpstreamClient::new();
    let provider = test_helpers::test_provider(TimeoutConfig {
        connect: Some(Duration::from_secs(5)),
        ttfb: Some(Duration::from_secs(5)),
        stream_idle: Some(Duration::from_secs(5)),
        total: Some(Duration::from_secs(60)),
        ..Default::default()
    });

    let resp = forward_with_timeouts(
        &client,
        &provider,
        Method::GET,
        format!("http://127.0.0.1:{port}/"),
        HeaderMap::new(),
        test_helpers::empty_body(),
        permit,
        token,
    )
    .await
    .expect("forward succeeds — headers + first chunk arrive");

    assert_eq!(resp.status(), StatusCode::OK);
    test_helpers::assert_in_flight(&lim, 1.0);

    assert!(tracker.cancel(id), "cancel should return true");

    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let body = String::from_utf8_lossy(&bytes);

    assert!(
        body.contains("event: error"),
        "Anthropic SSE error frame should contain 'event: error', got: {body}"
    );
    assert!(
        body.contains("\"type\":\"invalid_request_error\""),
        "error frame should use invalid_request_error, got: {body}"
    );
    assert!(
        body.contains("Request killed from umans dashboard"),
        "error frame should contain kill message, got: {body}"
    );

    test_helpers::wait_for_in_flight_zero(&lim, 2000).await;
}

#[cfg(test)]
#[tokio::test]
async fn kill_in_stream_emits_sse_error_openai() {
    use crate::types::TimeoutConfig;
    use hyper::StatusCode;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut buf = vec![0u8; 1024];
        let _ = sock.read(&mut buf).await;
        let sse_data = b"data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n\n";
        let chunk_header = format!("{:x}\r\n", sse_data.len());
        sock.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").await.unwrap();
        sock.write_all(chunk_header.as_bytes()).await.unwrap();
        sock.write_all(sse_data).await.unwrap();
        sock.write_all(b"\r\n").await.unwrap();
        sock.flush().await.unwrap();
        tokio::time::sleep(Duration::from_secs(60)).await;
    });

    let (lim, permit) = test_helpers::make_permit().await;
    let token = permit.token();
    let tracker = Arc::clone(permit.tracker());
    let id = permit.request_id();

    let client = UpstreamClient::new();
    let provider = test_helpers::test_provider(TimeoutConfig {
        connect: Some(Duration::from_secs(5)),
        ttfb: Some(Duration::from_secs(5)),
        stream_idle: Some(Duration::from_secs(5)),
        total: Some(Duration::from_secs(60)),
        ..Default::default()
    });

    let resp = forward_with_timeouts(
        &client,
        &provider,
        Method::GET,
        format!("http://127.0.0.1:{port}/"),
        HeaderMap::new(),
        test_helpers::empty_body(),
        permit,
        token,
    )
    .await
    .expect("forward succeeds — headers + first chunk arrive");

    assert_eq!(resp.status(), StatusCode::OK);
    test_helpers::assert_in_flight(&lim, 1.0);

    assert!(tracker.cancel(id), "cancel should return true");

    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let body = String::from_utf8_lossy(&bytes);

    assert!(
        body.contains("\"type\":\"invalid_request_error\""),
        "OpenAI SSE error frame should use invalid_request_error, got: {body}"
    );
    assert!(
        body.contains("\"finish_reason\":\"error\""),
        "error frame should have finish_reason=error, got: {body}"
    );
    assert!(
        body.contains("data: [DONE]"),
        "error frame should end with [DONE], got: {body}"
    );
    assert!(
        body.contains("Request killed from umans dashboard"),
        "error frame should contain kill message, got: {body}"
    );

    test_helpers::wait_for_in_flight_zero(&lim, 2000).await;
}
