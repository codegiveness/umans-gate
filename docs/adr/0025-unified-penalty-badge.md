# Unified penalty badge: extend gate-health to all budgets + extract PenaltyBadge

## Status

Accepted

## Date

2026-07-28

## Context

The dashboard had two penalty surfaces that could disagree:

1. **GateStatus health badge** (`dashboard/src/components/gate-status.tsx`) —
   mounted in the CaptureList header. Consumes `GateStats` (WebSocket,
   real-time). Shows admission state (boxed/demoted/low/high) merged with the
   **single most-urgent budget** via `computeGateHealth`. The WS payload only
   carries `priorityBudgetSummary` (one entry, picked by `selectMostUrgentBudget`
   server-side), so this badge can never show more than one budget category at a
   time.

2. **PriorityBudgetCards** (`dashboard/src/components/usage-tab.tsx`) —
   mounted in UsageTab. Consumes `UsageSnapshot` (polled 30 s). Shows **all**
   budget categories as individual cards, each with its own tier bar and
   `overBudgetToday` / `mode` / `resetsAt` detail. No single summary; the user
   must scan N cards to know if anything is wrong.

The user asked for one badge that aggregates **every** active penalty signal —
account-level boxing, account-level demotion, non-normal service mode, **and**
pressure across **all** budget categories — and lists which models are
affected. The existing GateStatus badge was the natural home (it already does
admission + one budget), but it needed widening to all budgets and extraction
into a reusable component so it could mount in both the captures view and the
usage view.

Three divergence points between the user's initial spec and the existing code
had to be resolved before implementation:

- **`priorityLow` tier.** Spec said "red when `priorityLow`". The existing
  `computeStatus` distinguishes `boxed`/`demoted` (red, hard block) from
  `priorityLow`-without-boxing (amber, soft deprioritization). Making
  `priorityLow` unconditionally red would erase the operational distinction
  between "you are blocked" and "you are deprioritized but still flowing."
- **Per-category `mode !== "interactive"`.** Spec wanted this to trigger
  amber. `budgetTier()` only checked `overBudgetToday` (red) and `usedPct >= 80`
  (amber); it ignored `mode` entirely. No upstream docs explain what the
  `mode` field means beyond `"interactive"` appearing on healthy categories —
  the assumption is that any non-`"interactive"` value signals degradation.
- **Models affected for account-level penalties.** `priorityBudget[].models[]`
  lists models per category, but account-level boxing/demotion has no model list.
  Inventing a union of all category models would fabricate a causal rule the
  upstream does not state.

## Decision

Extend `computeGateHealth` (the existing pure function in
`dashboard/src/lib/gate-health.ts`) to accept **all** budget entries instead of
one, add `mode` and `models` to the budget input type, include `mode !==
"interactive"` as an amber trigger, and return structured tooltip data
(offending categories with their models, admission detail) alongside the badge
label/variant/className. Extract the health-badge IIFE from `GateStatus` into a
shared `<PenaltyBadge>` component that consumes the extended result. Mount
`<PenaltyBadge>` in **both** CaptureList (inside GateStatus) and UsageTab (above
PriorityBudgetCards).

Data wiring: lift `useUsage()` to the App level and pass the resulting
`UsageSnapshot` to both consumers. `PenaltyBadge` input is built by a pure
`mergePenaltyInput(gateStats, usageSnapshot)` that takes admission fields from
`GateStats` (WS, more recent) and the budget array from `UsageSnapshot` (polled,
complete). When `GateStats` is null (UsageTab mount), admission fields come
from `UsageSnapshot` directly.

### Severity tiering (resolved)

| Signal | Tier | Rationale |
|---|---|---|
| `boxed` (priorityLow + boxedUntil) | red | hard block — account cannot make requests |
| `unitsDemoted` | red | hard degrade — account demoted to lower tier |
| any budget `overBudgetToday === true` | red | hard budget breach — category shut off |
| `priorityLow` (no boxing) | amber | soft degrade — deprioritized but still flowing |
| any `serviceMode.current` in low modes | amber | soft degrade — account-wide service mode |
| any budget `mode !== "interactive"` | amber | soft degrade — category degraded |
| any budget `usedPct >= 80` | amber | early warning — approaching limit |
| other non-normal `serviceMode` | blue | informational — non-normal but not degraded |
| none of the above | green | healthy |

