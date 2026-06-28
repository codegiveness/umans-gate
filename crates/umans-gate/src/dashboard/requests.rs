use std::sync::Arc;

use askama::Template;
use axum::extract::State;
use axum::response::Html;

use crate::dashboard::state::DashboardState;
use crate::dashboard::templates::RequestFragment;

pub async fn requests_fragment(State(dashboard): State<Arc<DashboardState>>) -> Html<String> {
    let requests = dashboard.snapshot_requests();
    let html = RequestFragment { requests }.render().unwrap_or_default();
    Html(html)
}
