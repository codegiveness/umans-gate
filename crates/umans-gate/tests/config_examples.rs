use std::env;
use std::path::PathBuf;
use umans_gate::types::GatewayConfig;

fn examples_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("examples")
        .canonicalize()
        .expect("examples directory exists")
}

fn load(path: &str) -> GatewayConfig {
    env::remove_var("UMANS_GATE_BIND");
    env::remove_var("UMANS_GATE_DASHBOARD_BIND");
    let file = examples_dir().join(path);
    GatewayConfig::load(&file).unwrap_or_else(|e| panic!("failed to load {path}: {e}"))
}

#[test]
fn config_yaml_loads() {
    let cfg = load("config.yaml");
    assert_eq!(cfg.providers.len(), 1);
    assert_eq!(cfg.providers[0].id.as_ref(), "umans");
}

#[test]
fn config_openai_only_loads() {
    let cfg = load("config-openai-only.yaml");
    assert_eq!(cfg.providers.len(), 1);
    assert_eq!(cfg.providers[0].id.as_ref(), "openai");
}

#[test]
fn config_advanced_loads() {
    let cfg = load("config-advanced.yaml");
    assert_eq!(cfg.providers.len(), 2);
    let openai = &cfg.providers[0];
    assert_eq!(openai.capacity.to_milliunits(), 10_000);
    assert_eq!(openai.models.len(), 4);
    assert_eq!(openai.models[0].weight.to_milliunits(), 2_500);
    let anthropic = &cfg.providers[1];
    assert_eq!(anthropic.models.len(), 4);
}
