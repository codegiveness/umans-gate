//! umans-gate: weighted concurrency API gateway library.
//!
//! Provides zero-race weighted concurrency limiting per AI provider,
//! path-based proxy routing, and a real-time HTMX+SSE dashboard.

pub mod concurrency;
pub mod config;
#[cfg(feature = "hot-reload")]
pub mod config_store;
pub mod dashboard;
pub mod error;
pub mod model_fetch;
pub mod proxy;
pub mod shutdown;
pub mod types;

pub use axum::serve;
