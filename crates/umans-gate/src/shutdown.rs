//! Graceful shutdown: watch-based signal broadcast + drain logic.
//!
//! Provides:
//! - [`ShutdownSignal`]: coordinates shutdown via `tokio::sync::watch`.
//! - [`ShutdownToken`]: lightweight cloneable handle to trigger shutdown.
//! - [`ShutdownKind`]: which signal triggered the shutdown.
//! - [`install`]: spawns OS signal handlers (SIGINT/SIGTERM/SIGQUIT).
//! - [`ShutdownSignal::drain`]: waits for signal, polls active requests
//!   until zero or timeout, returns [`std::process::ExitCode`].

use std::process::ExitCode;
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;

/// Which signal triggered shutdown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum ShutdownKind {
    /// No shutdown requested yet.
    None = 0,
    /// SIGINT (ctrl_c) — fast 5s drain.
    SigInt = 1,
    /// SIGTERM — full drain (default 30s).
    SigTerm = 2,
    /// SIGQUIT — immediate force exit.
    SigQuit = 3,
}

impl ShutdownKind {
    /// Drain timeout for this signal kind, falling back to `default` for
    /// [`ShutdownKind::None`] and [`ShutdownKind::SigTerm`].
    pub fn drain_timeout(self, default: Duration) -> Duration {
        match self {
            ShutdownKind::SigInt => Duration::from_secs(5),
            ShutdownKind::SigQuit => Duration::ZERO,
            ShutdownKind::SigTerm | ShutdownKind::None => default,
        }
    }
}

/// Lightweight cloneable handle to trigger graceful shutdown.
///
/// Created via [`ShutdownSignal::token`]. Holds a clone of the underlying
/// `watch::Sender<bool>` — calling [`signal`](ShutdownToken::signal)
/// propagates `true` to all watchers.
#[derive(Clone)]
pub struct ShutdownToken {
    tx: watch::Sender<bool>,
}

impl ShutdownToken {
    /// Signal all watchers to begin graceful shutdown.
    pub fn signal(&self) {
        let _ = self.tx.send(true);
    }
}

/// Graceful shutdown coordinator.
///
/// Uses a `tokio::sync::watch` channel to broadcast the shutdown flag.
/// Signal handlers (installed via [`install`]) set the kind and send
/// `true`; the drain logic polls active requests until zero or the
/// kind-specific timeout elapses.
pub struct ShutdownSignal {
    tx: watch::Sender<bool>,
    drain_timeout: Duration,
    /// Which signal triggered shutdown — used to select drain timeout.
    kind: Arc<AtomicU8>,
}

impl ShutdownSignal {
    /// Create a new shutdown signal with the given drain timeout.
    ///
    /// The `drain_timeout` is the default (SIGTERM) timeout. SIGINT uses
    /// a shorter 5s timeout; SIGQUIT uses zero (immediate).
    ///
    /// Returns the signal and a receiver to pass to [`drain`](Self::drain).
    pub fn new(drain_timeout: Duration) -> (Self, watch::Receiver<bool>) {
        let (tx, rx) = watch::channel(false);
        (
            Self {
                tx,
                drain_timeout,
                kind: Arc::new(AtomicU8::new(ShutdownKind::None as u8)),
            },
            rx,
        )
    }

    /// Signal graceful shutdown (sets watch to `true`).
    pub fn signal(&self) {
        let _ = self.tx.send(true);
    }

    /// Returns a lightweight token that can trigger shutdown from anywhere.
    pub fn token(&self) -> ShutdownToken {
        ShutdownToken {
            tx: self.tx.clone(),
        }
    }

    /// Returns the configured drain timeout (SIGTERM default).
    pub fn drain_timeout(&self) -> Duration {
        self.drain_timeout
    }

    /// Returns which signal triggered shutdown.
    pub fn kind(&self) -> ShutdownKind {
        match self.kind.load(Ordering::Relaxed) {
            1 => ShutdownKind::SigInt,
            2 => ShutdownKind::SigTerm,
            3 => ShutdownKind::SigQuit,
            _ => ShutdownKind::None,
        }
    }

    /// Returns the effective drain timeout based on which signal fired.
    ///
    /// SIGINT → 5s, SIGTERM → `drain_timeout`, SIGQUIT → 0s (immediate).
    pub fn effective_timeout(&self) -> Duration {
        self.kind().drain_timeout(self.drain_timeout)
    }

    /// Async helper: wait until a shutdown signal is received.
    ///
    /// Subscribes to the watch channel and blocks until `true` is sent
    /// or the sender is dropped.
    pub async fn watch_for_shutdown(&self) {
        let mut rx = self.tx.subscribe();
        if !*rx.borrow() {
            let _ = rx.changed().await;
        }
    }

