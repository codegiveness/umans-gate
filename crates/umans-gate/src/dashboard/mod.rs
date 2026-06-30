//! Real-time HTMX dashboard with 1s polling.

pub mod assets;
pub mod history;
pub mod providers;
pub mod requests;
pub mod router;
pub mod state;
pub mod templates;
pub mod tracked_permit;
pub mod tracker;

#[cfg(test)]
mod providers_test;
