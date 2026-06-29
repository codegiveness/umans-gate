use askama::Template;

use crate::dashboard::state::ProviderMetric;
use crate::dashboard::tracker::RequestRecord;

/// Full dashboard page — dark Tailwind theme, loads embedded htmx, polls /dashboard/requests.
#[derive(Template, Default)]
#[template(path = "dashboard.html")]
pub struct DashboardTemplate<'a> {
    pub providers: &'a [ProviderMetric],
}

#[derive(Template)]
#[template(path = "request_fragment.html")]
pub struct RequestFragment {
    pub requests: Vec<RequestRecord>,
    pub offset_label: String,
}

#[derive(Template)]
#[template(path = "providers_fragment.html")]
pub struct ProviderFragment<'a> {
    pub providers: &'a [ProviderMetric],
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ModelId, ProviderId};

    #[test]
    fn dashboard_renders_empty() {
        let tpl = DashboardTemplate { providers: &[] };
        let html = tpl.render().expect("render");
        assert!(html.contains("umans-gate"));
        assert!(html.contains("request-list"));
        assert!(html.contains("/static/app.css"));
        assert!(html.contains("/static/htmx.min.js"));
        assert!(html.contains("hx-get=\"/dashboard/requests\""));
        assert!(html.contains("hx-trigger=\"every 1s\""));
        assert!(!html.contains("sse"));
    }

    #[test]
    fn dashboard_default_renders_without_panic() {
        let html = DashboardTemplate::default().render().expect("render");
        assert!(html.contains("umans-gate"));
    }

    #[test]
    fn request_fragment_renders_empty() {
        let html = RequestFragment {
            requests: vec![],
            offset_label: String::new(),
        }
        .render()
        .expect("render");
        assert!(html.contains("No active requests"));
        assert!(!html.contains("<table"));
    }

    #[test]
    fn request_fragment_renders_rows() {
        use crate::dashboard::tracker::{local_offset_label, ProtocolVersion, RequestTracker};
        use crate::types::Weight;
        use uuid::Uuid;

        let tracker = RequestTracker::new();
        let id1 = Uuid::new_v4();
        let id2 = Uuid::new_v4();

        tracker.register_queued(
            id1,
            &ProviderId::new("umans"),
            &ModelId::new("umans-coder"),
            Weight::from(1.0),
            ProtocolVersion::Http11,
            "/v1/chat/completions".to_string(),
        );
        tracker.register_queued(
            id2,
            &ProviderId::new("umans"),
            &ModelId::new("umans-flash"),
            Weight::from(0.5),
            ProtocolVersion::H2,
            "/v1/messages".to_string(),
        );
        tracker.mark_running(id2, Some(ProtocolVersion::Http11));

        let requests = tracker.snapshot();
        // Capture display strings before the snapshot is moved into the template.
        let enqueued1 = requests[0].enqueued_at_display();
        let io1 = requests[0].io_display();
        let io2 = requests[1].io_display();
        let offset_label = local_offset_label();
        let html = RequestFragment {
            requests,
            offset_label: offset_label.clone(),
        }
        .render()
        .expect("render");

        println!("{html}");

        assert!(html.contains("hidden md:table"), "desktop table missing");
        assert!(html.contains("md:hidden"), "mobile cards missing");
        assert!(
            html.contains(&format!("Enqueued time ({})", offset_label)),
            "enqueued header with offset missing"
        );
        assert!(html.contains("Provider"), "provider header missing");
        assert!(html.contains("Model"), "model header missing");
        assert!(html.contains("Weight"), "weight header missing");
        assert!(html.contains("Status"), "status header missing");
        assert!(html.contains("Age"), "age header missing");
        assert!(html.contains("I/O"), "i/o header missing");
        assert!(html.contains("API"), "api header missing");
        assert!(html.contains("OpenAI"), "openai api label missing");
        assert!(html.contains("Anthropic"), "anthropic api label missing");
        assert!(!html.contains("Session ID"), "session id header should be gone");
        assert!(html.contains("tabular-nums"), "tabular nums missing");
        // Enqueued time renders as HH:MM:SS (two colons, eight digits).
        assert!(enqueued1.len() == 8, "enqueued time should be HH:MM:SS");
        assert_eq!(enqueued1.matches(':').count(), 2, "enqueued time needs two colons");
        assert!(html.contains(&enqueued1), "enqueued time missing from html");
        // I/O display: queued request shows h1.1/-, running shows h2/h1.1.
        assert_eq!(io1, "h1.1/-", "queued i/o should be h1.1/-");
        assert_eq!(io2, "h2/h1.1", "running i/o should be h2/h1.1");
        assert!(html.contains(&io1), "queued i/o missing from html");
        assert!(html.contains(&io2), "running i/o missing from html");
        assert!(
            html.contains("bg-amber-500/15 text-amber-400"),
            "queued badge class missing"
        );
        assert!(
            html.contains("bg-emerald-500/15 text-emerald-400"),
            "running badge class missing"
        );
        assert!(html.contains("bg-amber-400"), "queued dot class missing");
        assert!(html.contains("bg-emerald-400"), "running dot class missing");
        assert!(html.contains("Queued"), "queued label missing");
        assert!(html.contains("Running"), "running label missing");
        assert!(html.contains("umans-coder"), "provider model name missing");
        assert!(html.contains("umans-flash"), "provider model name missing");
        assert!(
            !html.contains("No active requests"),
            "should not show empty state"
        );
    }
}
