//! Tracing/logging initialization for umans-gate CLI.

use std::sync::Once;

use tracing_subscriber::filter::EnvFilter;
use tracing_subscriber::fmt;
use tracing_subscriber::prelude::*;

static INIT: Once = Once::new();

/// Initialize the global tracing subscriber.
///
/// Verbosity levels:
/// - 0: respect RUST_LOG env var, default `umans_gate=info,warn`
/// - 1: info
/// - 2: debug
/// - 3+: trace
pub fn init(verbose: u8) {
    INIT.call_once(|| {
        let filter = match verbose {
            0 => EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("umans_gate=info,warn")),
            1 => EnvFilter::new("info"),
            2 => EnvFilter::new("debug"),
            _ => EnvFilter::new("trace"),
        };

        let layer = fmt::layer().with_target(true).with_thread_ids(false);

        tracing_subscriber::registry()
            .with(layer)
            .with(filter)
            .init();
    });
}
