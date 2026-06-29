//! Core gateway types: Weight, ProviderId, configs.

use std::net::SocketAddr;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use url::Url;

/// Weight of a model relative to provider capacity (config-side float).
/// Internal representation uses fixed-point u32 milliunits (×1000) for race-free CAS.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Weight(f32);

impl Weight {
    /// Scale factor: milliunits per weight unit.
    pub const SCALE: u32 = 1000;

    /// Convert to fixed-point milliunits (u32) for concurrency engine.
    pub fn to_milliunits(&self) -> u32 {
        (self.0 * 1000.0) as u32
    }

    /// Reconstruct from milliunits.
    pub fn from_milliunits(m: u32) -> Self {
        Weight(m as f32 / 1000.0)
    }
}

impl From<f32> for Weight {
    fn from(v: f32) -> Self {
        Weight(v)
    }
}

impl std::fmt::Display for Weight {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Provider identifier (e.g. "openai", "anthropic").
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ProviderId(String);

impl ProviderId {
    pub fn new(s: impl Into<String>) -> Self {
        ProviderId(s.into())
    }
}

impl AsRef<str> for ProviderId {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for ProviderId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Model identifier within a provider (e.g. "gpt-4").
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ModelId(String);

impl ModelId {
    pub fn new(s: impl Into<String>) -> Self {
        ModelId(s.into())
    }
}

impl AsRef<str> for ModelId {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for ModelId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Model definition within a provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelConfig {
    pub id: ModelId,
    pub weight: Weight,
}

/// Timeout hierarchy (AI-tuned defaults).
///
/// `connect`, `ttfb`, and `total` default to `None` (infinity). `stream_idle`
/// defaults to `Some(300s)` as a backstop against indefinitely stalled streams.
/// `queuetimeout`, `maxqueue`, and `permit_cooldown` are stop-gate mechanisms
/// and remain finite (`Duration`/`usize`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimeoutConfig {
    #[serde(default)]
    pub connect: Option<Duration>,
    #[serde(default)]
    pub ttfb: Option<Duration>,
    #[serde(default = "default_stream_idle")]
    pub stream_idle: Option<Duration>,
    #[serde(default)]
    pub total: Option<Duration>,
    #[serde(default = "default_queuetimeout")]
    pub queuetimeout: Duration,
    #[serde(default = "default_maxqueue")]
    pub maxqueue: usize,
    #[serde(default = "default_permit_cooldown")]
    pub permit_cooldown: Duration,
}

fn default_stream_idle() -> Option<Duration> {
    Some(Duration::from_secs(300))
}

fn default_queuetimeout() -> Duration {
    Duration::from_secs(30)
}

fn default_maxqueue() -> usize {
    64
}

fn default_permit_cooldown() -> Duration {
    Duration::from_millis(500)
}

impl Default for TimeoutConfig {
    fn default() -> Self {
        TimeoutConfig {
            connect: None,
            ttfb: None,
            stream_idle: default_stream_idle(),
            total: None,
            queuetimeout: default_queuetimeout(),
            maxqueue: default_maxqueue(),
            permit_cooldown: default_permit_cooldown(),
        }
    }
}

/// Provider definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub id: ProviderId,
    pub upstream_url: Url,
    pub capacity: Weight,
    pub models: Vec<ModelConfig>,
    #[serde(default)]
    pub timeouts: TimeoutConfig,
}

impl ProviderConfig {
    /// Look up weight for a model by name.
    pub fn model_weight(&self, model: &ModelId) -> Option<Weight> {
        self.models
            .iter()
            .find(|m| m.id == *model)
            .map(|m| m.weight)
    }
}

/// Top-level gateway configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayConfig {
    pub providers: Vec<ProviderConfig>,
    pub bind: SocketAddr,
    pub dashboard_bind: SocketAddr,
}

