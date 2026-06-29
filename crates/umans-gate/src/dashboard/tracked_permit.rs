//! RAII guard that wraps a [`WeightedPermit`] and notifies a
//! [`RequestTracker`] when the permit is dropped.
//!
//! `TrackedPermit` is returned by `acquire_for_request` (Task 3). The tracker
//! has already been transitioned Queued -> Running by the time the guard is
//! constructed. On `Drop` the guard calls `tracker.mark_done(id)`, completing the
//! lifecycle (Running -> Done). If the guard is dropped during unwinding
//! (panic), `Drop` still runs — `mark_done` is a simple DashMap update and is
//! panic-safe.
//!
//! `Deref<Target = WeightedPermit>` lets callers use the guard transparently
//! where a `&WeightedPermit` is expected.

use std::ops::Deref;
use std::sync::Arc;

use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::concurrency::WeightedPermit;
use crate::dashboard::tracker::RequestTracker;

/// RAII guard: owns a [`WeightedPermit`] and marks the request Done on Drop.
#[derive(Debug)]
pub struct TrackedPermit {
    permit: WeightedPermit,
    id: Uuid,
    tracker: Arc<RequestTracker>,
    cancellation_token: CancellationToken,
}

impl TrackedPermit {
    /// Wrap a `WeightedPermit` with tracking. The caller must have already
    /// called `tracker.register_queued(id, ...)` and `tracker.mark_running(id)`.
    /// `cancellation_token` should be cloned from the `RequestRecord` created by
    /// `register_queued`.
    pub fn new(
        permit: WeightedPermit,
        id: Uuid,
        tracker: Arc<RequestTracker>,
        cancellation_token: CancellationToken,
    ) -> Self {
        TrackedPermit {
            permit,
            id,
            tracker,
            cancellation_token,
        }
    }

    /// The request UUID this guard tracks.
    pub fn id(&self) -> Uuid {
        self.id
    }

    /// The request UUID this guard tracks (alias for callers that need to
    /// record the upstream protocol without owning the permit).
    pub fn request_id(&self) -> Uuid {
        self.id
    }

    /// Borrow the tracker so callers can record the upstream protocol before
    /// the permit is moved into the body stream.
    pub fn tracker(&self) -> &Arc<RequestTracker> {
        &self.tracker
    }

    /// Clone the request's cancellation token. Clones share cancellation state
    /// — cancelling one cancels all. Used by `forward_with_timeouts` to add a
    /// `token.cancelled()` branch in the stream drain and cooldown `select!`s.
    pub fn token(&self) -> CancellationToken {
        self.cancellation_token.clone()
    }
}

impl Drop for TrackedPermit {
    fn drop(&mut self) {
        // If the record is already terminal, do not transition it again. The
        // underlying WeightedPermit still drops, releasing capacity exactly once.
        if self.tracker.is_terminal(self.id) {
            return;
        }
        // Panic-safe: mark_done is a DashMap get_mut + field assignment.
        // Runs during unwinding, so it must not panic.
        self.tracker.mark_done(self.id);
    }
}

impl Deref for TrackedPermit {
    type Target = WeightedPermit;

