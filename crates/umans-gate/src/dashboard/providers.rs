use std::sync::Arc;

use askama::Template;
use axum::extract::State;
use axum::response::Html;

use crate::dashboard::state::DashboardState;
use crate::dashboard::templates::ProviderFragment;

pub async fn providers_fragment(State(state): State<Arc<DashboardState>>) -> Html<String> {
    let snapshot = state.snapshot();
    let html = ProviderFragment {
        providers: &snapshot,
    }
    .render()
    .unwrap_or_default();
    Html(html)
}
