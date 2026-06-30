//! Concurrency gating Tower layer — RAII permit moved into the response stream.
//!
//! Task 14. A weighted permit is acquired per request and moved into the
//! response body stream so it drops only when the stream ends (response
//! complete) or the consumer drops it (client disconnect). The handler never
//! retains the permit, preventing capacity leaks past the response lifetime.
//!
//! Two RAII carriers are provided:
//! - [`permit_guarded_stream`] — the canonical `async_stream::stream!` block:
//!   the permit is captured by the generator and dropped on stream end or drop.
//! - [`PermitBody`] — the poll-based hyper `Body` equivalent for the Tower
//!   middleware: it co-holds the permit and the inner boxed body, releasing the
//!   permit when the body is dropped.
//!
//! The critical acceptance is the RAII-permit-inside-stream pattern (see tests).

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use async_stream::stream;
use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use http_body_util::combinators::BoxBody;
use http_body_util::BodyExt;
use hyper::body::{Body, Frame};
use tower::{Layer, Service};

use uuid::Uuid;

use crate::concurrency::ProviderLimiter;
use crate::dashboard::tracked_permit::TrackedPermit;
use crate::dashboard::tracker::{ProtocolVersion, RequestTracker};
use crate::error::GatewayError;
use crate::types::{ModelId, ProviderId, Weight};

/// Boxed response body used by the proxy (matches Task 13 upstream convention).
pub type BoxedBody = BoxBody<Bytes, hyper::Error>;

/// Acquire a weighted permit for an incoming request.
///
/// Implements haproxy-style queue protection:
/// 1. **maxqueue gate** — if the number of requests already waiting in the
///    acquire queue is at or above `maxqueue`, return immediately with
///    [`GatewayError::ConcurrencyLimit`] (503) instead of queueing further.
/// 2. **queuetimeout** — wrap the semaphore `acquire` in
///    [`tokio::time::timeout`] so a saturated provider returns 503 after
///    `queuetimeout` rather than blocking indefinitely.
///
/// The queue-depth counter is incremented before `acquire` and decremented
/// after it resolves (success or failure). It tracks *waiting* requests only;
/// the returned [`WeightedPermit`] does not hold the counter. The caller MUST
/// move the permit into the response body stream (e.g. via
/// [`permit_guarded_stream`] or by wrapping the body in [`PermitBody`]).
pub async fn acquire_for_request(
    limiter: &Arc<ProviderLimiter>,
    tracker: &Arc<RequestTracker>,
    provider: &ProviderId,
    model: &ModelId,
    weight: Weight,
    client_protocol: ProtocolVersion,
    path: String,
) -> Result<TrackedPermit, GatewayError> {
    let request_id = Uuid::new_v4();
    tracker.register_queued(request_id, provider, model, weight, client_protocol, path);

    if !limiter.try_increment_queue_depth(provider) {
        tracing::debug!(provider = %provider, "queue depth exceeded maxqueue");
        tracker.mark_rejected(request_id);
        return Err(GatewayError::ConcurrencyLimit {
            provider: provider.to_string(),
        });
    }

    let queuetimeout = limiter.queuetimeout(provider);
    let result = tokio::time::timeout(queuetimeout, limiter.acquire(provider, model, weight)).await;

    limiter.decrement_queue_depth(provider);

    match result {
        Ok(Ok(permit)) => {
            // If the request was killed while queued, the record is already
            // terminal (Cancelled). Drop the permit (releases capacity since
            // TrackedPermit::Drop skips mark_done when terminal) and return
            // the 400 kill response.
            if tracker.is_terminal(request_id) {
                let token = tracker.cancellation_token(request_id).unwrap_or_default();
                let _ = TrackedPermit::new(permit, request_id, Arc::clone(tracker), token);
                return Err(GatewayError::Cancelled);
            }
            tracker.mark_running(request_id, None);
            let token = tracker.cancellation_token(request_id).unwrap_or_default();
            Ok(TrackedPermit::new(
                permit,
                request_id,
                Arc::clone(tracker),
                token,
            ))
        }
        Ok(Err(err)) => {
            tracing::debug!(provider = %provider, error = %err, "concurrency acquire failed");
            tracker.mark_rejected(request_id);
            Err(GatewayError::ConcurrencyLimit {
                provider: provider.to_string(),
            })
        }
        Err(_) => {
            tracing::debug!(provider = %provider, queuetimeout = ?queuetimeout, "queue timeout");
            tracker.mark_rejected(request_id);
            Err(GatewayError::ConcurrencyLimit {
                provider: provider.to_string(),
            })
        }
    }
}

