//! Dashboard state types + state store.
//!
//! `ProviderMetric` / `ActiveModel` / `ModelState` are shared with the askama
//! templates (Task 9). `DashboardState` (Task 8) holds a dashmap cache, a
//! `broadcast::Sender` clone, and an `Arc<ProviderLimiter>` for live snapshots.

use std::sync::Arc;

use dashmap::DashMap;
use tokio::sync::broadcast;

use crate::concurrency::{MetricUpdate, ProviderLimiter, ProviderSnapshot};
use crate::dashboard::tracker::{local_offset_label, RequestRecord, RequestTracker};
use crate::types::{ModelId, ProviderId};

/// Aggregated metric for a single provider, rendered by the dashboard.
#[derive(Debug, Clone)]
pub struct ProviderMetric {
    pub provider: ProviderId,
    pub capacity: f32,
    pub in_flight: f32,
    pub active_models: Vec<ActiveModel>,
}

impl ProviderMetric {
    /// Capacity utilization percentage (0–100), clamped. 0 when capacity unset.
    pub fn pct(&self) -> u32 {
        if self.capacity <= 0.0 {
            return 0;
        }
        ((self.in_flight / self.capacity) * 100.0) as u32
    }
}

/// One active model entry within a provider metric.
#[derive(Debug, Clone)]
pub struct ActiveModel {
    pub model: ModelId,
    pub state: ModelState,
    pub count: u32,
}

/// Lifecycle state of a model slot, for dashboard display.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelState {
    Pending,
    Active,
}

impl std::fmt::Display for ModelState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ModelState::Pending => f.write_str("pending"),
            ModelState::Active => f.write_str("active"),
        }
    }
}

/// Shared dashboard state: dashmap cache + broadcast fan-out + limiter ref.
///
/// The broadcast channel is owned by the `ProviderLimiter` (permits need the
/// sender on `Drop`); `DashboardState` reuses it via `limiter.metric_tx()`.
/// `subscribe()` / `metric_tx()` hand out receivers / sender clones to SSE
/// handlers and the concurrency engine.
pub struct DashboardState {
    providers: Arc<DashMap<ProviderId, ProviderMetric>>,
    metric_tx: broadcast::Sender<MetricUpdate>,
    limiter: Arc<ProviderLimiter>,
    tracker: Arc<RequestTracker>,
    /// OS timezone offset label (`[+-]HH.MM`) passed to request templates.
    pub offset_label: String,
    /// Minimum age (seconds) before the Kill button is shown in the UI.
    pub kill_min_age_seconds: u64,
}

impl DashboardState {
    /// Broadcast channel capacity (per research finding bg_3ce8fc2b).
    pub const CHANNEL_CAPACITY: usize = 256;

    /// Bind a dashboard to an existing limiter. The limiter's broadcast channel
    /// is reused — subscribers see every `MetricUpdate` the engine emits.
    pub fn new(limiter: Arc<ProviderLimiter>, kill_min_age_seconds: u64) -> Self {
        let metric_tx = limiter.metric_tx();
        DashboardState {
            providers: Arc::new(DashMap::new()),
            metric_tx,
            limiter,
            tracker: Arc::new(RequestTracker::new()),
            offset_label: local_offset_label(),
            kill_min_age_seconds,
        }
    }

    /// Subscribe to metric update events (for SSE handlers).
    pub fn subscribe(&self) -> broadcast::Receiver<MetricUpdate> {
        self.metric_tx.subscribe()
    }

    /// Snapshot current provider metrics from the limiter; refreshes the cache.
    pub fn snapshot(&self) -> Vec<ProviderMetric> {
        let metrics: Vec<ProviderMetric> = self
            .limiter
            .snapshot()
            .into_iter()
            .map(map_snapshot)
            .collect();
        self.providers.clear();
        for m in &metrics {
            self.providers.insert(m.provider.clone(), m.clone());
        }
        metrics
    }

    /// Clone of the broadcast sender (for the concurrency engine / SSE source).
    pub fn metric_tx(&self) -> broadcast::Sender<MetricUpdate> {
        self.metric_tx.clone()
    }

    /// Shared per-request lifecycle tracker (hooks go inside
    /// `acquire_for_request` in Task 3).
    pub fn tracker(&self) -> &RequestTracker {
        self.tracker.as_ref()
    }

    /// Clone of the tracker `Arc`, for wiring into `ProxyState` / middleware
    /// that need an owned `Arc<RequestTracker>` handle.
    pub fn tracker_arc(&self) -> Arc<RequestTracker> {
        Arc::clone(&self.tracker)
    }

    /// Read-only snapshot of all tracked requests.
    pub fn snapshot_requests(&self) -> Vec<RequestRecord> {
        self.tracker.snapshot()
    }
}

