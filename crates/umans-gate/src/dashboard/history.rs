use std::sync::Arc;

use askama::Template;
use axum::extract::State;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{Html, Response};

use crate::dashboard::state::DashboardState;
use crate::dashboard::templates::HistoryFragment;

pub async fn history_fragment(State(state): State<Arc<DashboardState>>) -> Html<String> {
    let records = state.tracker().history();
    let offset_label = state.offset_label.clone();
    let html = HistoryFragment {
        records,
        offset_label,
    }
    .render()
    .unwrap_or_default();
    Html(html)
}

pub async fn history_csv(State(state): State<Arc<DashboardState>>) -> Response {
    let records = state.tracker().history();
    let mut csv =
        String::from("enqueued,api,provider,model,status,umans_status,total_time,ttft,prompt_tokens,completion_tokens,cached_tokens,tps\n");
    for r in &records {
        let enqueued = r.enqueued_at_wall.to_rfc3339();
        let api = r.api_kind;
        let provider = &r.provider;
        let model = &r.model;
        let status = r.status;
        let umans_status = r.internal_status.map(|s| s.to_string()).unwrap_or_default();
        let total_time = r
            .total_time
            .map(|d| d.as_secs_f64().to_string())
            .unwrap_or_default();
        let ttft = r
            .ttft
            .map(|d| d.as_millis().to_string())
            .unwrap_or_default();
        let prompt_tokens = r.prompt_tokens.map(|t| t.to_string()).unwrap_or_default();
        let completion_tokens = r
            .completion_tokens
            .map(|t| t.to_string())
            .unwrap_or_default();
        let cached_tokens = r.cached_tokens.map(|t| t.to_string()).unwrap_or_default();
        let tps = r.tps.map(|t| t.to_string()).unwrap_or_default();
        csv.push_str(&format!(
            "{},{},{},{},{},{},{},{},{},{},{},{}\n",
            enqueued,
            api,
            provider,
            model,
            status,
            umans_status,
            total_time,
            ttft,
            prompt_tokens,
            completion_tokens,
            cached_tokens,
            tps,
        ));
    }

    let mut resp = Response::new(csv.into());
    *resp.status_mut() = StatusCode::OK;
    resp.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("text/csv"));
    resp.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("attachment; filename=\"umans-history.csv\""),
    );
    resp
}
