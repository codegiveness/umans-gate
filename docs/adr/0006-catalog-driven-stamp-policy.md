# Catalog-driven stamp policy via local overlay

The stamp pipeline made model-aware decisions with hardcoded prefix matching scattered across `stamp-catalog.ts`, `stamp-thinking.ts`, and `stamp-topk.ts`:

```typescript
isGlmModel(modelName)          // startsWith("umans-glm")
modelMatchesThinkingPattern()  // === "umans-coder" | startsWith("umans-kimi" | ...)
```

Meanwhile `/v1/models/info` was already parsed into a `Map<string, ParsedModelInfo>` by `model-info-parser.ts` and consumed by `ModelsClient` (concurrency weighting) and `vision/catalog.ts` (vision interception), but the stamp pipeline ignored it. Adding a new model family required editing several files to add `startsWith` branches, which violated the Open/Closed Principle.

## Decision

The stamp pipeline will become **catalog-driven** by extending `ParsedModelInfo` with a `stamps` field, populated from a **local overlay** merged into the parsed `/v1/models/info` response.

### Shape

```typescript
interface ParsedModelInfo {
  // ... existing fields (capabilities, base_model, etc.) unchanged ...
  stamps: {
    max_tokens: number;
    effort: "high" | "max";
    thinking: boolean;
    top_k: number | null;   // null = don't inject top_k
  };
}
```

The overlay is a declarative table keyed by model family pattern,
merged into the parsed catalog at `parseModelInfoResponse()` time:

```typescript
const STAMP_OVERLAY: Record<string, StampPolicy> = {
  "umans-glm*":   { max_tokens: 131071, effort: "max",  thinking: true,  top_k: 20 },
  "umans-coder":  { max_tokens: 32767,  effort: "high", thinking: true,  top_k: null },
  "umans-flash":  { max_tokens: 32767,  effort: "high", thinking: true,  top_k: null },
  "umans-kimi*":  { max_tokens: 32767,  effort: "high", thinking: true,  top_k: null },
  "umans-qwen*":  { max_tokens: 32767,  effort: "high", thinking: true,  top_k: null },
  "*":            { max_tokens: 32767,  effort: "high", thinking: false, top_k: null },
};
```

### Consumers

`stamp-catalog.ts` shrinks to a single lookup:

```typescript
function resolveStampPolicy(modelName, catalog): StampPolicy {
  return catalog.get(modelName)?.stamps ?? STAMP_OVERLAY["*"];
}
```

The individual stamp modules (`stamp-thinking.ts`, `stamp-topk.ts`,
`stamp-reasoning.ts`) read from the resolved policy instead of calling
`isGlmModel()` / `modelMatchesThinkingPattern()`.

### Why a local overlay, not upstream-derived

Stamp values (131071, 32767, "max", "high") are **proxy tuning**, not
model capabilities. They differ from `max_completion_tokens` and
`reasoning.default_level` for reasons specific to this proxy's
behavior. The upstream `/v1/models/info` cannot return them. A local
overlay merged into the parsed catalog is the cleanest single-source
of truth: the catalog answers "what should we stamp this model with?"

## Alternatives considered

- **Derive from existing catalog fields** (`max_completion_tokens`,
  `reasoning.default_level`): rejected because the stamp values are
  proxy-specific tuning that differs from upstream-reported limits.
  Deriving would change behavior.
- **Local stamp catalog overlay (separate from `ParsedModelInfo`)**:
  rejected because it creates two lookup points (catalog for
  capabilities, overlay for stamps), reintroducing the scattering the
  decision eliminates.
- **Fetch stamp values from upstream**: requires upstream API changes
  not in our control.

## Consequences

- `stamp-catalog.ts` shrinks from scattered `startsWith` branches to a
  single `resolveStampPolicy(modelName, catalog)` lookup.
- Adding a new model family is a single row in `STAMP_OVERLAY`, not
  code changes across 3+ files.
- `ParsedModelInfo` gains a `stamps` field; all callers that
  destructure the struct must be updated (5 callers in `src/models.ts`,
  `src/models/fetch-info.ts`, `src/model-info-parser.ts`).
- The overlay is data, not code; it can be extracted to config later
  without touching the lookup logic.
- The existing `isGlmModel()` and `modelMatchesThinkingPattern()`
  functions are deleted; their callers are rewired to
  `resolveStampPolicy()`.
