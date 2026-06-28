//! Dashboard HTTP routes: HTML page, polled request fragment, static assets.

use std::sync::Arc;

use askama::Template;
use axum::extract::{Path, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::Router;

use crate::dashboard::assets;
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

/// Build the dashboard Router with all routes wired to shared state.
pub fn dashboard_router(state: Arc<DashboardState>) -> Router<()> {
    Router::new()
        .route("/dashboard", get(dashboard_page))
        .route("/dashboard/requests", get(requests_fragment))
        .route("/dashboard/providers", get(providers_fragment))
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
        Arc::new(DashboardState::new(limiter))
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
}