`priorityLow` without boxing stays **amber**, not red. This preserves the
operational distinction the existing code already encodes.

### Badge body content

The pill shows a short summary, not a wall of text:

| Tier | Badge body | Example |
|---|---|---|
| red (boxed) | `boxed · resets 2h 15m` | countdown to `boxedUntil` |
| red (demoted) | `demoted · resets 5h 0m` | countdown to `demotedUntil` |
| red (budget over) | `frontier 100%` | worst offending category label + `usedPct` |
| amber | `frontier 95%, kimi-k3 88%` | offending category labels + `usedPct`, comma-joined |
| green | `healthy` | no penalties |

`boxedReason` and full per-category detail (models, mode, resets) live in the
tooltip, not the body.

### Models affected

- **Per-category penalty**: show `entry.models[]` from that category — this is
  the affected model list, taken directly from `/v1/usage`.
- **Account-level penalty** (boxed/demoted/service-mode): no model list exists
  in the data. The tooltip shows "Account-wide — all models". The proxy does
  not invent a model list for account-level penalties because the upstream
  does not state which models are affected.

### Offending category definition

A budget category appears in the tooltip's "affected categories" section when
**any** of: `overBudgetToday === true`, `mode !== "interactive"`, or
`usedPct >= 80`. This matches the amber tier triggers exactly — if a category
makes the badge amber, it is listed in the tooltip explaining why.

## Alternatives considered

### Path A: new standalone `PenaltyStatusBadge` in UsageTab only

Create a separate component that consumes `UsageSnapshot`, leaving GateStatus
untouched. Rejected because it produces two competing penalty badges (GateStatus
in CaptureList, PenaltyStatusBadge in UsageTab) that can show different tiers
when WS and poll diverge. The user explicitly asked for "all in one badge" — one
component, one logic, one look.

### Path B: extend WS payload to carry all budget entries

Add `priorityBudget: PriorityBudgetEntry[]` to the `GateStats` WS payload
alongside the existing `priorityBudgetSummary`. Rejected because budget entries
only change when the server polls `/v1/usage` (30 s cycle) — the WS push would
carry the same 30 s-stale data, so real-time WS offers no freshness benefit for
budgets. The pure merge function achieves the same result without touching the
WS contract or the backend.

### Path C: derive model union for account-level penalties

When the account is boxed, show the union of all `priorityBudget[].models[]` as
"affected models." Rejected because this invents a causal rule the upstream does
not state. Account-level boxing might not affect every budget-category model.
The proxy's stated stance (CONTEXT.md: "the upstream enforces the budget; the
proxy only surfaces it") applies — surface observed state, don't fabricate
causality.

## Consequences

- `computeGateHealth` interface changes: `budget` → `budgets[]`,
  `GateHealthBudget` gains `mode` and `models`. Single caller (GateStatus) — low
  blast radius. Tests in `gate-health.test.ts` must be extended for multi-budget
  input, `mode !== "interactive"` amber, and models in tooltip data.
- `GateHealthResult` return type grows: adds `offendingCategories[]` and
  `admissionDetail` for tooltip rendering. `<PenaltyBadge>` renders both the
  pill and the tooltip from this structured result.
- `GateStatus` loses its health-badge IIFE (lines 186-259) and renders
  `<PenaltyBadge>` instead. External API (`{ stats: GateStats | null }`) is
  unchanged; CaptureList props gain `usageSnapshot` (threaded from App-level
  `useUsage()`).
- App.tsx lifts `useUsage()` to a single call shared by CaptureList and
  UsageTab. Both views see the same snapshot — no drift between tabs. One poll,
  not two.
- `budgetTier()` in `badge-colors.ts` is **not** modified. The `mode !==
  "interactive"` check lives in `computeGateHealth`, not in the shared
  `budgetTier()` helper, so PriorityBudgetCards (which uses `budgetTier` for its
  tier bars) is unaffected.
- The "Gate health" glossary term (CONTEXT.md) already describes this badge.
  No new glossary term is needed for the badge itself; two supporting terms
  ("Penalty signal" and "Affected models") are added to sharpen the vocabulary.
- Staleness: budget pressure in the CaptureList badge can lag up to 30 s behind
  the upstream. Admission state stays real-time via WS. This is acceptable
  because budgets change on the upstream's 30 s poll cycle — WS would not be
  fresher.
