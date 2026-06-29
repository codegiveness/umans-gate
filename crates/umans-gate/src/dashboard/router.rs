//! Dashboard HTTP routes: HTML page, polled request fragment, static assets.

use std::sync::Arc;

use askama::Template;
use axum::extract::{Path, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;

use crate::dashboard::assets;
use crate::dashboard::history::{history_csv, history_fragment};
use crate::dashboard::providers::providers_fragment;
use crate::dashboard::requests::requests_fragment;
use crate::dashboard::state::DashboardState;
use crate::dashboard::templates::DashboardTemplate;

/// Render the dashboard HTML page with the current provider snapshot.
pub async fn dashboard_page(State(state): State<Arc<DashboardState>>) -> Html<String> {
    let snapshot = state.snapshot();
    let html = DashboardTemplate {
        providers: &snapshot,
    }
    .render()
    .unwrap_or_default();
    Html(html)
}

/// Serve an embedded static asset (htmx.min.js, app.css) with correct mime.
async fn static_handler(Path(path): Path<String>) -> Response {
    match assets::serve_static(&path) {
        Some((content, mime)) => {
            let mut resp = Response::new(content.into());
            *resp.status_mut() = StatusCode::OK;
            resp.headers_mut()
                .insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
            resp
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Cancel a tracked request via the dashboard Kill button.
async fn kill_request(
    Path(id): Path<String>,
    State(state): State<Arc<DashboardState>>,
) -> StatusCode {
    match uuid::Uuid::parse_str(&id) {
        Ok(id) => {
            if state.tracker().cancel(id) {
                StatusCode::OK
            } else {
                StatusCode::NOT_FOUND
            }
        }
        Err(_) => StatusCode::BAD_REQUEST,
    }
}

/// Build the dashboard Router with all routes wired to shared state.
pub fn dashboard_router(state: Arc<DashboardState>) -> Router<()> {
    Router::new()
        .route("/dashboard", get(dashboard_page))
        .route("/dashboard/requests", get(requests_fragment))
        .route("/dashboard/requests/{id}/kill", post(kill_request))
        .route("/dashboard/providers", get(providers_fragment))
        .route("/dashboard/history", get(history_fragment))
        .route("/dashboard/history/export.csv", get(history_csv))
        .route("/static/{*path}", get(static_handler))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::concurrency::ProviderLimiter;
    use crate::types::{ProviderId, Weight};
    use tokio::sync::broadcast;

    fn make_state() -> Arc<DashboardState> {
        let (tx, _) = broadcast::channel(DashboardState::CHANNEL_CAPACITY);
        let limiter = Arc::new(ProviderLimiter::new(tx));
        limiter.register(
            &ProviderId::new("openai"),
            Weight::from(4.0),
            std::time::Duration::from_secs(30),
            64,
        );
        Arc::new(DashboardState::new(limiter, 300))
    }

    #[tokio::test]
    async fn dashboard_page_html_contains_expected_text() {
        let state = make_state();
        let Html(html) = dashboard_page(State(Arc::clone(&state))).await;
        assert!(html.contains("umans-gate"), "page branding missing");
        assert!(
            html.contains("request-list"),
            "request list container missing"
        );
        assert!(
            html.contains("/static/htmx.min.js"),
            "embedded htmx script tag missing"
        );
        assert!(
            html.contains("/static/app.css"),
            "tailwind stylesheet link missing"
        );
        assert!(
            html.contains("hx-get=\"/dashboard/requests\""),
            "polling target missing"
        );
    }

    #[tokio::test]
    async fn static_handler_serves_js_asset() {
        let resp = static_handler(Path("htmx.min.js".to_string())).await;
        assert_eq!(resp.status(), StatusCode::OK, "htmx status");
        let mime = resp
            .headers()
            .get(header::CONTENT_TYPE)
            .expect("content-type")
            .to_str()
            .unwrap();
        assert!(mime.contains("javascript"), "expected js mime, got: {mime}");
    }

    #[tokio::test]
    async fn static_handler_404_for_missing_asset() {
        let resp = static_handler(Path("nonexistent.css".to_string())).await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn dashboard_router_builds_with_all_routes() {
        let _router = dashboard_router(make_state());
    }

    #[tokio::test]
    async fn history_fragment_renders_empty_state() {
        let state = make_state();
        let Html(html) = history_fragment(State(Arc::clone(&state))).await;
        assert!(html.contains("No terminal requests yet"));
        assert!(!html.contains("<table"));
    }

    #[tokio::test]
    async fn history_csv_returns_csv_with_headers() {
        let state = make_state();
        let resp = history_csv(State(Arc::clone(&state))).await;
        assert_eq!(resp.status(), StatusCode::OK, "csv status");
        let ct = resp
            .headers()
            .get(header::CONTENT_TYPE)
            .expect("content-type")
            .to_str()
            .unwrap();
        assert!(ct.contains("text/csv"), "expected text/csv, got: {ct}");
        let cd = resp
            .headers()
            .get(header::CONTENT_DISPOSITION)
            .expect("content-disposition")
            .to_str()
            .unwrap();
        assert!(cd.contains("attachment"), "expected attachment, got: {cd}");
        assert!(
            cd.contains("umans-history.csv"),
            "expected filename, got: {cd}"
        );
        let body = axum::body::to_bytes(resp.into_body(), 1024 * 1024)
            .await
            .expect("body bytes");
        let csv = String::from_utf8(body.to_vec()).expect("utf8");
        assert!(
            csv.starts_with("enqueued,api,provider,model,status,umans_status,total_time,ttft,prompt_tokens,completion_tokens,cached_tokens,tps"),
            "csv header row missing or incorrect, got: {}",
            csv.lines().next().unwrap_or("")
        );
    }

    #[test]
    fn kill_button_not_shown_for_recent_requests() {
        use crate::dashboard::templates::RequestFragment;
        use crate::dashboard::tracker::{
            local_offset_label, ProtocolVersion, RequestTracker,
        };
        use crate::types::{ModelId, ProviderId, Weight};
        use uuid::Uuid;

        let tracker = RequestTracker::new();
        let id = Uuid::new_v4();
        tracker.register_queued(
            id,
            &ProviderId::new("openai"),
            &ModelId::new("gpt-4"),
            Weight::from(1.0),
            ProtocolVersion::Http11,
            "/v1/chat/completions".to_string(),
        );

        let requests = tracker.snapshot();
        let html = RequestFragment {
            requests,
            offset_label: local_offset_label(),
            kill_min_age_seconds: 300,
        }
        .render()
        .expect("render");

        assert!(
            !html.contains("Kill"),
            "Kill button should not be shown for recent requests (age < min_age)"
        );
        assert!(
            !html.contains("/kill"),
            "kill endpoint should not appear in HTML for recent requests"
        );
    }

    #[test]
    fn kill_button_shown_for_old_requests() {
        use crate::dashboard::templates::RequestFragment;
        use crate::dashboard::tracker::{
            local_offset_label, ProtocolVersion, RequestTracker,
        };
        use crate::types::{ModelId, ProviderId, Weight};
        use uuid::Uuid;

        let tracker = RequestTracker::new();
        let id = Uuid::new_v4();
        tracker.register_queued(
            id,
            &ProviderId::new("openai"),
            &ModelId::new("gpt-4"),
            Weight::from(1.0),
            ProtocolVersion::Http11,
            "/v1/chat/completions".to_string(),
        );

        std::thread::sleep(std::time::Duration::from_millis(1100));

        let requests = tracker.snapshot();
        let html = RequestFragment {
            requests,
            offset_label: local_offset_label(),
            kill_min_age_seconds: 0,
        }
        .render()
        .expect("render");

        assert!(
            html.contains("Kill"),
            "Kill button should be shown for old requests (age > min_age)"
        );
        assert!(
            html.contains(&format!("/dashboard/requests/{id}/kill")),
            "kill endpoint URL should appear in HTML for old requests"
        );
    }
}
