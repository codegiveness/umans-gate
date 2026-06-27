//! Weighted concurrency limiting per AI provider.
//!
//! Zero-race guarantee: a tokio `Semaphore` (permits = capacity in milliunits)
//! is the source of truth. `in_flight_milli` is a `Relaxed`-ordering atomic
//! mirror for the dashboard only — even if it drifts, over-concurrency is
//! impossible because the semaphore enforces the cap atomically.
//!
//! All CAS / semaphore paths use fixed-point `u32` milliunits (`Weight::SCALE`).
//! No float arithmetic in any acquire/release path.

use std::sync::atomic::{AtomicU32, Ordering::Relaxed};
use std::sync::Arc;

use dashmap::DashMap;
use tokio::sync::{broadcast, OwnedSemaphorePermit, Semaphore};
use tracing::debug;

use crate::error::{AcquireError, TryAcquireError};
use crate::types::{ModelId, ProviderId, Weight};

/// Milliunits per weight unit (fixed-point scale).
pub const SCALE: u32 = Weight::SCALE;

/// Metric update broadcast to dashboard SSE subscribers.
///
/// Shared between the concurrency engine (Task 7) and the dashboard state
/// store (Task 8). Cloneable so `broadcast::Sender` can fan it out.
#[derive(Debug, Clone)]
pub enum MetricUpdate {
    /// A weighted permit was acquired.
    Acquired {
        provider: ProviderId,
        model: ModelId,
        weight: Weight,
    },
    /// A weighted permit was released (dropped).
    Released {
        provider: ProviderId,
        model: ModelId,
        weight: Weight,
    },
}

/// Internal per-provider concurrency state.
///
/// `sem` is authoritative; `in_flight_milli` and `active_models` are dashboard
/// mirrors updated with `Relaxed` ordering after a successful semaphore acquire
/// and on permit `Drop`.
#[derive(Debug)]
pub struct ProviderState {
    sem: Arc<Semaphore>,
    capacity_milli: u32,
    in_flight_milli: AtomicU32,
    active_models: DashMap<ModelId, u32>,
}

impl ProviderState {
    fn new(capacity_milli: u32) -> Self {
        ProviderState {
            sem: Arc::new(Semaphore::new(capacity_milli as usize)),
            capacity_milli,
            in_flight_milli: AtomicU32::new(0),
            active_models: DashMap::new(),
        }
    }
}

/// RAII guard holding a weighted concurrency permit.
///
/// Releases on `Drop`: subtracts `weight_milli` from the mirror atomic,
/// decrements the model's active count, and broadcasts `MetricUpdate::Released`.
/// Must be moved into the stream body by the caller (Task 14 enforces this) —
/// this module never holds a permit in a handler scope.
#[derive(Debug)]
pub struct WeightedPermit {
    /// Held for its `Drop` side-effect (releases the semaphore permit).
    #[allow(dead_code)]
    permit: OwnedSemaphorePermit,
    state: Arc<ProviderState>,
    weight_milli: u32,
    model: ModelId,
    provider: ProviderId,
    metric_tx: broadcast::Sender<MetricUpdate>,
}

impl Drop for WeightedPermit {
    fn drop(&mut self) {
        // Mirror atomic release (Relaxed: dashboard-only; sem is authoritative).
        self.state
            .in_flight_milli
            .fetch_sub(self.weight_milli, Relaxed);

        // Decrement active model count; remove entry when it hits zero.
        let should_remove = {
            if let Some(mut entry) = self.state.active_models.get_mut(&self.model) {
                if *entry > 0 {
                    *entry -= 1;
                }
                *entry == 0
            } else {
                false
            }
        };
        if should_remove {
            self.state.active_models.remove(&self.model);
        }

        // Best-effort broadcast — no receivers is not an error.
        let _ = self.metric_tx.send(MetricUpdate::Released {
            provider: self.provider.clone(),
            model: self.model.clone(),
            weight: Weight::from_milliunits(self.weight_milli),
        });

        debug!(
            provider = %self.provider,
            model = %self.model,
            weight_milli = self.weight_milli,
            "permit released"
        );
    }
}

impl WeightedPermit {
    /// Weight held by this permit, in milliunits.
    pub fn weight_milli(&self) -> u32 {
        self.weight_milli
    }

    /// Provider this permit was acquired against.
    pub fn provider(&self) -> &ProviderId {
        &self.provider
    }

    /// Model this permit was acquired for.
    pub fn model(&self) -> &ModelId {
        &self.model
    }
}