/// Wrap an item stream with a permit guard that lives for the stream's lifetime.
///
/// `permit` is moved into the returned `async_stream::stream!` block and dropped
/// when the block ends (inner stream exhausted) or the consumer drops the stream
/// (client disconnect). The handler binding is consumed by this call — the
/// permit is no longer in handler scope, only in the stream.
///
/// This is the canonical RAII-permit-inside-stream building block; the Tower
/// middleware uses [`PermitBody`] (the `Body`-side equivalent) for poll-driven
/// response bodies.
pub fn permit_guarded_stream<S, B, E>(
    permit: TrackedPermit,
    inner: S,
) -> Pin<Box<dyn Stream<Item = Result<B, E>> + Send>>
where
    S: Stream<Item = Result<B, E>> + Send + 'static,
    B: Send + 'static,
    E: Send + 'static,
{
    Box::pin(stream! {
        // Moved here; dropped when the generator ends or is dropped.
        let _guard = permit;
        let mut inner = std::pin::pin!(inner);
        while let Some(item) = inner.next().await {
            yield item;
        }
    })
}

/// Request types carrying concurrency routing info.
///
/// Implemented by the proxy handler (Task 17) to expose the provider/model
/// extracted from the route and the model's weight from config. The middleware
/// uses it to acquire the permit before delegating to the inner service.
pub trait ConcurrencyRequest {
    /// Provider id resolved from the route.
    fn provider(&self) -> &ProviderId;
    /// Model id resolved from the route / request body.
    fn model(&self) -> &ModelId;
    /// Weight of `model` from the provider config.
    fn weight(&self) -> Weight;
    /// Client HTTP protocol version. Defaults to HTTP/1.1 (the proxy is
    /// HTTP/1.1 only).
    fn client_protocol(&self) -> ProtocolVersion {
        ProtocolVersion::Http11
    }
    /// Normalized upstream path used to identify the API family.
    fn path(&self) -> &str {
        "/"
    }
}

/// Tower layer that acquires a weighted concurrency permit per request and
/// binds it to the response body stream (via [`PermitBody`]).
#[derive(Clone)]
pub struct ConcurrencyLayer {
    limiter: Arc<ProviderLimiter>,
    tracker: Arc<RequestTracker>,
}

impl ConcurrencyLayer {
    /// Construct from the shared limiter and request tracker.
    pub fn new(limiter: Arc<ProviderLimiter>, tracker: Arc<RequestTracker>) -> Self {
        ConcurrencyLayer { limiter, tracker }
    }
}

impl<S> Layer<S> for ConcurrencyLayer {
    type Service = ConcurrencyMiddleware<S>;

    fn layer(&self, inner: S) -> Self::Service {
        ConcurrencyMiddleware {
            inner,
            limiter: Arc::clone(&self.limiter),
            tracker: Arc::clone(&self.tracker),
        }
    }
}

/// Service wrapper produced by [`ConcurrencyLayer`].
///
/// On each call it acquires a permit (queueing if necessary), delegates to the
/// inner service, then wraps the response body in [`PermitBody`] so the permit
/// is released when the body is dropped (response complete or client disconnect).
#[derive(Clone)]
pub struct ConcurrencyMiddleware<S> {
    inner: S,
    limiter: Arc<ProviderLimiter>,
    tracker: Arc<RequestTracker>,
}

impl<R, S> Service<R> for ConcurrencyMiddleware<S>
where
    R: ConcurrencyRequest + Send + 'static,
    S: Service<R, Response = hyper::Response<BoxedBody>, Error = GatewayError>
        + Clone
        + Send
        + 'static,
    S::Future: Send + 'static,
{
    type Response = hyper::Response<BoxedBody>;
    type Error = GatewayError;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: R) -> Self::Future {
        // Standard tower clone-and-replace: call takes &mut self, but the future
        // needs an owned inner service. A fresh clone replaces `self.inner` so
        // the next request sees a ready service while this one is in flight.
        let clone = self.inner.clone();
        let mut inner = std::mem::replace(&mut self.inner, clone);
        let limiter = Arc::clone(&self.limiter);
        let tracker = Arc::clone(&self.tracker);
        Box::pin(async move {
            let provider = req.provider().clone();
            let model = req.model().clone();
            let weight = req.weight();
            let client_protocol = req.client_protocol();
            let path = req.path().to_string();
            let permit = acquire_for_request(
                &limiter,
                &tracker,
                &provider,
                &model,
                weight,
                client_protocol,
                path,
            )
            .await?;
            let resp = inner.call(req).await?;
            let (parts, body) = resp.into_parts();
            let permit_body = PermitBody {
                permit,
                inner: body,
            };
            Ok(hyper::Response::from_parts(parts, permit_body.boxed()))
        })
    }
}

