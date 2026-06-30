# 8. Why the Dashboard Binds to Localhost by Default

## Context

The dashboard has no authentication and exposes request state, kill buttons, and terminal request history. Binding it to a public interface by default would expose unauthenticated administrative controls to anyone on the network. Our target users include individuals running the gateway on a laptop or a small server without a dedicated operations team.

We considered:

- **Bind to `0.0.0.0` by default**: makes the dashboard reachable from other machines, but is dangerous for users who do not immediately lock down their firewall.
- **Bind to `127.0.0.1` by default**: only the local machine can reach the dashboard. Users who need external access can set an explicit bind address in config or place a reverse proxy in front.
- **Require authentication on first start**: more secure, but adds setup friction and would need a credentials management story.

## Decision

The dashboard binds to `127.0.0.1:3001` by default. Legacy configs that specify `dashboard_bind` default to `127.0.0.1:9090`, still localhost-only.

## Consequences

- A user who starts the gateway on an untrusted network does not accidentally expose the dashboard.
- Remote access is still possible by editing the bind address or running an authenticating reverse proxy.
- The tradeoff is acceptable because the dashboard is intended for local operators; exposing it to a wider network is an intentional opt-in.
- This default aligns with our goal of a safe zero-devops experience.

## Status: Accepted
