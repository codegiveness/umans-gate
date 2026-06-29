use std::sync::Arc;

use askama::Template;
use axum::extract::State;
use axum::response::Html;

use crate::dashboard::state::DashboardState;
use crate::dashboard::templates::RequestFragment;

pub async fn requests_fragment(State(dashboard): State<Arc<DashboardState>>) -> Html<String> {
    let requests = dashboard.snapshot_requests();
    let offset_label = dashboard.offset_label.clone();
    let kill_min_age_seconds = dashboard.kill_min_age_seconds;
    let html = RequestFragment {
        requests,
        offset_label,
        kill_min_age_seconds,
    }
    .render()
    .unwrap_or_default();
    Html(html)
}