/// A response body that owns a [`WeightedPermit`] for its entire lifetime.
///
/// The permit drops when this body is dropped (response complete or client
/// disconnect), releasing concurrency capacity. Frame polling is delegated to
/// the inner boxed body; the permit is held purely for its `Drop` side-effect.
///
/// This is the `Body`-side equivalent of [`permit_guarded_stream`] for the
/// poll-driven hyper body model. Tower/hyper bodies are poll-based (not async
/// streams), so the permit is co-held with the body rather than inside a
/// `stream!` generator; the RAII guarantee is identical.
pub struct PermitBody {
    #[allow(dead_code)]
    permit: TrackedPermit,
    inner: BoxedBody,
}

impl Body for PermitBody {
    type Data = Bytes;
    type Error = hyper::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        // `PermitBody` is `Unpin` (all fields `Unpin`); `get_mut` is sound.
        let this = self.get_mut();
        Pin::new(&mut this.inner).poll_frame(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::concurrency::MetricUpdate;
    use crate::dashboard::tracker::RequestStatus;
    use crate::types::{ModelId, ProviderId, Weight};
    use futures_util::StreamExt;
    use http_body_util::Full;
    use tokio::sync::broadcast;
    use tokio::time::Duration;

    fn make_limiter(capacity: f32) -> Arc<ProviderLimiter> {
        make_limiter_with_queue(capacity, Duration::from_secs(30), 64)
    }

    fn make_limiter_with_queue(
        capacity: f32,
        queuetimeout: Duration,
        maxqueue: usize,
    ) -> Arc<ProviderLimiter> {
        let (tx, _rx) = broadcast::channel::<MetricUpdate>(256);
        let lim = Arc::new(ProviderLimiter::new(tx));
        lim.register(
            &ProviderId::new("test"),
            Weight::from(capacity),
            queuetimeout,
            maxqueue,
        );
        lim
    }

    fn make_tracker() -> Arc<RequestTracker> {
        Arc::new(RequestTracker::new())
    }

    fn assert_in_flight(lim: &ProviderLimiter, pid: &ProviderId, expected: f32) {
        let snap = lim
            .snapshot()
            .into_iter()
            .find(|s| &s.provider == pid)
            .expect("provider registered");
        assert!(
            (snap.in_flight - expected).abs() < 1e-6,
            "in_flight {} != {}",
            snap.in_flight,
            expected
        );
    }

    fn pid_mid() -> (ProviderId, ModelId) {
        (ProviderId::new("test"), ModelId::new("gpt-4"))
    }

    #[tokio::test]
    async fn permit_releases_on_stream_complete() {
        let lim = make_limiter(1.0);
        let tracker = make_tracker();
        let (pid, mid) = pid_mid();

        let permit = acquire_for_request(
            &lim,
            &tracker,
            &pid,
            &mid,
            Weight::from(1.0),
            ProtocolVersion::Http11,
            "/v1/chat/completions".to_string(),
        )
        .await
        .unwrap();
        assert_in_flight(&lim, &pid, 1.0);

        let stream = permit_guarded_stream(
            permit,
            futures_util::stream::iter([Ok::<&str, ()>("a"), Ok("b"), Ok("c")]),
        );
        let collected: Vec<Result<&str, ()>> = stream.collect().await;
        assert_eq!(collected, vec![Ok("a"), Ok("b"), Ok("c")]);

        assert_in_flight(&lim, &pid, 0.0);
    }

    #[tokio::test]
    async fn permit_releases_on_client_disconnect() {
        let lim = make_limiter(1.0);
        let tracker = make_tracker();
        let (pid, mid) = pid_mid();

        let permit = acquire_for_request(
            &lim,
            &tracker,
            &pid,
            &mid,
            Weight::from(1.0),
            ProtocolVersion::Http11,
            "/v1/chat/completions".to_string(),
        )
        .await
        .unwrap();
        assert_in_flight(&lim, &pid, 1.0);

        let mut stream = permit_guarded_stream(
            permit,
            futures_util::stream::iter([Ok::<&str, ()>("a"), Ok("b"), Ok("c")]),
        );

        let first = stream.next().await;
        assert_eq!(first, Some(Ok("a")));
        assert_in_flight(&lim, &pid, 1.0);

        drop(stream);
        assert_in_flight(&lim, &pid, 0.0);
    }

    #[tokio::test]
    async fn permit_not_in_handler_scope() {
        let lim = make_limiter(1.0);
        let tracker = make_tracker();
        let (pid, mid) = pid_mid();

        let permit = acquire_for_request(
            &lim,
            &tracker,
            &pid,
            &mid,
            Weight::from(1.0),
            ProtocolVersion::Http11,
            "/v1/chat/completions".to_string(),
        )
        .await
        .unwrap();
        assert_in_flight(&lim, &pid, 1.0);

        let stream = permit_guarded_stream(permit, futures_util::stream::iter([Ok::<(), ()>(())]));

        assert_in_flight(&lim, &pid, 1.0);

        drop(stream);
        assert_in_flight(&lim, &pid, 0.0);
    }

    #[tokio::test]
    async fn acquire_blocks_when_full() {
        let lim = make_limiter(2.0);
        let tracker = make_tracker();
        let (pid, mid) = pid_mid();

        let p1 = acquire_for_request(
            &lim,
            &tracker,
            &pid,
            &mid,
            Weight::from(1.0),
            ProtocolVersion::Http11,
            "/v1/chat/completions".to_string(),
        )
        .await
        .unwrap();
        let p2 = acquire_for_request(
            &lim,
            &tracker,
            &pid,
            &mid,
            Weight::from(1.0),
            ProtocolVersion::Http11,
            "/v1/chat/completions".to_string(),
        )
        .await
        .unwrap();
        assert_in_flight(&lim, &pid, 2.0);

        let mut queued = Box::pin(acquire_for_request(
            &lim,
            &tracker,
            &pid,
            &mid,
            Weight::from(1.0),
            ProtocolVersion::Http11,
            "/v1/chat/completions".to_string(),
        ));
        let blocked = tokio::time::timeout(Duration::from_millis(50), &mut queued).await;
        assert!(blocked.is_err(), "acquire should block when full");
        assert_in_flight(&lim, &pid, 2.0);

        drop(p1);
        let permit = tokio::time::timeout(Duration::from_secs(1), &mut queued)
            .await
            .expect("queued acquire should complete after freeing capacity")
            .unwrap();
        assert_in_flight(&lim, &pid, 2.0);

        drop(permit);
        drop(p2);
        assert_in_flight(&lim, &pid, 0.0);
    }

    #[tokio::test]
    async fn middleware_acquires_and_releases_permit() {
        let lim = make_limiter(2.0);
        let tracker = make_tracker();
        let (pid, mid) = pid_mid();

        #[derive(Clone)]
        struct EchoSvc;
        impl<R: ConcurrencyRequest> Service<R> for EchoSvc {
            type Response = hyper::Response<BoxedBody>;
            type Error = GatewayError;
            type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

            fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
                Poll::Ready(Ok(()))
            }

            fn call(&mut self, _req: R) -> Self::Future {
                Box::pin(async {
                    let body = Full::new(Bytes::from_static(b"ok"))
                        .map_err(|e: std::convert::Infallible| -> hyper::Error { match e {} })
                        .boxed();
                    Ok(hyper::Response::new(body))
                })
            }
        }

        struct Req(ProviderId, ModelId, Weight);
        impl ConcurrencyRequest for Req {
            fn provider(&self) -> &ProviderId {
                &self.0
            }
            fn model(&self) -> &ModelId {
                &self.1
            }
            fn weight(&self) -> Weight {
                self.2
            }
        }

        let layer = ConcurrencyLayer::new(Arc::clone(&lim), Arc::clone(&tracker));
        let mut svc = layer.layer(EchoSvc);

        let resp = svc
            .call(Req(pid.clone(), mid.clone(), Weight::from(1.0)))
            .await
            .unwrap();
        assert_in_flight(&lim, &pid, 1.0);

        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(bytes, Bytes::from_static(b"ok"));
        assert_in_flight(&lim, &pid, 0.0);
    }

