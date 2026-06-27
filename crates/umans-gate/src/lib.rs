//! umans-gate: weighted concurrency API gateway library.
//!
//! Provides zero-race weighted concurrency limiting per AI provider,
//! path-based proxy routing, and a real-time HTMX+SSE dashboard.

pub mod concurrency;
pub mod config;
pub mod dashboard;
pub mod error;
pub mod proxy;
pub mod types;
