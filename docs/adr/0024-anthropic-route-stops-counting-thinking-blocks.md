# Anthropic route stops counting thinking blocks

The upstream gateway (`api.code.umans.ai`) does not populate
`usage.output_tokens_details.thinking_tokens` for non-Claude models
(GLM, Kimi, Qwen) on the Anthropic-compatible route. The proxy's
`thinking_block_count` — derived from counting `content_block_start`
events of type `"thinking"` — therefore produces a non-zero count with
a null `thinking_tokens`, causing the dashboard to show "N req w/ think
(unmeasured)" for every thinking-enabled request. This is noise: the
block count is structurally correct but carries no actionable signal
since the token cost is unmeasurable on this route.

We stop counting thinking blocks on the Anthropic route (set
`thinking_block_count = null` in both `extractAnthropicStreaming` and
`extractAnthropicNonStreaming`). We keep the `thinking_tokens`
extraction pipeline alive — it still reads `output_tokens_details` if
present — so the proxy is forward-compatible if the gateway ever starts
reporting it. The OpenAI route is unaffected: it continues to count
`reasoning_content` presence as before.

The dashboard gates the "unmeasured" fallback label on
`provider === "openai"`: Anthropic rows never render the unmeasured
branch, even when stale `thinking_block_count > 0` rows exist in the
ring buffer from before this change. This ensures existing captures do
not produce noise while the ring buffer ages them out.

## Considered options

- **A. Remove all thinking capture on the Anthropic route** (stop
  reading `output_tokens_details` too). Rejected: loses forward
  compatibility and a free signal if the gateway changes.
- **B. Stop counting blocks, keep `thinking_tokens` extraction** —
  chosen. New captures write `thinking_block_count = null`, so the SQL
  `requests_with_thinking` sum stops accruing. Stale rows are handled
  by the dashboard gate (see below). The `thinking_tokens` extraction
  pipeline stays alive for forward compatibility.
- **C. Gate `thinking_block_count` on `thinking_tokens` null** (zero
  the count when tokens are null). Rejected: conflates "did thinking
  happen?" with "was thinking cost measured?" into one field,
  destroying structural information for no gain over B.

## Stale row handling

Two complementary mechanisms suppress "unmeasured" noise on the
Anthropic route:

1. **Extractor**: new captures write `thinking_block_count = null`,
   so `requests_with_thinking` stops accruing.
2. **Dashboard gate**: `thinkingSub` renders the "unmeasured" branch
   only when `provider === "openai"`. Existing Anthropic rows with
   stale `thinking_block_count > 0` are silently suppressed in the UI
   without a database migration.

A one-time SQL migration (`UPDATE captures SET thinking_block_count =
NULL WHERE provider = 'anthropic' AND thinking_tokens IS NULL`) was
considered and rejected: the dashboard gate achieves the same
user-visible result without touching existing data, and the ring
buffer will naturally overwrite stale rows over time.

## Consequences

- The `thinking_block_count` column stays in the schema (shared with
  the OpenAI route). Anthropic rows simply write `null`.
- The dashboard's "unmeasured" label is now OpenAI-only. Anthropic
  rows show thinking cost only when `thinking_tokens > 0` (measured).
- If the gateway ever starts reporting `output_tokens_details` on the
  Anthropic route, `thinking_tokens` will be captured and the dashboard
  will show measured thinking cost — no code change needed.
- A dashboard test asserts Anthropic rows with
  `requests_with_thinking > 0` but `total_thinking_tokens = 0` produce
  no `thinkingSub` (undefined).
