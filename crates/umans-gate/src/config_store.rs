//! Config hot-reload: arc-swap for wait-free reads + notify for file watching.
//!
//! [`ConfigStore`] wraps an `ArcSwap<GatewayConfig>` for wait-free reads and
//! holds a reference to the [`ProviderLimiter`] for semaphore recreation on
//! reload.
//!
//! # CRITICAL: load-once-per-request
//!
//! [`ConfigStore::load`] MUST be called ONCE per request and the returned
//! [`Guard`] held for the entire request lifecycle. Calling `load()` multiple
//! times within one request may return different config versions (a hot-reload
//! could land between calls), leading to mismatched provider lookups and
//! weights. Tasks 12 and 17 enforce this by pinning the Guard at the handler
//! entry and passing `&GatewayConfig` to downstream code.

#![cfg(feature = "hot-reload")]

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use arc_swap::{ArcSwap, Guard};
use notify_debouncer_mini::{new_debouncer, notify::RecursiveMode};
use tracing::{error, info, warn};

use crate::concurrency::ProviderLimiter;
use crate::error::GatewayError;
use crate::types::GatewayConfig;

/// Hot-reloadable config store with wait-free reads.
///
/// The `watch` method runs as a background task that reloads the config file
/// on change, validates it, and atomically swaps in the new version while
/// recreating provider semaphores. Invalid configs are rejected — last known
/// good is always retained.
pub struct ConfigStore {
    inner: ArcSwap<GatewayConfig>,
    limiter: Arc<ProviderLimiter>,
}

impl ConfigStore {
    /// Create a new store, registering all providers from `initial` in the limiter.
    pub fn new(initial: GatewayConfig, limiter: Arc<ProviderLimiter>) -> Self {
        let store = ConfigStore {
            inner: ArcSwap::from_pointee(initial),
            limiter,
        };
        let cfg = store.load();
        for p in &cfg.providers {
            store.limiter.register(
                &p.id,
                p.capacity,
                p.timeouts.queuetimeout,
                p.timeouts.maxqueue,
            );
        }
        store
    }

    /// Wait-free read. Returns a [`Guard`] that pins the current config version.
    ///
    /// See the [module docs](self) for the load-once-per-request contract.
    pub fn load(&self) -> Guard<Arc<GatewayConfig>> {
        self.inner.load()
    }

    /// Watch the config file for changes, reloading on debounce (500 ms).
    ///
    /// Runs forever (until the task is cancelled or the debouncer errors).
    /// On each debounced change:
    /// 1. Reloads via [`GatewayConfig::load`] (figment + validation).
    /// 2. On success: recreates provider semaphores + stores the new config.
    /// 3. On failure: logs the error and keeps the last known good config.
    pub async fn watch(self: Arc<Self>, path: PathBuf) -> anyhow::Result<()> {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();

        let mut debouncer = new_debouncer(Duration::from_millis(500), move |_result| {
            let _ = tx.send(());
        })?;

        debouncer
            .watcher()
            .watch(&path, RecursiveMode::NonRecursive)?;

        info!(path = %path.display(), "watching config for changes");

        loop {
            if rx.recv().await.is_none() {
                break;
            }
            match GatewayConfig::load(&path) {
                Ok(new_config) => {
                    if let Err(e) = self.reload(new_config) {
                        error!(error = %e, "reloaded config invalid; keeping last known good");
                    }
                }
                Err(e) => {
                    error!(error = %e, "config reload failed; keeping last known good");
                }
            }
        }
        Ok(())
    }

    /// Validate and apply a new config. On success, recreates provider
    /// semaphores and stores the new config atomically. On validation
    /// failure, returns the error and does NOT store.
    fn reload(&self, config: GatewayConfig) -> Result<(), GatewayError> {
        config.validate()?;
        self.recreate_providers(&config);
        self.inner.store(Arc::new(config));
        info!("config reloaded successfully");
        Ok(())
    }