fn map_snapshot(s: ProviderSnapshot) -> ProviderMetric {
    let active_models = s
        .active_models
        .into_iter()
        .map(|(model, count)| ActiveModel {
            model,
            state: ModelState::Active,
            count,
        })
        .collect();
    ProviderMetric {
        provider: s.provider,
        capacity: s.capacity,
        in_flight: s.in_flight,
        active_models,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ModelId, ProviderId, Weight};

    fn make_state(capacity: usize) -> (Arc<ProviderLimiter>, DashboardState) {
        let (tx, _) = broadcast::channel(capacity);
        let limiter = Arc::new(ProviderLimiter::new(tx));
        let dashboard = DashboardState::new(Arc::clone(&limiter), 300);
        (limiter, dashboard)
    }

    #[tokio::test]
    async fn snapshot_returns_current_state() {
        let (limiter, dashboard) = make_state(256);
        let pid = ProviderId::new("openai");
        let mid = ModelId::new("gpt-4");
        limiter.register(
            &pid,
            Weight::from(4.0),
            std::time::Duration::from_secs(30),
            64,
        );

        let _permit = limiter
            .acquire(&pid, &mid, Weight::from(1.0))
            .await
            .unwrap();
        let snap = dashboard.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].provider, pid);
        assert_eq!(snap[0].capacity, 4.0);
        assert_eq!(snap[0].in_flight, 1.0);
        assert_eq!(snap[0].active_models.len(), 1);
        assert_eq!(snap[0].active_models[0].model, mid);
        assert_eq!(snap[0].active_models[0].count, 1);
        assert_eq!(snap[0].active_models[0].state, ModelState::Active);
    }

    #[tokio::test]
    async fn subscribe_receives_updates() {
        let (limiter, dashboard) = make_state(256);
        let pid = ProviderId::new("openai");
        let mid = ModelId::new("gpt-4");
        limiter.register(
            &pid,
            Weight::from(4.0),
            std::time::Duration::from_secs(30),
            64,
        );

        let mut rx = dashboard.subscribe();
        let permit = limiter
            .acquire(&pid, &mid, Weight::from(1.0))
            .await
            .unwrap();

        let acquired = rx.recv().await.expect("receiver closed");
        assert!(
            matches!(acquired, MetricUpdate::Acquired { ref provider, ref model, .. }
                if *provider == pid && *model == mid),
            "expected Acquired, got {:?}",
            acquired
        );

        drop(permit);
        let released = rx.recv().await.expect("receiver closed");
        assert!(
            matches!(released, MetricUpdate::Released { ref provider, ref model, .. }
                if *provider == pid && *model == mid),
            "expected Released, got {:?}",
            released
        );
    }

    #[tokio::test]
    async fn lagged_client_gets_reload() {
        let (limiter, dashboard) = make_state(2);
        let pid = ProviderId::new("openai");
        let mid = ModelId::new("gpt-4");
        limiter.register(
            &pid,
            Weight::from(100.0),
            std::time::Duration::from_secs(30),
            64,
        );

        let mut rx = dashboard.subscribe();
        for _ in 0..10 {
            let _ = limiter.try_acquire(&pid, &mid, Weight::from(1.0)).unwrap();
        }
        match rx.recv().await {
            Err(broadcast::error::RecvError::Lagged(_)) => {}
            other => panic!("expected Lagged, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn snapshot_empty_is_empty() {
        let (_limiter, dashboard) = make_state(256);
        assert!(dashboard.snapshot().is_empty());
    }

    #[test]
    fn metric_tx_returns_working_sender() {
        let (_limiter, dashboard) = make_state(256);
        let tx = dashboard.metric_tx();
        let mut rx = dashboard.subscribe();
        let _ = tx.send(MetricUpdate::Acquired {
            provider: ProviderId::new("openai"),
            model: ModelId::new("gpt-4"),
            weight: Weight::from(1.0),
        });
        let msg = rx.try_recv().expect("subscriber should receive");
        assert!(matches!(msg, MetricUpdate::Acquired { .. }));
    }

    #[tokio::test]
    async fn multiple_subscribers_all_receive() {
        let (limiter, dashboard) = make_state(256);
        let pid = ProviderId::new("openai");
        let mid = ModelId::new("gpt-4");
        limiter.register(
            &pid,
            Weight::from(4.0),
            std::time::Duration::from_secs(30),
            64,
        );

        let mut rx1 = dashboard.subscribe();
        let mut rx2 = dashboard.subscribe();
        let mut rx3 = dashboard.subscribe();

        let _permit = limiter
            .acquire(&pid, &mid, Weight::from(1.0))
            .await
            .unwrap();

        for (i, rx) in [(&mut rx1), (&mut rx2), (&mut rx3)].iter_mut().enumerate() {
            let msg = rx.recv().await.expect("receiver closed");
            assert!(
                matches!(msg, MetricUpdate::Acquired { .. }),
                "subscriber {} got {:?} instead of Acquired",
                i,
                msg
            );
        }
    }
}
