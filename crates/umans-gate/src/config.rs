//! Configuration loading via figment (YAML + env) and strict validation.
//!
//! Layering order (later wins):
//! 1. `Serialized::defaults(GatewayConfig::default())` — single OpenAI provider
//! 2. `Yaml::file(path)` — user config
//! 3. `Env::prefixed("UMANS_GATE_")` — environment overrides
//!
//! After extraction, [`GatewayConfig::validate`] enforces semantic rules.

use std::collections::HashSet;
use std::path::Path;

use figment::providers::{Env, Format, Serialized, Yaml};
use figment::Figment;

use crate::error::{GatewayError, Result};
use crate::types::GatewayConfig;

impl GatewayConfig {
    /// Load config from a YAML file with env overrides, then run strict validation.
    pub fn load(path: &Path) -> Result<Self> {
        let config: GatewayConfig = Figment::from(Serialized::defaults(GatewayConfig::default()))
            .merge(Yaml::file(path))
            .merge(Env::prefixed("UMANS_GATE_"))
            .extract()?;
        config.validate()?;
        Ok(config)
    }

    /// Strict semantic validation. Rejects the entire config on any violation.
    pub fn validate(&self) -> Result<()> {
        if self.providers.is_empty() {
            return Err(GatewayError::Validation(
                "providers list cannot be empty".into(),
            ));
        }

        let mut seen_providers: HashSet<&str> = HashSet::new();
        for provider in &self.providers {
            if !seen_providers.insert(provider.id.as_ref()) {
                return Err(GatewayError::Validation(format!(
                    "duplicate provider id: {}",
                    provider.id
                )));
            }

            if provider.capacity.to_milliunits() == 0 {
                return Err(GatewayError::Validation(format!(
                    "provider {} capacity must be > 0",
                    provider.id
                )));
            }

            let scheme = provider.upstream_url.scheme();
            if (scheme != "http" && scheme != "https") || provider.upstream_url.host_str().is_none()
            {
                return Err(GatewayError::Validation(format!(
                    "provider {} has invalid upstream_url",
                    provider.id
                )));
            }

            let mut seen_models: HashSet<&str> = HashSet::new();
            for model in &provider.models {
                if !seen_models.insert(model.id.as_ref()) {
                    return Err(GatewayError::Validation(format!(
                        "duplicate model id {} in provider {}",
                        model.id, provider.id
                    )));
                }

                if model.weight.to_milliunits() == 0 {
                    return Err(GatewayError::Validation(format!(
                        "model {} weight must be > 0 in provider {}",
                        model.id, provider.id
                    )));
                }

                if model.weight.to_milliunits() > provider.capacity.to_milliunits() {
                    return Err(GatewayError::Validation(format!(
                        "model {} weight {} exceeds provider {} capacity {}",
                        model.id, model.weight, provider.id, provider.capacity
                    )));
                }
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::SocketAddr;
    use std::sync::{Mutex, OnceLock};
    use tempfile::tempdir;

    /// Serializes tests that load config (env vars are process-global).
    static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    fn env_guard() -> std::sync::MutexGuard<'static, ()> {
        ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .expect("env lock poisoned")
    }

    fn write_config(dir: &tempfile::TempDir, content: &str) -> std::path::PathBuf {
        let path = dir.path().join("config.yaml");
        let mut f = std::fs::File::create(&path).expect("create config file");
        f.write_all(content.as_bytes()).expect("write config file");
        path
    }

    const VALID_CONFIG: &str = r#"
bind: "0.0.0.0:8080"
dashboard_bind: "0.0.0.0:9090"
providers:
  - id: openai
    upstream_url: "https://api.openai.com"
    capacity: 4.0
    models:
      - id: gpt-4
        weight: 1.0
      - id: gpt-3.5-turbo
        weight: 0.5
  - id: anthropic
    upstream_url: "https://api.anthropic.com"
    capacity: 2.0
    models:
      - id: claude-3-opus
        weight: 1.0
      - id: claude-3-haiku
        weight: 0.25
"#;

    #[test]
    fn load_valid_config() {
        let _guard = env_guard();
        let dir = tempdir().expect("tempdir");
        let path = write_config(&dir, VALID_CONFIG);
        let cfg = GatewayConfig::load(&path).expect("valid config should load");
        assert_eq!(cfg.providers.len(), 2);
        assert_eq!(cfg.providers[0].id.as_ref(), "openai");
        assert_eq!(cfg.providers[0].capacity.to_milliunits(), 4000);
        assert_eq!(cfg.providers[1].id.as_ref(), "anthropic");
        assert_eq!(cfg.bind, "0.0.0.0:8080".parse::<SocketAddr>().unwrap());
    }

    #[test]
    fn reject_empty_providers() {
        let _guard = env_guard();
        let dir = tempdir().expect("tempdir");
        let path = write_config(
            &dir,
            r#"
bind: "0.0.0.0:8080"
dashboard_bind: "0.0.0.0:9090"
providers: []
"#,
        );
        let err = GatewayConfig::load(&path).unwrap_err();
        assert!(matches!(err, GatewayError::Validation(_)), "{err}");
    }

    #[test]
    fn reject_zero_weight() {
        let _guard = env_guard();
        let dir = tempdir().expect("tempdir");
        let path = write_config(
            &dir,
            r#"
bind: "0.0.0.0:8080"
dashboard_bind: "0.0.0.0:9090"
providers:
  - id: openai
    upstream_url: "https://api.openai.com"
    capacity: 4.0
    models:
      - id: gpt-4
        weight: 0.0
"#,
        );
        let err = GatewayConfig::load(&path).unwrap_err();
        assert!(matches!(err, GatewayError::Validation(_)), "{err}");
    }

    #[test]
    fn reject_zero_capacity() {
        let _guard = env_guard();
        let dir = tempdir().expect("tempdir");
        let path = write_config(
            &dir,
            r#"
bind: "0.0.0.0:8080"
dashboard_bind: "0.0.0.0:9090"
providers:
  - id: openai
    upstream_url: "https://api.openai.com"
    capacity: 0.0
    models:
      - id: gpt-4
        weight: 1.0
"#,
        );
        let err = GatewayConfig::load(&path).unwrap_err();
        assert!(matches!(err, GatewayError::Validation(_)), "{err}");
    }

    #[test]
    fn reject_duplicate_provider_ids() {
        let _guard = env_guard();
        let dir = tempdir().expect("tempdir");
        let path = write_config(
            &dir,
            r#"
bind: "0.0.0.0:8080"
dashboard_bind: "0.0.0.0:9090"
providers:
  - id: openai
    upstream_url: "https://api.openai.com"
    capacity: 4.0
    models:
      - id: gpt-4
        weight: 1.0
  - id: openai
    upstream_url: "https://api.openai.com"
    capacity: 2.0
    models:
      - id: gpt-4
        weight: 1.0
"#,
        );
        let err = GatewayConfig::load(&path).unwrap_err();
        assert!(matches!(err, GatewayError::Validation(_)), "{err}");
    }

    #[test]
    fn reject_duplicate_model_ids() {
        let _guard = env_guard();
        let dir = tempdir().expect("tempdir");
        let path = write_config(
            &dir,
            r#"
bind: "0.0.0.0:8080"
dashboard_bind: "0.0.0.0:9090"
providers:
  - id: openai
    upstream_url: "https://api.openai.com"
    capacity: 4.0
    models:
      - id: gpt-4
        weight: 1.0
      - id: gpt-4
        weight: 0.5
"#,
        );
        let err = GatewayConfig::load(&path).unwrap_err();
        assert!(matches!(err, GatewayError::Validation(_)), "{err}");
    }

    #[test]
    fn reject_weight_exceeds_capacity() {
        let _guard = env_guard();
        let dir = tempdir().expect("tempdir");
        let path = write_config(
            &dir,
            r#"
bind: "0.0.0.0:8080"
dashboard_bind: "0.0.0.0:9090"
providers:
  - id: openai
    upstream_url: "https://api.openai.com"
    capacity: 1.0
    models:
      - id: gpt-4
        weight: 2.0
"#,
        );
        let err = GatewayConfig::load(&path).unwrap_err();
        assert!(matches!(err, GatewayError::Validation(_)), "{err}");
    }

    #[test]
    fn reject_invalid_upstream_url() {
        let _guard = env_guard();
        let dir = tempdir().expect("tempdir");
        let path = write_config(
            &dir,
            r#"
bind: "0.0.0.0:8080"
dashboard_bind: "0.0.0.0:9090"
providers:
  - id: openai
    upstream_url: "file:///etc/passwd"
    capacity: 4.0
    models:
      - id: gpt-4
        weight: 1.0
"#,
        );
        let err = GatewayConfig::load(&path).unwrap_err();
        assert!(matches!(err, GatewayError::Validation(_)), "{err}");
    }

    #[test]
    fn env_override() {
        let _guard = env_guard();
        let dir = tempdir().expect("tempdir");
        let path = write_config(&dir, VALID_CONFIG);
        std::env::set_var("UMANS_GATE_BIND", "127.0.0.1:9999");
        let cfg = GatewayConfig::load(&path).expect("env override config loads");
        assert_eq!(cfg.bind, "127.0.0.1:9999".parse::<SocketAddr>().unwrap());
        std::env::remove_var("UMANS_GATE_BIND");
    }

    #[test]
    fn default_has_umans_provider() {
        let cfg = GatewayConfig::default();
        assert_eq!(cfg.providers.len(), 1);
        assert_eq!(cfg.providers[0].id.as_ref(), "umans");
        assert_eq!(
            cfg.providers[0].upstream_url.as_ref(),
            "https://api.code.umans.ai/"
        );
        assert_eq!(cfg.providers[0].capacity.to_milliunits(), 4000);
        assert_eq!(cfg.providers[0].models.len(), 6);
        assert!(cfg.validate().is_ok());
    }
}
