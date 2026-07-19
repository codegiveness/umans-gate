# 03 — Two storage tables: continuous samples + state-change events

Type: grilling
Status: resolved
Blocked by: (none)

## Question

Continuous time-series, state-change events, or both?

## Answer

**Both.** Two SQLite tables:

- `usage_samples` — one row per coalesced poll (ambient signal: concurrency,
  tokens, requests, window)
- `usage_events` — one row per degradation transition (priority tuple or
  service_mode tuple change)

### Rationale

The hypothesis has two halves:

1. "Is there a 24h non-stop automation pattern?" — answered by *density* of
   activity over UTC hours. Needs continuous samples to see when traffic
   actually flows.
2. "Does priority/service_mode degradation cluster in that window?" — answered
   by *when bans start and end*. Needs discrete events with onset/resolution
   timestamps.

A alone loses ban duration precision. B alone loses the ambient signal. The
snapshot already fires `onChange` on every refresh; wiring a state-change
detector onto that callback is cheap. Two tables, one poll, minimal extra
cost.

### Note

User clarification: priority boxing trigger is known (concurrent_sessions
hitting `concurrencyHardCap`). Service_mode trigger is unknown (umans doesn't
publish the threshold). The event table stays minimal (timestamp + field +
old/new + ambient context); the *cause* of a service_mode flip can't be
logged, only the transition.