/// Point-in-time view of one provider's concurrency state (for the dashboard).
#[derive(Debug, Clone)]
pub struct ProviderSnapshot {
    pub provider: ProviderId,
    pub capacity: f32,
    pub in_flight: f32,
    pub active_models: Vec<(ModelId, u32)>,
}

/// Per-provider weighted concurrency limiter.
///
/// No global aggregate cap — strictly per-provider. Each provider owns an
/// independent `Semaphore` sized to its capacity in milliunits.
pub struct ProviderLimiter {
    providers: DashMap<ProviderId, Arc<ProviderState>>,
    metric_tx: broadcast::Sender<MetricUpdate>,
}

impl ProviderLimiter {
    /// Construct with a broadcast sender shared with the dashboard.
    pub fn new(metric_tx: broadcast::Sender<MetricUpdate>) -> Self {
        ProviderLimiter {
            providers: DashMap::new(),
            metric_tx,
        }
    }

    /// Clone of the broadcast sender (dashboard subscribes / re-shares it).
    pub fn metric_tx(&self) -> broadcast::Sender<MetricUpdate> {
        self.metric_tx.clone()
    }

    /// Register (or replace) a provider with a given capacity.
    pub fn register(&self, provider: &ProviderId, capacity: Weight) {
        let capacity_milli = capacity.to_milliunits().max(1);
        let state = Arc::new(ProviderState::new(capacity_milli));
        self.providers.insert(provider.clone(), state);
    }

    /// Acquire `weight` on `provider` for `model`, waiting if necessary.
    ///
    /// Clamps `weight` to `[1, capacity_milli]` milliunits so a misconfigured
    /// weight can never deadlock (weight 0) nor overflow the semaphore (weight
    /// weight greater than capacity). The semaphore's atomic `acquire_many_owned` is the
    /// zero-race gate.
    pub async fn acquire(
        &self,
        provider: &ProviderId,
        model: &ModelId,
        weight: Weight,
    ) -> Result<WeightedPermit, AcquireError> {
        let state = self
            .providers
            .get(provider)
            .map(|r| Arc::clone(r.value()))
            .ok_or(AcquireError::UnknownProvider)?;

        let weight_milli = weight.to_milliunits().max(1).min(state.capacity_milli);

        let permit = state
            .sem
            .clone()
            .acquire_many_owned(weight_milli)
            .await
            .map_err(|_| AcquireError::Closed)?;

        state.in_flight_milli.fetch_add(weight_milli, Relaxed);
        {
            let mut entry = state.active_models.entry(model.clone()).or_insert(0);
            *entry += 1;
        }

        let _ = self.metric_tx.send(MetricUpdate::Acquired {
            provider: provider.clone(),
            model: model.clone(),
            weight: Weight::from_milliunits(weight_milli),
        });

        Ok(WeightedPermit {
            permit,
            state,
            weight_milli,
            model: model.clone(),
            provider: provider.clone(),
            metric_tx: self.metric_tx.clone(),
        })
    }

    /// Non-blocking acquire: returns `NoCapacity` immediately if full.
    pub fn try_acquire(
        &self,
        provider: &ProviderId,
        model: &ModelId,
        weight: Weight,
    ) -> Result<WeightedPermit, TryAcquireError> {
        let state = self
            .providers
            .get(provider)
            .map(|r| Arc::clone(r.value()))
            .ok_or(TryAcquireError::UnknownProvider)?;

        let weight_milli = weight.to_milliunits().max(1).min(state.capacity_milli);

        let permit = state
            .sem
            .clone()
            .try_acquire_many_owned(weight_milli)
            .map_err(|_| TryAcquireError::NoCapacity)?;

        state.in_flight_milli.fetch_add(weight_milli, Relaxed);
        {
            let mut entry = state.active_models.entry(model.clone()).or_insert(0);
            *entry += 1;
        }

        let _ = self.metric_tx.send(MetricUpdate::Acquired {
            provider: provider.clone(),
            model: model.clone(),
            weight: Weight::from_milliunits(weight_milli),
        });

        Ok(WeightedPermit {
            permit,
            state,
            weight_milli,
            model: model.clone(),
            provider: provider.clone(),
            metric_tx: self.metric_tx.clone(),
        })
    }