    /// Recreate provider semaphores for a new config.
    ///
    /// - Registers (overwrites) all providers in the new config via
    ///   [`ProviderLimiter::register`] — DashMap insert overwrites the old
    ///   `ProviderState`, but the old semaphore stays alive via held
    ///   `Arc<ProviderState>` refs (in-flight permits).
    /// - Closes semaphores for providers removed from the old config via
    ///   [`ProviderLimiter::remove_provider`] — queued waiters get
    ///   [`AcquireError::Closed`](crate::error::AcquireError::Closed).
    /// - In-flight permits survive: they hold their own `Arc<ProviderState>`,
    ///   keeping the old semaphore alive until `Drop`.
    fn recreate_providers(&self, config: &GatewayConfig) {
        let old = self.load();
        let old_ids: HashSet<_> = old.providers.iter().map(|p| &p.id).collect();
        let new_ids: HashSet<_> = config.providers.iter().map(|p| &p.id).collect();

        for p in &config.providers {
            self.limiter.register(
                &p.id,
                p.capacity,
                p.timeouts.queuetimeout,
                p.timeouts.maxqueue,
            );
        }

        for removed_id in old_ids {
            if !new_ids.contains(removed_id) {
                self.limiter.remove_provider(removed_id);
                warn!(provider = %removed_id, "removed provider; semaphore closed");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::concurrency::MetricUpdate;
    use crate::error::{AcquireError, TryAcquireError};
    use crate::types::{ModelConfig, ModelId, ProviderConfig, ProviderId, TimeoutConfig, Weight};
    use std::net::SocketAddr;
    use tokio::sync::broadcast;
    use url::Url;

    fn make_config(capacity: Weight) -> GatewayConfig {
        GatewayConfig {
            providers: vec![ProviderConfig {
                id: ProviderId::new("test"),
                upstream_url: Url::parse("https://example.com").unwrap(),
                capacity,
                models: vec![ModelConfig {
                    id: ModelId::new("gpt-4"),
                    weight: Weight::from(1.0),
                }],
                timeouts: TimeoutConfig::default(),
            }],
            bind: "0.0.0.0:8080".parse::<SocketAddr>().unwrap(),
            dashboard_bind: "0.0.0.0:9090".parse::<SocketAddr>().unwrap(),
            dashboard: None,
            models_info_url: String::new(),
        }
    }

    fn make_store(capacity: Weight) -> (ConfigStore, Arc<ProviderLimiter>) {
        let (tx, _rx) = broadcast::channel::<MetricUpdate>(256);
        let limiter = Arc::new(ProviderLimiter::new(tx));
        let config = make_config(capacity);
        let store = ConfigStore::new(config, Arc::clone(&limiter));
        (store, limiter)
    }

    #[tokio::test]
    async fn hot_reload_updates_capacity() {
        let (store, limiter) = make_store(Weight::from(4.0));
        let pid = ProviderId::new("test");
        let mid = ModelId::new("gpt-4");

        // Old capacity 4.0: fill it.
        let mut old_permits = Vec::new();
        for _ in 0..4 {
            old_permits.push(
                limiter
                    .acquire(&pid, &mid, Weight::from(1.0))
                    .await
                    .unwrap(),
            );
        }
        assert!(limiter.try_acquire(&pid, &mid, Weight::from(1.0)).is_err());

        // Reload with capacity 8.0.
        store.reload(make_config(Weight::from(8.0))).unwrap();

        // New semaphore has 8.0 capacity, all free.
        let mut new_permits = Vec::new();
        for _ in 0..8 {
            new_permits.push(
                limiter
                    .acquire(&pid, &mid, Weight::from(1.0))
                    .await
                    .unwrap(),
            );
        }
        assert!(limiter.try_acquire(&pid, &mid, Weight::from(1.0)).is_err());

        // Old permits release to old sem, new to new sem — no panic.
        drop(old_permits);
        drop(new_permits);
    }

    #[tokio::test]
    async fn in_flight_permit_survives_reload() {
        let (store, limiter) = make_store(Weight::from(4.0));
        let pid = ProviderId::new("test");
        let mid = ModelId::new("gpt-4");

        let old_permit = limiter
            .acquire(&pid, &mid, Weight::from(1.0))
            .await
            .unwrap();

        // Reload to capacity 2.0.
        store.reload(make_config(Weight::from(2.0))).unwrap();

        // New semaphore has capacity 2.0 → can acquire 2.
        let new_p1 = limiter
            .acquire(&pid, &mid, Weight::from(1.0))
            .await
            .unwrap();
        let new_p2 = limiter
            .acquire(&pid, &mid, Weight::from(1.0))
            .await
            .unwrap();
        assert!(limiter.try_acquire(&pid, &mid, Weight::from(1.0)).is_err());

        // Drop old permit — releases to OLD semaphore, not new. No panic.
        drop(old_permit);

        // New semaphore still full (old permit released to old sem).
        assert!(limiter.try_acquire(&pid, &mid, Weight::from(1.0)).is_err());

        drop(new_p1);
        drop(new_p2);
    }

    #[test]
    fn invalid_config_keeps_last_good() {
        let (store, _limiter) = make_store(Weight::from(4.0));

        let initial = store.load();
        assert_eq!(initial.providers.len(), 1);
        assert_eq!(initial.providers[0].capacity.to_milliunits(), 4000);
        drop(initial);

        // Attempt reload with invalid config (empty providers).
        let invalid = GatewayConfig {
            providers: vec![],
            bind: "0.0.0.0:8080".parse::<SocketAddr>().unwrap(),
            dashboard_bind: "0.0.0.0:9090".parse::<SocketAddr>().unwrap(),
            dashboard: None,
            models_info_url: String::new(),
        };
        let err = store.reload(invalid).unwrap_err();
        assert!(matches!(err, GatewayError::Validation(_)));

        // Store still has last good config.
        let current = store.load();
        assert_eq!(current.providers.len(), 1);
        assert_eq!(current.providers[0].capacity.to_milliunits(), 4000);
    }

    #[tokio::test]
    async fn removed_provider_closes_semaphore() {
        let (store, limiter) = make_store(Weight::from(4.0));
        let pid = ProviderId::new("test");
        let mid = ModelId::new("gpt-4");

        // Fill capacity so the waiter will block on the old semaphore.
        let p1 = limiter
            .acquire(&pid, &mid, Weight::from(4.0))
            .await
            .unwrap();

        let lim_clone = Arc::clone(&limiter);
        let pid_clone = pid.clone();
        let mid_clone = mid.clone();
        let handle = tokio::spawn(async move {
            lim_clone
                .acquire(&pid_clone, &mid_clone, Weight::from(1.0))
                .await
        });

        // Give the waiter time to start waiting.
        tokio::time::sleep(Duration::from_millis(50)).await;

        // Reload with config that removes "test" provider.
        let new_config = GatewayConfig {
            providers: vec![ProviderConfig {
                id: ProviderId::new("other"),
                upstream_url: Url::parse("https://example.com").unwrap(),
                capacity: Weight::from(2.0),
                models: vec![],
                timeouts: TimeoutConfig::default(),
            }],
            bind: "0.0.0.0:8080".parse::<SocketAddr>().unwrap(),
            dashboard_bind: "0.0.0.0:9090".parse::<SocketAddr>().unwrap(),
            dashboard: None,
            models_info_url: String::new(),
        };
        store.reload(new_config).unwrap();

        // The queued waiter should get AcquireError::Closed.
        let result = handle.await.unwrap();
        assert!(matches!(result, Err(AcquireError::Closed)));

        // "test" provider no longer registered.
        let err = limiter
            .try_acquire(&pid, &mid, Weight::from(1.0))
            .unwrap_err();
        assert!(matches!(err, TryAcquireError::UnknownProvider));

        // In-flight permit on old sem is still valid — no panic on drop.
        drop(p1);
    }

    #[test]
    fn load_once_per_request() {
        let (store, _limiter) = make_store(Weight::from(4.0));

        // Simulate a request: load ONCE, hold the Guard for the entire lifecycle.
        let config = store.load();

        // Multiple reads from the same Guard — consistent view.
        assert_eq!(config.providers.len(), 1);
        assert_eq!(config.providers[0].capacity.to_milliunits(), 4000);

        // Guard drops here — request complete.
        // Calling load() again might return a different version if a reload
        // happened in between — that is why load() must be called ONCE.
    }
}