    /// Drain active requests after a shutdown signal.
    ///
    /// Waits for the watch to become `true` (or sender drop), then polls
    /// `active_requests` until it reaches 0 or `timeout` elapses.
    ///
    /// - `timeout == Duration::ZERO` → immediate `FAILURE` (SIGQUIT path).
    /// - All requests drained → `SUCCESS`.
    /// - Timeout with remaining requests → `FAILURE`.
    pub async fn drain(
        rx: &mut watch::Receiver<bool>,
        timeout: Duration,
        active_requests: Arc<AtomicU64>,
    ) -> ExitCode {
        // Wait for shutdown signal (or sender drop)
        while !*rx.borrow() {
            if rx.changed().await.is_err() {
                break; // sender dropped — proceed with drain
            }
        }

        let active = active_requests.load(Ordering::Relaxed);
        tracing::info!(active, ?timeout, "drain starting");

        if timeout.is_zero() {
            tracing::warn!(active, "immediate shutdown — skipping drain");
            return ExitCode::FAILURE;
        }

        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let current = active_requests.load(Ordering::Relaxed);
            if current == 0 {
                tracing::info!("drain complete — 0 active requests");
                return ExitCode::SUCCESS;
            }
            if tokio::time::Instant::now() >= deadline {
                tracing::warn!(current, "drain timed out — requests still active");
                return ExitCode::FAILURE;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

/// Install OS signal handlers for graceful shutdown.
///
/// Spawns tokio tasks:
/// - `ctrl_c()` (SIGINT): sets kind + signals watch. Caller should use 5s drain.
/// - `SIGTERM` (Unix only): sets kind + signals watch. Caller should use `drain_timeout`.
/// - `SIGQUIT` (Unix only): sets kind + signals watch. Caller should use 0s (immediate).
///
/// Must be called from within a tokio runtime context.
pub fn install(shutdown: &Arc<ShutdownSignal>) {
    // SIGINT (ctrl_c) — fast 5s drain
    let sig = shutdown.clone();
    tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            tracing::info!("SIGINT received — fast drain 5s");
            sig.kind
                .store(ShutdownKind::SigInt as u8, Ordering::Relaxed);
            sig.signal();
        }
    });

    #[cfg(unix)]
    {
        // SIGTERM — full drain (drain_timeout, default 30s)
        let sig = shutdown.clone();
        tokio::spawn(async move {
            let mut s =
                match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                    Ok(s) => s,
                    Err(e) => {
                        tracing::error!(%e, "failed to install SIGTERM handler");
                        return;
                    }
                };
            s.recv().await;
            tracing::info!(timeout = ?sig.drain_timeout, "SIGTERM received");
            sig.kind
                .store(ShutdownKind::SigTerm as u8, Ordering::Relaxed);
            sig.signal();
        });

        // SIGQUIT — immediate force exit
        let sig = shutdown.clone();
        tokio::spawn(async move {
            let mut s = match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::quit()) {
                Ok(s) => s,
                Err(e) => {
                    tracing::error!(%e, "failed to install SIGQUIT handler");
                    return;
                }
            };
            s.recv().await;
            tracing::warn!("SIGQUIT received — immediate force exit");
            sig.kind
                .store(ShutdownKind::SigQuit as u8, Ordering::Relaxed);
            sig.signal();
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn watch_signal_propagation() {
        let (sig, mut rx) = ShutdownSignal::new(Duration::from_secs(30));
        assert!(!*rx.borrow(), "watch should start false");

        sig.signal();

        // changed() resolves — value already updated
        assert!(rx.changed().await.is_ok());
        assert!(*rx.borrow(), "watch should be true after signal");
    }

    #[tokio::test]
    async fn token_triggers_signal() {
        let (sig, mut rx) = ShutdownSignal::new(Duration::from_secs(30));
        let token = sig.token();

        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            token.signal();
        });

