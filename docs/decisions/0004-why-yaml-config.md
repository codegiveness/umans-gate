# 4. Why YAML Configuration

## Context

Operators configure umans-gate through a single file: provider endpoints, model weights, timeouts, dashboard settings, and more. The format must be human-readable, easy to edit by hand, and straightforward to load in Rust.

We considered:

- **JSON**: easy to parse, but trailing commas and lack of comments make it unfriendly for hand-edited configuration.
- **TOML**: excellent for Rust crates, but nested lists of providers and models become noisy.
- **YAML**: widely used for operations files, supports comments, and represents nested lists clearly.
- **Environment variables only**: fine for containers, but quickly becomes unwieldy for a list of providers and models.

## Decision

We will use YAML as the primary configuration format, loaded through figment with optional environment overrides.

## Consequences

- Config files are easy for operators to read and modify by hand.
- figment gives us a unified loader that combines YAML files with environment variables, so values like `UMANS_GATE_BIND` can override the file without editing it.
- YAML's indentation is sometimes error-prone; we validate the file eagerly and report clear errors on startup.
- The same `GatewayConfig` types serialize and deserialize with serde, keeping the file format and internal model in sync.

## Status: Accepted
