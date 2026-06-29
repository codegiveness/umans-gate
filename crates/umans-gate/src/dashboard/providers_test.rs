use std::sync::Arc;

use askama::Template;
use axum::extract::State;
use axum::response::Html;
use tokio::sync::broadcast;

use crate::concurrency::ProviderLimiter;
use crate::dashboard::providers::providers_fragment;
use crate::dashboard::state::DashboardState;
use crate::dashboard::templates::{DashboardTemplate, ProviderFragment};
use crate::types::{ModelId, ProviderId, Weight};

fn make_state() -> (Arc<ProviderLimiter>, Arc<DashboardState>) {
    let (tx, _) = broadcast::channel(DashboardState::CHANNEL_CAPACITY);
    let limiter = Arc::new(ProviderLimiter::new(tx));
    limiter.register(
        &ProviderId::new("openai"),
        Weight::from(4.0),
        std::time::Duration::from_secs(30),
        64,
    );
    let state = Arc::new(DashboardState::new(Arc::clone(&limiter), 300));
    (limiter, state)
}

#[tokio::test]
async fn providers_fragment_returns_200_with_section() {
    let (_limiter, state) = make_state();
    let Html(html) = providers_fragment(State(Arc::clone(&state))).await;
    assert!(
        html.contains("<section"),
        "fragment must contain a <section> element, got: {html}"
    );
}

#[tokio::test]
async fn providers_fragment_returns_live_in_flight_weight() {
    let (limiter, state) = make_state();
    let pid = ProviderId::new("openai");
    let mid = ModelId::new("gpt-4");

    let _permit = limiter
        .acquire(&pid, &mid, Weight::from(1.0))
        .await
        .unwrap();

    let Html(html) = providers_fragment(State(Arc::clone(&state))).await;
    assert!(
        html.contains("1 / 4 weight"),
        "fragment must show live in_flight weight '1 / 4 weight', got: {html}"
    );
}

#[test]
fn providers_fragment_empty_providers_no_panic() {
    let html = ProviderFragment { providers: &[] }
        .render()
        .expect("render should not panic on empty providers");
    assert!(
        html.contains("<section"),
        "empty fragment still has section"
    );
}

#[test]
fn dashboard_html_contains_providers_polling() {
    let html = DashboardTemplate { providers: &[] }
        .render()
        .expect("render");
    assert!(
        html.contains("id=\"provider-gauges\""),
        "dashboard must contain provider-gauges polling div"
    );
    assert!(
        html.contains("hx-get=\"/dashboard/providers\""),
        "dashboard must poll /dashboard/providers"
    );
    assert!(
        html.contains("hx-trigger=\"every 1s\""),
        "dashboard must use 1s polling interval for providers"
    );
}
