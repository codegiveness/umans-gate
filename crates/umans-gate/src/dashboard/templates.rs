use askama::Template;

use crate::dashboard::state::ProviderMetric;

/// Full dashboard page — dark theme, loads embedded htmx + sse, opens SSE stream.
#[derive(Template, Default)]
#[template(path = "dashboard.html")]
pub struct DashboardTemplate<'a> {
    pub providers: &'a [ProviderMetric],
}

/// SSE fragment swap — just the provider rows, no <html> wrapper.
#[derive(Template)]
#[template(path = "provider_fragment.html")]
pub struct ProviderFragment<'a> {
    pub providers: &'a [ProviderMetric],
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dashboard::state::{ActiveModel, ModelState, ProviderMetric};
    use crate::types::{ModelId, ProviderId};

    #[test]
    fn dashboard_renders_empty() {
        let tpl = DashboardTemplate { providers: &[] };
        let html = tpl.render().expect("render");
        assert!(html.contains("umans-gate"));
        assert!(html.contains("provider-list"));
        assert!(html.contains("/static/htmx.min.js"));
        assert!(html.contains("/static/sse.js"));
    }

    #[test]
    fn dashboard_default_renders_without_panic() {
        let html = DashboardTemplate::default().render().expect("render");
        assert!(html.contains("umans-gate"));
    }

    #[test]
    fn fragment_renders_one_provider() {
        let p = ProviderMetric {
            provider: ProviderId::new("openai"),
            capacity: 4.0,
            in_flight: 1.0,
            active_models: vec![ActiveModel {
                model: ModelId::new("gpt-4"),
                state: ModelState::Active,
                count: 1,
            }],
        };
        let html = ProviderFragment {
            providers: std::slice::from_ref(&p),
        }
        .render()
        .expect("render");
        assert!(html.contains("openai"));
        assert!(html.contains("gpt-4"));
        assert!(html.contains("1 / 4 weight in use"));
        assert!(html.contains(r#"class="active""#));
    }

    #[test]
    fn fragment_renders_empty() {
        let html = ProviderFragment { providers: &[] }.render().expect("render");
        assert!(!html.contains("provider-"));
    }
}