    /// Snapshot all providers' mirror state for the dashboard.
    ///
    /// Float values are derived from milliunits here (display-only); no float
    /// touches any acquire/release path.
    pub fn snapshot(&self) -> Vec<ProviderSnapshot> {
        self.providers
            .iter()
            .map(|r| {
                let state = r.value();
                let in_flight_milli = state.in_flight_milli.load(Relaxed);
                let active_models = state
                    .active_models
                    .iter()
                    .map(|e| (e.key().clone(), *e.value()))
                    .collect::<Vec<_>>();
                ProviderSnapshot {
                    provider: r.key().clone(),
                    capacity: state.capacity_milli as f32 / SCALE as f32,
                    in_flight: in_flight_milli as f32 / SCALE as f32,
                    active_models,
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU32;
    use tokio::time::{sleep, Duration};

    /// Build a limiter with a single registered provider of `capacity`.
    fn make_limiter(capacity: f32) -> (ProviderLimiter, broadcast::Sender<MetricUpdate>) {
        let (tx, _rx) = broadcast::channel::<MetricUpdate>(256);
        let lim = ProviderLimiter::new(tx.clone());
        lim.register(&ProviderId::new("test"), Weight::from(capacity));
        (lim, tx)
    }

    #[tokio::test]
    async fn acquire_releases_correctly() {
        let (lim, _tx) = make_limiter(4.0);
        let pid = ProviderId::new("test");
        let mid = ModelId::new("gpt-4");

        let permit = lim.acquire(&pid, &mid, Weight::from(1.0)).await.unwrap();
        let state = lim.providers.get(&pid).unwrap();
        assert_eq!(state.in_flight_milli.load(Relaxed), 1000);
        assert_eq!(state.active_models.get(&mid).map(|e| *e.value()), Some(1));

        drop(permit);
        assert_eq!(state.in_flight_milli.load(Relaxed), 0);
        assert!(state.active_models.get(&mid).is_none());
    }

    #[tokio::test]
    async fn weighted_accounting() {
        let (lim, _tx) = make_limiter(4.0);
        let pid = ProviderId::new("test");
        let mid = ModelId::new("gpt-4");

        let p1 = lim.acquire(&pid, &mid, Weight::from(0.5)).await.unwrap();
        let state = lim.providers.get(&pid).unwrap();
        assert_eq!(state.in_flight_milli.load(Relaxed), 500);

        let p2 = lim.acquire(&pid, &mid, Weight::from(0.5)).await.unwrap();
        assert_eq!(state.in_flight_milli.load(Relaxed), 1000);

        drop(p1);
        assert_eq!(state.in_flight_milli.load(Relaxed), 500);
        drop(p2);
        assert_eq!(state.in_flight_milli.load(Relaxed), 0);
    }

    #[tokio::test]
    async fn concurrent_no_overcommit() {
        // Zero-race proof: 100 tasks, capacity 4.0 → max concurrent never > 4.
        let (lim, _tx) = make_limiter(4.0);
        let pid = ProviderId::new("test");
        let mid = ModelId::new("gpt-4");

        let current = Arc::new(AtomicU32::new(0));
        let max_seen = Arc::new(AtomicU32::new(0));
        let total_acquired = Arc::new(AtomicU32::new(0));

        let mut handles = Vec::with_capacity(100);
        for _ in 0..100 {
            let lim = Arc::new(lim.clone_shallow());
            let pid = pid.clone();
            let mid = mid.clone();
            let current = Arc::clone(&current);
            let max_seen = Arc::clone(&max_seen);
            let total_acquired = Arc::clone(&total_acquired);
            handles.push(tokio::spawn(async move {
                let permit = lim.acquire(&pid, &mid, Weight::from(1.0)).await.unwrap();
                let cur = current.fetch_add(1, Relaxed) + 1;
                // CAS-loop to track the running maximum.
                loop {
                    let prev = max_seen.load(Relaxed);
                    if cur <= prev || max_seen.compare_exchange(prev, cur, Relaxed, Relaxed).is_ok()
                    {
                        break;
                    }
                }
                total_acquired.fetch_add(1, Relaxed);
                sleep(Duration::from_millis(10)).await;
                current.fetch_sub(1, Relaxed);
                drop(permit);
            }));
        }

        for h in handles {
            h.await.unwrap();
        }

        assert_eq!(total_acquired.load(Relaxed), 100, "all tasks acquired");
        assert!(
            max_seen.load(Relaxed) <= 4,
            "max concurrent {} exceeded capacity 4",
            max_seen.load(Relaxed)
        );
    }

    #[tokio::test]
    async fn try_acquire_rejects_when_full() {
        let (lim, _tx) = make_limiter(1.0);
        let pid = ProviderId::new("test");
        let mid = ModelId::new("gpt-4");

        // Fill the only 1000 milliunits of capacity.
        let p1 = lim.try_acquire(&pid, &mid, Weight::from(1.0)).unwrap();
        // Second non-blocking acquire must fail.
        let err = lim.try_acquire(&pid, &mid, Weight::from(1.0)).unwrap_err();
        assert!(matches!(err, TryAcquireError::NoCapacity));

        drop(p1);
        // After release, try_acquire succeeds again.
        let _p2 = lim.try_acquire(&pid, &mid, Weight::from(1.0)).unwrap();
    }

    #[tokio::test]
    async fn permit_drop_on_disconnect() {
        // Simulate a client disconnect by dropping the permit early.
        let (lim, _tx) = make_limiter(4.0);
        let pid = ProviderId::new("test");
        let mid = ModelId::new("gpt-4");

        let state = lim.providers.get(&pid).unwrap();
        {
            let _permit = lim.acquire(&pid, &mid, Weight::from(1.0)).await.unwrap();
            assert_eq!(state.in_flight_milli.load(Relaxed), 1000);
            // Dropped here — simulates disconnect.
        }
        assert_eq!(state.in_flight_milli.load(Relaxed), 0);
        assert!(state.active_models.get(&mid).is_none());
    }

    #[tokio::test]
    async fn unknown_provider_returns_error() {
        let (lim, _tx) = make_limiter(4.0);
        let ghost = ProviderId::new("ghost");
        let mid = ModelId::new("gpt-4");

        let err = lim.acquire(&ghost, &mid, Weight::from(1.0)).await.unwrap_err();
        assert!(matches!(err, AcquireError::UnknownProvider));

        let err = lim.try_acquire(&ghost, &mid, Weight::from(1.0)).unwrap_err();
        assert!(matches!(err, TryAcquireError::UnknownProvider));
    }

    #[tokio::test]
    async fn snapshot_reflects_state() {
        let (lim, _tx) = make_limiter(4.0);
        let pid = ProviderId::new("test");
        let mid = ModelId::new("gpt-4");

        let p = lim.acquire(&pid, &mid, Weight::from(1.5)).await.unwrap();
        let snaps = lim.snapshot();
        assert_eq!(snaps.len(), 1);
        let s = &snaps[0];
        assert_eq!(s.provider, pid);
        assert!((s.capacity - 4.0).abs() < 1e-6);
        assert!((s.in_flight - 1.5).abs() < 1e-6);
        assert_eq!(s.active_models.len(), 1);
        assert_eq!(s.active_models[0].0, mid);
        assert_eq!(s.active_models[0].1, 1);

        drop(p);
        let snaps = lim.snapshot();
        assert!((snaps[0].in_flight - 0.0).abs() < 1e-6);
        assert!(snaps[0].active_models.is_empty());
    }

    #[tokio::test]
    async fn broadcast_receives_acquired_and_released() {
        let (tx, mut rx) = broadcast::channel::<MetricUpdate>(256);
        let lim = ProviderLimiter::new(tx);
        lim.register(&ProviderId::new("test"), Weight::from(4.0));
        let pid = ProviderId::new("test");
        let mid = ModelId::new("gpt-4");

        let permit = lim.acquire(&pid, &mid, Weight::from(1.0)).await.unwrap();
        let acquired = rx.recv().await.unwrap();
        assert!(matches!(
            acquired,
            MetricUpdate::Acquired { .. }
        ));

        drop(permit);
        let released = rx.recv().await.unwrap();
        assert!(matches!(
            released,
            MetricUpdate::Released { .. }
        ));
    }

    #[test]
    fn types_send_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<ProviderLimiter>();
        assert_send_sync::<ProviderState>();
        assert_send_sync::<MetricUpdate>();
        assert_send_sync::<ProviderSnapshot>();
        // WeightedPermit needs Send (moved across tasks) but not necessarily Sync.
        fn assert_send<T: Send>() {}
        assert_send::<WeightedPermit>();
    }
}

/// Shallow clone helper for tests: shares the underlying DashMap / sender.
///
/// `ProviderLimiter` is not `Clone` in production (it owns its DashMap); tests
/// that spawn many tasks each need an owned handle to the same map. This gives
/// them one by cloning the `Arc`-internal state. Test-only.
#[cfg(test)]
impl ProviderLimiter {
    fn clone_shallow(&self) -> ProviderLimiter {
        // Re-wrap: build a new DashMap sharing the same Arc<ProviderState> values
        // and the same broadcast sender.
        let new_map = DashMap::new();
        for r in self.providers.iter() {
            new_map.insert(r.key().clone(), Arc::clone(r.value()));
        }
        ProviderLimiter {
            providers: new_map,
            metric_tx: self.metric_tx.clone(),
        }
    }
}
