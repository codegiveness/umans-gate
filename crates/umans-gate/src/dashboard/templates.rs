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
        let html = RequestFragment { requests: vec![] }
            .render()
            .expect("render");
        assert!(html.contains("No active requests"));
        assert!(!html.contains("<table"));
    }

    #[test]
    fn request_fragment_renders_rows() {
        use crate::dashboard::tracker::RequestTracker;
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
        );
        tracker.register_queued(
            id2,
            &ProviderId::new("umans"),
            &ModelId::new("umans-flash"),
            Weight::from(0.5),
        );
        tracker.mark_running(id2);

        let requests = tracker.snapshot();
        let html = RequestFragment { requests }.render().expect("render");

        println!("{html}");

        assert!(html.contains("hidden md:table"), "desktop table missing");
        assert!(html.contains("md:hidden"), "mobile cards missing");
        assert!(html.contains("Session ID"), "session id header missing");
        assert!(html.contains("Provider"), "provider header missing");
        assert!(html.contains("Model"), "model header missing");
        assert!(html.contains("Weight"), "weight header missing");
        assert!(html.contains("Status"), "status header missing");
        assert!(html.contains("Age"), "age header missing");
        assert!(
            html.contains("font-mono text-xs"),
            "session id mono styling missing"
        );
        assert!(html.contains("tabular-nums"), "tabular nums missing");
        assert!(
            html.contains("title=\""),
            "title attr for full uuid missing"
        );
        assert!(html.contains("\u{2026}"), "ellipsis in short id missing");
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
