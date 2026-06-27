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
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimeoutConfig {
    pub connect: Duration,
    pub ttfb: Duration,
    pub stream_idle: Duration,
    pub total: Duration,
}

impl Default for TimeoutConfig {
    fn default() -> Self {
        TimeoutConfig {
            connect: Duration::from_secs(10),
            ttfb: Duration::from_secs(30),
            stream_idle: Duration::from_secs(60),
            total: Duration::from_secs(300),
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
        self.models.iter().find(|m| m.id == *model).map(|m| m.weight)
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
                id: ProviderId::new("openai"),
                upstream_url: Url::parse("https://api.openai.com")
                    .expect("valid url literal"),
                capacity: Weight::from(4.0),
                models: vec![ModelConfig {
                    id: ModelId::new("gpt-4"),
                    weight: Weight::from(1.0),
                }],
                timeouts: TimeoutConfig::default(),
            }],
            bind: "0.0.0.0:8080".parse().unwrap(),
            dashboard_bind: "0.0.0.0:9090".parse().unwrap(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(t.connect, Duration::from_secs(10));
        assert_eq!(t.ttfb, Duration::from_secs(30));
        assert_eq!(t.stream_idle, Duration::from_secs(60));
        assert_eq!(t.total, Duration::from_secs(300));
    }

    #[test]
    fn provider_model_weight_lookup() {
        let p = ProviderConfig {
            id: ProviderId::new("openai"),
            upstream_url: Url::parse("https://api.openai.com").unwrap(),
            capacity: Weight::from(4.0),
            models: vec![
                ModelConfig { id: ModelId::new("gpt-4"), weight: Weight::from(1.0) },
                ModelConfig { id: ModelId::new("gpt-3.5-turbo"), weight: Weight::from(0.5) },
            ],
            timeouts: TimeoutConfig::default(),
        };
        assert_eq!(p.model_weight(&ModelId::new("gpt-4")), Some(Weight::from(1.0)));
        assert_eq!(p.model_weight(&ModelId::new("gpt-3.5-turbo")), Some(Weight::from(0.5)));
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
}