    fn deref(&self) -> &WeightedPermit {
        &self.permit
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::concurrency::{MetricUpdate, ProviderLimiter};
    use crate::dashboard::tracker::{ProtocolVersion, RequestStatus};
    use crate::types::{ModelId, ProviderId, Weight};
    use tokio::sync::broadcast;

    async fn make_permit_and_tracker(
    ) -> (Arc<ProviderLimiter>, Arc<RequestTracker>, TrackedPermit, Uuid) {
        let (tx, _rx) = broadcast::channel::<MetricUpdate>(256);
        let lim = Arc::new(ProviderLimiter::new(tx));
        lim.register(
            &ProviderId::new("test"),
            Weight::from(4.0),
            std::time::Duration::from_secs(30),
            64,
        );
        let permit = lim
            .acquire(
                &ProviderId::new("test"),
                &ModelId::new("gpt-4"),
                Weight::from(1.0),
            )
            .await
            .unwrap();

        let tracker = Arc::new(RequestTracker::new());
        let id = Uuid::new_v4();
        tracker.register_queued(
            id,
            &ProviderId::new("test"),
            &ModelId::new("gpt-4"),
            Weight::from(1.0),
            ProtocolVersion::Http11,
            "/v1/chat/completions".to_string(),
        );
        tracker.mark_running(id, Some(ProtocolVersion::Http11));

        let token = tracker
            .cancellation_token(id)
            .unwrap_or_else(CancellationToken::new);
        let tracked = TrackedPermit::new(permit, id, Arc::clone(&tracker), token);
        (lim, tracker, tracked, id)
    }

    #[tokio::test]
    async fn drop_calls_mark_done() {
        let (_lim, tracker, permit, _id) = make_permit_and_tracker().await;

        // While the guard is alive, status is Running.
        assert_eq!(
            tracker.snapshot()[0].status,
            RequestStatus::Running,
            "request should be Running while permit is held"
        );

        // Drop the guard — mark_done must be called.
        drop(permit);

        let snap = tracker.snapshot();
        assert_eq!(snap.len(), 1, "entry should still exist after drop");
        assert_eq!(
            snap[0].status,
            RequestStatus::Done,
            "drop should transition Running -> Done"
        );
        assert!(
            snap[0].completed_at.is_some(),
            "completed_at should be set on Done"
        );
    }

    #[tokio::test]
    async fn deref_exposes_weighted_permit() {
        let (_lim, _tracker, permit, _id) = make_permit_and_tracker().await;

        // Deref gives access to WeightedPermit methods.
        assert_eq!(permit.weight_milli(), 1000);
        assert_eq!(permit.provider(), &ProviderId::new("test"));
        assert_eq!(permit.model(), &ModelId::new("gpt-4"));
    }

    #[tokio::test]
    async fn drop_during_unwinding_still_marks_done() {
        let (_lim, tracker, permit, _id) = make_permit_and_tracker().await;

        // Simulate a panic that drops the guard during unwinding.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = permit;
            panic!("simulated failure");
        }));
        assert!(result.is_err());

        // The guard was dropped during unwinding — mark_done must have run.
        let snap = tracker.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(
            snap[0].status,
            RequestStatus::Done,
            "Drop must run during unwinding and call mark_done"
        );
    }

    #[tokio::test]
    async fn mark_cancelled_sets_status_and_releases_permit() {
        let (lim, tracker, permit, id) = make_permit_and_tracker().await;

        assert_eq!(
            tracker.snapshot()[0].status,
            RequestStatus::Running,
            "request should be Running while permit is held"
        );

        tracker.mark_cancelled(id);
        assert_eq!(
            tracker.snapshot()[0].status,
            RequestStatus::Cancelled,
            "mark_cancelled should transition Running -> Cancelled"
        );
        assert!(
            tracker.snapshot()[0].completed_at.is_some(),
            "completed_at should be set on Cancelled"
        );

        // Drop releases the weighted permit once and keeps status Cancelled.
        drop(permit);
        let snap = tracker.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].status, RequestStatus::Cancelled);
        assert_eq!(
            lim.snapshot()[0].in_flight, 0.0,
            "weighted capacity should be released exactly once"
        );
    }

    #[tokio::test]
    async fn mark_done_after_cancelled_is_noop() {
        let (lim, tracker, permit, id) = make_permit_and_tracker().await;

        tracker.mark_cancelled(id);
        tracker.mark_done(id);

        let snap = tracker.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(
            snap[0].status,
            RequestStatus::Cancelled,
            "mark_done after Cancelled should be a no-op"
        );

        drop(permit);
        assert_eq!(
            lim.snapshot()[0].in_flight, 0.0,
            "weighted capacity should be released exactly once"
        );
    }

    #[tokio::test]
    async fn drop_after_cancelled_is_noop() {
        let (lim, tracker, permit, id) = make_permit_and_tracker().await;

        tracker.mark_cancelled(id);

        // Drop must not re-transition an already-terminal record.
        drop(permit);

        let snap = tracker.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(
            snap[0].status,
            RequestStatus::Cancelled,
            "Drop should not transition an already-Cancelled record"
        );
        assert_eq!(
            lim.snapshot()[0].in_flight, 0.0,
            "weighted capacity should be released exactly once"
        );
    }
}