    #[tokio::test]
    async fn acquire_maps_unknown_provider_to_concurrency_limit() {
        let lim = make_limiter(1.0);
        let tracker = make_tracker();
        let ghost = ProviderId::new("ghost");
        let mid = ModelId::new("gpt-4");

        let err = acquire_for_request(
            &lim,
            &tracker,
            &ghost,
            &mid,
            Weight::from(1.0),
            ProtocolVersion::Http11,
            "/v1/chat/completions".to_string(),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, GatewayError::ConcurrencyLimit { provider } if provider == "ghost"));
    }

    #[tokio::test]
    async fn queue_timeout_fires() {
        let lim = make_limiter_with_queue(1.0, Duration::from_secs(1), 64);
        let tracker = make_tracker();
        let (pid, mid) = pid_mid();

        let permit_a = acquire_for_request(
            &lim,
            &tracker,
            &pid,
            &mid,
            Weight::from(1.0),
            ProtocolVersion::Http11,
            "/v1/chat/completions".to_string(),
        )
        .await
        .unwrap();
        assert_in_flight(&lim, &pid, 1.0);

        let lim2 = Arc::clone(&lim);
        let tracker2 = Arc::clone(&tracker);
        let pid2 = pid.clone();
        let mid2 = mid.clone();
        let start = std::time::Instant::now();
        let result = acquire_for_request(
            &lim2,
            &tracker2,
            &pid2,
            &mid2,
            Weight::from(1.0),
            ProtocolVersion::Http11,
            "/v1/chat/completions".to_string(),
        )
        .await;
        let elapsed = start.elapsed();

        assert!(result.is_err(), "second request should fail");
        assert!(
            elapsed >= Duration::from_millis(900) && elapsed <= Duration::from_millis(1500),
            "timeout should fire ~1s, got {:?}",
            elapsed
        );
        let err = result.unwrap_err();
        assert!(matches!(err, GatewayError::ConcurrencyLimit { .. }));

        drop(permit_a);
        assert_in_flight(&lim, &pid, 0.0);
    }

    #[tokio::test]
    async fn maxqueue_rejects() {
        let lim = make_limiter_with_queue(1.0, Duration::from_secs(30), 1);
        let tracker = make_tracker();
        let (pid, mid) = pid_mid();

        let _permit_a = acquire_for_request(
            &lim,
            &tracker,
            &pid,
            &mid,
            Weight::from(1.0),
            ProtocolVersion::Http11,
            "/v1/chat/completions".to_string(),
        )
        .await
        .unwrap();

        let lim_b = Arc::clone(&lim);
        let tracker_b = Arc::clone(&tracker);
        let pid_b = pid.clone();
        let mid_b = mid.clone();
        let b_handle = tokio::spawn(async move {
            acquire_for_request(
                &lim_b,
                &tracker_b,
                &pid_b,
                &mid_b,
                Weight::from(1.0),
                ProtocolVersion::Http11,
                "/v1/chat/completions".to_string(),
            )
            .await
        });

        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(lim.queue_depth(&pid), 1, "B should be queued");

        let start = std::time::Instant::now();
        let result = acquire_for_request(
            &lim,
            &tracker,
            &pid,
            &mid,
            Weight::from(1.0),
            ProtocolVersion::Http11,
            "/v1/chat/completions".to_string(),
        )
        .await;
        let elapsed = start.elapsed();

        assert!(result.is_err(), "C should be immediately rejected");
        assert!(
            elapsed < Duration::from_millis(50),
            "rejection should be immediate, took {:?}",
            elapsed
        );
        assert!(matches!(
            result.unwrap_err(),
            GatewayError::ConcurrencyLimit { .. }
        ));

        b_handle.abort();
    }

    #[tokio::test]
    async fn permit_released_after_completion() {
        let lim = make_limiter(1.0);
        let tracker = make_tracker();
        let (pid, mid) = pid_mid();

        {
            let _permit = acquire_for_request(
                &lim,
                &tracker,
                &pid,
                &mid,
                Weight::from(1.0),
                ProtocolVersion::Http11,
                "/v1/chat/completions".to_string(),
            )
            .await
            .unwrap();
            assert_in_flight(&lim, &pid, 1.0);
        }

        assert_in_flight(&lim, &pid, 0.0);

        let permit2 = acquire_for_request(
            &lim,
            &tracker,
            &pid,
            &mid,
            Weight::from(1.0),
            ProtocolVersion::Http11,
            "/v1/chat/completions".to_string(),
        )
        .await
        .expect("second acquire after RAII release should succeed");
        drop(permit2);
        assert_in_flight(&lim, &pid, 0.0);
    }

    #[tokio::test]
    async fn counter_no_leak_on_timeout() {
        let lim = make_limiter_with_queue(1.0, Duration::from_millis(100), 10);
        let tracker = make_tracker();
        let (pid, mid) = pid_mid();

        let _permit_a = acquire_for_request(
            &lim,
            &tracker,
            &pid,
            &mid,
            Weight::from(1.0),
            ProtocolVersion::Http11,
            "/v1/chat/completions".to_string(),
        )
        .await
        .unwrap();

        let lim_b = Arc::clone(&lim);
        let tracker_b = Arc::clone(&tracker);
        let pid_b = pid.clone();
        let mid_b = mid.clone();
        let b_handle = tokio::spawn(async move {
            acquire_for_request(
                &lim_b,
                &tracker_b,
                &pid_b,
                &mid_b,
                Weight::from(1.0),
                ProtocolVersion::Http11,
                "/v1/chat/completions".to_string(),
            )
            .await
        });

        let _ = tokio::time::timeout(Duration::from_millis(200), b_handle).await;
        assert_eq!(
            lim.queue_depth(&pid),
            0,
            "depth should be 0 after B timed out"
        );

        let start = std::time::Instant::now();
        let result = acquire_for_request(
            &lim,
            &tracker,
            &pid,
            &mid,
            Weight::from(1.0),
            ProtocolVersion::Http11,
            "/v1/chat/completions".to_string(),
        )
        .await;
        let elapsed = start.elapsed();

        assert!(result.is_err(), "C should fail (A still holds)");
        assert!(
            elapsed >= Duration::from_millis(90),
            "C should have been queued (not immediately rejected), took {:?}",
            elapsed
        );
        assert!(matches!(
            result.unwrap_err(),
            GatewayError::ConcurrencyLimit { .. }
        ));
    }

    #[tokio::test]
    async fn tracker_marks_rejected_on_maxqueue() {
        let lim = make_limiter_with_queue(1.0, Duration::from_secs(30), 1);
        let tracker = make_tracker();
        let (pid, mid) = pid_mid();

        let _permit_a = acquire_for_request(
            &lim,
            &tracker,
            &pid,
            &mid,
            Weight::from(1.0),
            ProtocolVersion::Http11,
            "/v1/chat/completions".to_string(),
        )
        .await
        .unwrap();

        let lim_b = Arc::clone(&lim);
        let tracker_b = Arc::clone(&tracker);
        let pid_b = pid.clone();
        let mid_b = mid.clone();
        let b_handle = tokio::spawn(async move {
            acquire_for_request(
                &lim_b,
                &tracker_b,
                &pid_b,
                &mid_b,
                Weight::from(1.0),
                ProtocolVersion::Http11,
                "/v1/chat/completions".to_string(),
            )
            .await
        });

        tokio::time::sleep(Duration::from_millis(50)).await;

        let result = acquire_for_request(
            &lim,
            &tracker,
            &pid,
            &mid,
            Weight::from(1.0),
            ProtocolVersion::Http11,
            "/v1/chat/completions".to_string(),
        )
        .await;
        assert!(result.is_err());

        let snap = tracker.snapshot();
        let rejected: Vec<_> = snap
            .iter()
            .filter(|r| r.status == RequestStatus::Rejected)
            .collect();
        assert!(
            !rejected.is_empty(),
            "at least one request should be Rejected"
        );

        b_handle.abort();
    }

    #[tokio::test]
    async fn tracker_marks_done_on_permit_drop() {
        let lim = make_limiter(1.0);
        let tracker = make_tracker();
        let (pid, mid) = pid_mid();

        let permit = acquire_for_request(
            &lim,
            &tracker,
            &pid,
            &mid,
            Weight::from(1.0),
            ProtocolVersion::Http11,
            "/v1/chat/completions".to_string(),
        )
        .await
        .unwrap();

        let running = tracker
            .snapshot()
            .iter()
            .filter(|r| r.status == RequestStatus::Running)
            .count();
        assert_eq!(running, 1, "request should be Running while permit held");

        drop(permit);

        let done = tracker
            .snapshot()
            .iter()
            .filter(|r| r.status == RequestStatus::Done)
            .count();
        assert_eq!(done, 1, "request should be Done after permit drop");
    }
}
