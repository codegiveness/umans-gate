# 6. Why Auto-Configuration from a Remote Model List

## Context

First-time users do not always know the current model list or the correct weights for the umans provider. Requiring them to write a config file before the first run adds friction and means every new model release requires manual edits.

We considered:

- **Require a hand-written config file**: simple to implement, but poor first-time experience and constantly out of date.
- **Embed a hardcoded model list**: works offline, but becomes stale whenever the upstream adds or changes a model.
- **Fetch the model list from a remote API at startup**: keeps the default config current, while keeping a hardcoded fallback for offline or failed requests.

## Decision

When no config file exists, umans-gate fetches the model list from `https://api.code.umans.ai/v1/models/info`, assigns every model a weight of `1.0`, sets provider capacity to `4.0`, and starts from the resulting configuration.

## Consequences

- A new user can run `umans-gate` with no setup and immediately proxy requests to the umans provider.
- The fetched model list is cached in the platform-specific cache directory with a 24-hour TTL, so brief disconnections do not break startup.
- If the network request fails and the cache is stale, a hardcoded fallback config with the known models is used.
- The URL can be overridden with the `UMANS_GATE_MODELS_INFO_URL` environment variable or a config value.
- This feature is for bootstrapping only; production deployments should still pin a config file to control capacity, timeouts, and bind addresses explicitly.

## Status: Accepted