impl Default for GatewayConfig {
    fn default() -> Self {
        GatewayConfig {
            providers: vec![ProviderConfig {
                id: ProviderId::new("umans"),
                upstream_url: Url::parse("https://api.code.umans.ai")
                    .expect("valid url literal"),
                capacity: Weight::from(4.0),
                models: vec![
                    ModelConfig {
                        id: ModelId::new("umans-kimi-k2.7"),
                        weight: Weight::from(1.0),
                    },
                    ModelConfig {
                        id: ModelId::new("umans-glm-5.2"),
                        weight: Weight::from(1.0),
                    },
                    ModelConfig {
                        id: ModelId::new("umans-coder"),
                        weight: Weight::from(1.0),
                    },
                    ModelConfig {
                        id: ModelId::new("umans-glm-5.2-nvfp4"),
                        weight: Weight::from(1.0),
                    },
                    ModelConfig {
                        id: ModelId::new("umans-flash"),
                        weight: Weight::from(1.0),
                    },
                    ModelConfig {
                        id: ModelId::new("umans-qwen3.6-35b-a3b"),
                        weight: Weight::from(1.0),
                    },
                ],
                timeouts: TimeoutConfig::default(),
            }],
            bind: "0.0.0.0:8080".parse().expect("valid socket addr literal"),
            dashboard_bind: "0.0.0.0:9090".parse().expect("valid socket addr literal"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::path::PathBuf;

    #[test]
    fn weight_from_half() {
        assert_eq!(Weight::from(0.5f32).to_milliunits(), 500);
    }

    #[test]
    fn weight_from_one() {
        assert_eq!(Weight::from(1.0f32).to_milliunits(), 1000);
    }

    #[test]
    fn weight_roundtrip() {
        assert_eq!(Weight::from_milliunits(500).to_milliunits(), 500);
        assert_eq!(Weight::from_milliunits(1000).to_milliunits(), 1000);
    }

    #[test]
    fn timeout_defaults() {
        let t = TimeoutConfig::default();
        assert_eq!(t.connect, None);
        assert_eq!(t.ttfb, None);
        assert_eq!(t.stream_idle, Some(Duration::from_secs(300)));
        assert_eq!(t.total, None);
    }

    #[test]
    fn provider_model_weight_lookup() {
        let p = ProviderConfig {
            id: ProviderId::new("openai"),
            upstream_url: Url::parse("https://api.openai.com").unwrap(),
            capacity: Weight::from(4.0),
            models: vec![
                ModelConfig {
                    id: ModelId::new("gpt-4"),
                    weight: Weight::from(1.0),
                },
                ModelConfig {
                    id: ModelId::new("gpt-3.5-turbo"),
                    weight: Weight::from(0.5),
                },
            ],
            timeouts: TimeoutConfig::default(),
        };
        assert_eq!(
            p.model_weight(&ModelId::new("gpt-4")),
            Some(Weight::from(1.0))
        );
        assert_eq!(
            p.model_weight(&ModelId::new("gpt-3.5-turbo")),
            Some(Weight::from(0.5))
        );
        assert_eq!(p.model_weight(&ModelId::new("unknown")), None);
    }

    #[test]
    fn types_send_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<Weight>();
        assert_send_sync::<ProviderId>();
        assert_send_sync::<ModelId>();
        assert_send_sync::<ModelConfig>();
        assert_send_sync::<ProviderConfig>();
        assert_send_sync::<TimeoutConfig>();
        assert_send_sync::<GatewayConfig>();
    }

    #[test]
    fn timeout_config_default() {
        let t = TimeoutConfig::default();
        assert_eq!(t.connect, None);
        assert_eq!(t.ttfb, None);
        assert_eq!(t.stream_idle, Some(Duration::from_secs(300)));
        assert_eq!(t.total, None);
        assert_eq!(t.queuetimeout, Duration::from_secs(30));
        assert_eq!(t.maxqueue, 64);
        assert_eq!(t.permit_cooldown, Duration::from_millis(500));
    }

    #[test]
    fn permit_cooldown_serde_default() {
        let yaml = "connect:\n  secs: 10\n  nanos: 0\nttfb:\n  secs: 30\n  nanos: 0\nstream_idle:\n  secs: 60\n  nanos: 0\ntotal:\n  secs: 300\n  nanos: 0\nqueuetimeout:\n  secs: 30\n  nanos: 0\nmaxqueue: 64";
        let t: TimeoutConfig = serde_yaml::from_str(yaml).expect("deserialize TimeoutConfig");
        assert_eq!(t.permit_cooldown, Duration::from_millis(500));
    }

    #[test]
    fn timeout_option_roundtrip() {
        let yaml = "connect: null\nttfb:\n  secs: 5\n  nanos: 0\nstream_idle: null\ntotal:\n  secs: 120\n  nanos: 0\nqueuetimeout:\n  secs: 30\n  nanos: 0\nmaxqueue: 64";
        let t: TimeoutConfig = serde_yaml::from_str(yaml).expect("deserialize");
        assert_eq!(t.connect, None);
        assert_eq!(t.ttfb, Some(Duration::from_secs(5)));
        assert_eq!(t.stream_idle, None);
        assert_eq!(t.total, Some(Duration::from_secs(120)));

        let yaml_out = serde_yaml::to_string(&t).expect("serialize");
        let t2: TimeoutConfig = serde_yaml::from_str(&yaml_out).expect("re-deserialize");
        assert_eq!(t2.connect, None);
        assert_eq!(t2.ttfb, Some(Duration::from_secs(5)));
        assert_eq!(t2.stream_idle, None);
        assert_eq!(t2.total, Some(Duration::from_secs(120)));
    }

    #[test]
    fn config_loads_without_queue_fields() {
        env::remove_var("UMANS_GATE_BIND");
        env::remove_var("UMANS_GATE_DASHBOARD_BIND");
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("examples")
            .join("config.yaml");
        let cfg = GatewayConfig::load(&path).expect("load examples/config.yaml");
        let timeouts = &cfg.providers[0].timeouts;
        assert_eq!(timeouts.queuetimeout, Duration::from_secs(30));
        assert_eq!(timeouts.maxqueue, 64);
    }
}