        assert!(rx.changed().await.is_ok());
        assert!(*rx.borrow());
    }

    #[tokio::test]
    async fn drain_succeeds_when_no_active_requests() {
        let (sig, mut rx) = ShutdownSignal::new(Duration::from_secs(5));
        let active = Arc::new(AtomicU64::new(0));

        sig.signal();
        let _ = ShutdownSignal::drain(&mut rx, Duration::from_secs(5), active.clone()).await;

        // Success: active_requests was already 0
        assert_eq!(active.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn drain_waits_then_succeeds_when_requests_reach_zero() {
        let (sig, mut rx) = ShutdownSignal::new(Duration::from_secs(5));
        let active = Arc::new(AtomicU64::new(3));

        // Decrement to 0 after 100ms
        let active_clone = active.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            active_clone.fetch_sub(3, Ordering::Relaxed);
        });

        sig.signal();
        let _ = ShutdownSignal::drain(&mut rx, Duration::from_secs(5), active.clone()).await;

        // Drain waited and succeeded
        assert_eq!(active.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn drain_times_out_with_remaining_requests() {
        let (sig, mut rx) = ShutdownSignal::new(Duration::from_secs(30));
        let active = Arc::new(AtomicU64::new(5)); // never reaches 0

        sig.signal();
        let start = tokio::time::Instant::now();
        let _ = ShutdownSignal::drain(&mut rx, Duration::from_millis(200), active.clone()).await;
        let elapsed = start.elapsed();

        // Timeout: requests still active
        assert_eq!(active.load(Ordering::Relaxed), 5);
        assert!(
            elapsed >= Duration::from_millis(150),
            "should wait at least ~200ms before timing out, got {:?}",
            elapsed
        );
    }

    #[tokio::test]
    async fn drain_immediate_failure_on_zero_timeout() {
        let (sig, mut rx) = ShutdownSignal::new(Duration::from_secs(30));
        let active = Arc::new(AtomicU64::new(10));

        sig.signal();
        let start = tokio::time::Instant::now();
        let _ = ShutdownSignal::drain(&mut rx, Duration::ZERO, active.clone()).await;
        let elapsed = start.elapsed();

        // Immediate: requests unchanged, minimal elapsed time
        assert_eq!(active.load(Ordering::Relaxed), 10);
        assert!(
            elapsed < Duration::from_millis(50),
            "should return immediately, took {:?}",
            elapsed
        );
    }

    #[tokio::test]
    async fn drain_waits_for_signal_before_polling() {
        let (sig, mut rx) = ShutdownSignal::new(Duration::from_secs(5));
        let active = Arc::new(AtomicU64::new(0));

        // Signal after a delay — drain should wait
        let token = sig.token();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            token.signal();
        });

        let start = tokio::time::Instant::now();
        let _ = ShutdownSignal::drain(&mut rx, Duration::from_secs(5), active).await;
        let elapsed = start.elapsed();

        assert!(
            elapsed >= Duration::from_millis(80),
            "drain should wait for signal, took {:?}",
            elapsed
        );
    }

    #[tokio::test]
    async fn drain_handles_sender_drop() {
        let active = Arc::new(AtomicU64::new(0));
        let (tx, mut rx) = watch::channel(false);

        // Drop sender — drain should proceed (sender drop = shutdown)
        drop(tx);

        let start = tokio::time::Instant::now();
        let _ = ShutdownSignal::drain(&mut rx, Duration::from_secs(5), active).await;
        let elapsed = start.elapsed();

        // Should return quickly (active=0 → success path)
        assert!(elapsed < Duration::from_millis(50));
    }

    #[test]
    fn kind_determines_timeout() {
        let default = Duration::from_secs(30);
        assert_eq!(
            ShutdownKind::SigInt.drain_timeout(default),
            Duration::from_secs(5)
        );
        assert_eq!(
            ShutdownKind::SigTerm.drain_timeout(default),
            Duration::from_secs(30)
        );
        assert_eq!(ShutdownKind::SigQuit.drain_timeout(default), Duration::ZERO);
        assert_eq!(
            ShutdownKind::None.drain_timeout(default),
            Duration::from_secs(30)
        );
    }

    #[tokio::test]
    async fn effective_timeout_reflects_kind() {
        let (sig, _rx) = ShutdownSignal::new(Duration::from_secs(30));

        // None → default
        assert_eq!(sig.effective_timeout(), Duration::from_secs(30));

        // Simulate SIGINT
        sig.kind
            .store(ShutdownKind::SigInt as u8, Ordering::Relaxed);
        assert_eq!(sig.effective_timeout(), Duration::from_secs(5));

        // Simulate SIGTERM
        sig.kind
            .store(ShutdownKind::SigTerm as u8, Ordering::Relaxed);
        assert_eq!(sig.effective_timeout(), Duration::from_secs(30));

        // Simulate SIGQUIT
        sig.kind
            .store(ShutdownKind::SigQuit as u8, Ordering::Relaxed);
        assert_eq!(sig.effective_timeout(), Duration::ZERO);
    }

    #[tokio::test]
    async fn watch_for_shutdown_helper() {
        let (sig, _rx) = ShutdownSignal::new(Duration::from_secs(30));
        let token = sig.token();

        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            token.signal();
        });

        // Should return after signal
        sig.watch_for_shutdown().await;
    }

    #[tokio::test]
    async fn kind_set_correctly() {
        let (sig, _rx) = ShutdownSignal::new(Duration::from_secs(30));
        assert_eq!(sig.kind(), ShutdownKind::None);

        sig.kind
            .store(ShutdownKind::SigInt as u8, Ordering::Relaxed);
        assert_eq!(sig.kind(), ShutdownKind::SigInt);

        sig.kind
            .store(ShutdownKind::SigQuit as u8, Ordering::Relaxed);
        assert_eq!(sig.kind(), ShutdownKind::SigQuit);
    }
}
