// Characterization tests for validateConfig() — snapshots the EXACT pass/fail/message
// behavior of every validation rule before refactoring to a data-driven FieldRule[] table.
// These tests MUST pass identically before AND after the refactor.

import { expect, test } from "bun:test";
import { validateConfig } from "../src/config.js";
import type { RawConfig, RawConfigInput } from "../src/config.js";

// Helper: assert exactly one error message is present
function expectSingleError(r: ReturnType<typeof validateConfig>, msg: string) {
  expect(r.errors).toEqual([msg]);
}

// Helper: assert no errors
function expectNoErrors(r: ReturnType<typeof validateConfig>) {
  expect(r.errors).toEqual([]);
}

// Helper: assert exactly one warning message is present
function expectSingleWarning(r: ReturnType<typeof validateConfig>, msg: string) {
  expect(r.warnings).toEqual([msg]);
}

// ============================================================================
// port: must be an integer between 1 and 65535
// ============================================================================

test("char: port — valid values pass", () => {
  expectNoErrors(validateConfig({ port: 1 }));
  expectNoErrors(validateConfig({ port: 80 }));
  expectNoErrors(validateConfig({ port: 65535 }));
  expectNoErrors(validateConfig({ port: 1945 }));
});

test("char: port — 0 fails", () => {
  expectSingleError(validateConfig({ port: 0 }), "port must be an integer between 1 and 65535");
});

test("char: port — 65536 fails", () => {
  expectSingleError(validateConfig({ port: 65536 }), "port must be an integer between 1 and 65535");
});

test("char: port — negative fails", () => {
  expectSingleError(validateConfig({ port: -1 }), "port must be an integer between 1 and 65535");
});

test("char: port — float fails", () => {
  expectSingleError(validateConfig({ port: 80.5 }), "port must be an integer between 1 and 65535");
});

test("char: port — undefined (omitted) passes (default applied)", () => {
  expectNoErrors(validateConfig({ port: undefined }));
});

test("char: port — numeric string coerced and passes", () => {
  const r = validateConfig({ port: "7777" });
  expectNoErrors(r);
  expect(r.normalized.port).toBe(7777);
});

test("char: port — non-numeric string fails coercion then validation", () => {
  const r = validateConfig({ port: "abc" as unknown as number });
  expect(r.ok).toBe(false);
  // "abc" is not in INT_FIELDS coercion path that produces a number, so it stays as string
  // and Number.isInteger fails
  expect(r.errors.length).toBeGreaterThan(0);
});

// ============================================================================
// max_captures: must be an integer >= 200
// ============================================================================

test("char: max_captures — valid values pass", () => {
  expectNoErrors(validateConfig({ max_captures: 200 }));
  expectNoErrors(validateConfig({ max_captures: 5000 }));
});

test("char: max_captures — 199 fails (below minimum)", () => {
  expectSingleError(
    validateConfig({ max_captures: 199 }),
    "max_captures must be an integer >= 200",
  );
});

test("char: max_captures — 1 fails (below minimum)", () => {
  expectSingleError(validateConfig({ max_captures: 1 }), "max_captures must be an integer >= 200");
});

test("char: max_captures — 0 fails", () => {
  expectSingleError(validateConfig({ max_captures: 0 }), "max_captures must be an integer >= 200");
});

test("char: max_captures — negative fails", () => {
  expectSingleError(validateConfig({ max_captures: -1 }), "max_captures must be an integer >= 200");
});

test("char: max_captures — float fails", () => {
  expectSingleError(
    validateConfig({ max_captures: 1.5 }),
    "max_captures must be an integer >= 200",
  );
});

test("char: max_captures — numeric string coerced and passes", () => {
  const r = validateConfig({ max_captures: "5000" });
  expectNoErrors(r);
  expect(r.normalized.max_captures).toBe(5000);
});

// ============================================================================
// db_path: must be a non-empty string
// ============================================================================

test("char: db_path — valid string passes", () => {
  expectNoErrors(validateConfig({ db_path: "./umans-gate.db" }));
});

test("char: db_path — empty string fails", () => {
  expectSingleError(validateConfig({ db_path: "" }), "db_path must be a non-empty string");
});

test("char: db_path — non-string fails", () => {
  expectSingleError(
    validateConfig({ db_path: 123 as unknown as string }),
    "db_path must be a non-empty string",
  );
});

test("char: db_path — undefined passes", () => {
  expectNoErrors(validateConfig({ db_path: undefined }));
});

// ============================================================================
// idle_timeout: must be an integer between 1 and 255
// ============================================================================

test("char: idle_timeout — valid values pass", () => {
  expectNoErrors(validateConfig({ idle_timeout: 1 }));
  expectNoErrors(validateConfig({ idle_timeout: 100 }));
  expectNoErrors(validateConfig({ idle_timeout: 255 }));
});

test("char: idle_timeout — 0 fails", () => {
  expectSingleError(
    validateConfig({ idle_timeout: 0 }),
    "idle_timeout must be an integer between 1 and 255",
  );
});

test("char: idle_timeout — 256 fails", () => {
  expectSingleError(
    validateConfig({ idle_timeout: 256 }),
    "idle_timeout must be an integer between 1 and 255",
  );
});

test("char: idle_timeout — float fails", () => {
  expectSingleError(
    validateConfig({ idle_timeout: 100.5 }),
    "idle_timeout must be an integer between 1 and 255",
  );
});

test("char: idle_timeout — numeric string coerced and passes", () => {
  const r = validateConfig({ idle_timeout: "120" });
  expectNoErrors(r);
  expect(r.normalized.idle_timeout).toBe(120);
});

// ============================================================================
// upstream_protocol: must be 'http1.1' or 'http2' (case-insensitive)
// ============================================================================

test("char: upstream_protocol — valid values pass", () => {
  expectNoErrors(validateConfig({ upstream_protocol: "http1.1" }));
  expectNoErrors(validateConfig({ upstream_protocol: "http2" }));
  expectNoErrors(validateConfig({ upstream_protocol: "h2" }));
});

test("char: upstream_protocol — case-insensitive: HTTP2 passes", () => {
  expectNoErrors(validateConfig({ upstream_protocol: "HTTP2" }));
});

test("char: upstream_protocol — case-insensitive: H2 passes", () => {
  expectNoErrors(validateConfig({ upstream_protocol: "H2" }));
});

test("char: upstream_protocol — invalid value fails", () => {
  expectSingleError(
    validateConfig({ upstream_protocol: "http3" }),
    "upstream_protocol must be 'http1.1' or 'http2'",
  );
});

test("char: upstream_protocol — empty string fails", () => {
  expectSingleError(
    validateConfig({ upstream_protocol: "" }),
    "upstream_protocol must be 'http1.1' or 'http2'",
  );
});

// ============================================================================
// stamp_claude_code_enabled: must be a boolean
// ============================================================================

test("char: stamp_claude_code_enabled — boolean true passes", () => {
  expectNoErrors(validateConfig({ stamp_claude_code_enabled: true }));
});

test("char: stamp_claude_code_enabled — boolean false passes", () => {
  expectNoErrors(validateConfig({ stamp_claude_code_enabled: false }));
});

test("char: stamp_claude_code_enabled — undefined passes", () => {
  expectNoErrors(validateConfig({ stamp_claude_code_enabled: undefined }));
});

test("char: stamp_claude_code_enabled — string fails", () => {
  expectSingleError(
    validateConfig({ stamp_claude_code_enabled: "yes" as unknown as boolean }),
    "stamp_claude_code_enabled must be a boolean",
  );
});

test("char: stamp_claude_code_enabled — number fails", () => {
  expectSingleError(
    validateConfig({ stamp_claude_code_enabled: 1 as unknown as boolean }),
    "stamp_claude_code_enabled must be a boolean",
  );
});

// ============================================================================
// stamp_reasoning_effort_enabled: must be a boolean
// ============================================================================

test("char: stamp_reasoning_effort_enabled — boolean passes", () => {
  expectNoErrors(validateConfig({ stamp_reasoning_effort_enabled: true }));
  expectNoErrors(validateConfig({ stamp_reasoning_effort_enabled: false }));
  expectNoErrors(validateConfig({ stamp_reasoning_effort_enabled: undefined }));
});

test("char: stamp_reasoning_effort_enabled — string fails", () => {
  expectSingleError(
    validateConfig({ stamp_reasoning_effort_enabled: "yes" as unknown as boolean }),
    "stamp_reasoning_effort_enabled must be a boolean",
  );
});

test("char: stamp_reasoning_effort_enabled — number fails", () => {
  expectSingleError(
    validateConfig({ stamp_reasoning_effort_enabled: 1 as unknown as boolean }),
    "stamp_reasoning_effort_enabled must be a boolean",
  );
});

// ============================================================================
// warmer_enabled: must be a boolean
// ============================================================================

test("char: warmer_enabled — boolean passes", () => {
  expectNoErrors(validateConfig({ warmer_enabled: true }));
  expectNoErrors(validateConfig({ warmer_enabled: false }));
  expectNoErrors(validateConfig({ warmer_enabled: undefined }));
});

test("char: warmer_enabled — string fails", () => {
  expectSingleError(
    validateConfig({ warmer_enabled: "yes" as unknown as boolean }),
    "warmer_enabled must be a boolean",
  );
});

test("char: warmer_enabled — number fails", () => {
  expectSingleError(
    validateConfig({ warmer_enabled: 1 as unknown as boolean }),
    "warmer_enabled must be a boolean",
  );
});

// ============================================================================
// warmer_interval_ms: must be an integer >= 1000
// ============================================================================

test("char: warmer_interval_ms — valid values pass", () => {
  expectNoErrors(validateConfig({ warmer_interval_ms: 1000 }));
  expectNoErrors(validateConfig({ warmer_interval_ms: 20000 }));
});

test("char: warmer_interval_ms — 999 fails", () => {
  expectSingleError(
    validateConfig({ warmer_interval_ms: 999 }),
    "warmer_interval_ms must be an integer >= 1000",
  );
});

test("char: warmer_interval_ms — 0 fails", () => {
  expectSingleError(
    validateConfig({ warmer_interval_ms: 0 }),
    "warmer_interval_ms must be an integer >= 1000",
  );
});

test("char: warmer_interval_ms — float fails", () => {
  expectSingleError(
    validateConfig({ warmer_interval_ms: 1500.5 }),
    "warmer_interval_ms must be an integer >= 1000",
  );
});

test("char: warmer_interval_ms — numeric string coerced and passes", () => {
  const r = validateConfig({ warmer_interval_ms: "20000" });
  expectNoErrors(r);
  expect(r.normalized.warmer_interval_ms).toBe(20000);
});

// ============================================================================
// umans_api_key: must be a string
// ============================================================================

test("char: umans_api_key — string passes", () => {
  expectNoErrors(validateConfig({ umans_api_key: "sk-abc123" }));
  expectNoErrors(validateConfig({ umans_api_key: "" }));
});

test("char: umans_api_key — non-string fails", () => {
  expectSingleError(
    validateConfig({ umans_api_key: 123 as unknown as string }),
    "umans_api_key must be a string",
  );
});

test("char: umans_api_key — undefined passes", () => {
  expectNoErrors(validateConfig({ umans_api_key: undefined }));
});

// ============================================================================
// usage_refresh_ms: must be an integer >= 1000
// ============================================================================

test("char: usage_refresh_ms — valid values pass", () => {
  expectNoErrors(validateConfig({ usage_refresh_ms: 1000 }));
  expectNoErrors(validateConfig({ usage_refresh_ms: 60000 }));
});

test("char: usage_refresh_ms — 999 fails", () => {
  expectSingleError(
    validateConfig({ usage_refresh_ms: 999 }),
    "usage_refresh_ms must be an integer >= 1000",
  );
});

test("char: usage_refresh_ms — float fails", () => {
  expectSingleError(
    validateConfig({ usage_refresh_ms: 1000.5 }),
    "usage_refresh_ms must be an integer >= 1000",
  );
});

test("char: usage_refresh_ms — numeric string coerced and passes", () => {
  const r = validateConfig({ usage_refresh_ms: "60000" });
  expectNoErrors(r);
  expect(r.normalized.usage_refresh_ms).toBe(60000);
});

// ============================================================================
// models_refresh_ms: must be an integer >= 1000
// ============================================================================

test("char: models_refresh_ms — valid values pass", () => {
  expectNoErrors(validateConfig({ models_refresh_ms: 1000 }));
  expectNoErrors(validateConfig({ models_refresh_ms: 3600000 }));
});

test("char: models_refresh_ms — 999 fails", () => {
  expectSingleError(
    validateConfig({ models_refresh_ms: 999 }),
    "models_refresh_ms must be an integer >= 1000",
  );
});

test("char: models_refresh_ms — float fails", () => {
  expectSingleError(
    validateConfig({ models_refresh_ms: 1000.5 }),
    "models_refresh_ms must be an integer >= 1000",
  );
});

// ============================================================================
// concurrency_hard_cap: must be an integer >= 1
// ============================================================================

test("char: concurrency_hard_cap — valid values pass", () => {
  expectNoErrors(validateConfig({ concurrency_hard_cap: 1 }));
  expectNoErrors(validateConfig({ concurrency_hard_cap: 10 }));
});

test("char: concurrency_hard_cap — 0 fails", () => {
  expectSingleError(
    validateConfig({ concurrency_hard_cap: 0 }),
    "concurrency_hard_cap must be an integer >= 1",
  );
});

test("char: concurrency_hard_cap — negative fails", () => {
  expectSingleError(
    validateConfig({ concurrency_hard_cap: -1 }),
    "concurrency_hard_cap must be an integer >= 1",
  );
});

test("char: concurrency_hard_cap — float fails", () => {
  expectSingleError(
    validateConfig({ concurrency_hard_cap: 1.5 }),
    "concurrency_hard_cap must be an integer >= 1",
  );
});

test("char: concurrency_hard_cap — numeric string coerced and passes", () => {
  const r = validateConfig({ concurrency_hard_cap: "5" });
  expectNoErrors(r);
  expect(r.normalized.concurrency_hard_cap).toBe(5);
});

// ============================================================================
// concurrency_soft_limit: must be an integer >= 1
// ============================================================================

test("char: concurrency_soft_limit — valid values pass", () => {
  expectNoErrors(validateConfig({ concurrency_soft_limit: 1 }));
  expectNoErrors(validateConfig({ concurrency_soft_limit: 5 }));
});

test("char: concurrency_soft_limit — 0 fails", () => {
  expectSingleError(
    validateConfig({ concurrency_soft_limit: 0 }),
    "concurrency_soft_limit must be an integer >= 1",
  );
});

test("char: concurrency_soft_limit — float fails", () => {
  expectSingleError(
    validateConfig({ concurrency_soft_limit: 1.5 }),
    "concurrency_soft_limit must be an integer >= 1",
  );
});

// ============================================================================
// concurrency_main_reservation: cross-field dependency on concurrency_hard_cap
// Must be a positive integer and <= hard_cap - 2 (only checked when hard_cap >= 3)
// ============================================================================

test("char: concurrency_main_reservation — valid with hard_cap=5 passes", () => {
  expectNoErrors(validateConfig({ concurrency_hard_cap: 5, concurrency_main_reservation: 1 }));
  expectNoErrors(validateConfig({ concurrency_hard_cap: 5, concurrency_main_reservation: 3 }));
});

test("char: concurrency_main_reservation — 0 fails with hard_cap=5", () => {
  const r = validateConfig({ concurrency_hard_cap: 5, concurrency_main_reservation: 0 });
  expect(r.errors).toContain("concurrency_main_reservation must be a positive integer (min 1)");
});

test("char: concurrency_main_reservation — negative fails with hard_cap=5", () => {
  const r = validateConfig({ concurrency_hard_cap: 5, concurrency_main_reservation: -1 });
  expect(r.errors).toContain("concurrency_main_reservation must be a positive integer (min 1)");
});

test("char: concurrency_main_reservation — float fails with hard_cap=5", () => {
  const r = validateConfig({ concurrency_hard_cap: 5, concurrency_main_reservation: 1.5 });
  expect(r.errors).toContain("concurrency_main_reservation must be a positive integer (min 1)");
});

test("char: concurrency_main_reservation — exceeds hard_cap-2 fails", () => {
  const r = validateConfig({ concurrency_hard_cap: 5, concurrency_main_reservation: 5 });
  expect(r.errors).toContain("concurrency_main_reservation must be <= hard_cap - 2 (=3)");
});

test("char: concurrency_main_reservation — equals hard_cap fails (exceeds resMax)", () => {
  const r = validateConfig({ concurrency_hard_cap: 5, concurrency_main_reservation: 5 });
  expect(r.errors).toContain("concurrency_main_reservation must be <= hard_cap - 2 (=3)");
});

test("char: concurrency_main_reservation — skipped when hard_cap=1 (bootstrap)", () => {
  // hard_cap=1 → resMax=-1 → reservation validation skipped
  expectNoErrors(validateConfig({ concurrency_hard_cap: 1, concurrency_main_reservation: 999 }));
});

test("char: concurrency_main_reservation — skipped when hard_cap=2 (resMax=0)", () => {
  // hard_cap=2 → resMax=0 → reservation validation skipped
  expectNoErrors(validateConfig({ concurrency_hard_cap: 2, concurrency_main_reservation: 999 }));
});

test("char: concurrency_main_reservation — skipped when hard_cap undefined", () => {
  // hard_cap defaults to 16, so resMax=14 — 999 > 14 produces an error
  const r = validateConfig({ concurrency_main_reservation: 999 });
  expect(r.errors).toContain("concurrency_main_reservation must be <= hard_cap - 2 (=14)");
});

test("char: concurrency_main_reservation — skipped when hard_cap not integer", () => {
  // hard_cap=1.5 → not Number.isInteger → reservation block skipped entirely
  // (hard_cap itself fails, but no reservation error is produced)
  const r = validateConfig({ concurrency_hard_cap: 1.5, concurrency_main_reservation: 999 });
  expect(r.errors).not.toContain("concurrency_main_reservation must be a positive integer (min 1)");
  expect(r.errors).not.toContain("concurrency_main_reservation must be <= hard_cap - 2 (=0)");
});

// ============================================================================
// concurrency_vision_reservation: cross-field dependency on concurrency_hard_cap
// Same rules as main_reservation
// ============================================================================

test("char: concurrency_vision_reservation — valid with hard_cap=5 passes", () => {
  expectNoErrors(validateConfig({ concurrency_hard_cap: 5, concurrency_vision_reservation: 1 }));
  expectNoErrors(validateConfig({ concurrency_hard_cap: 5, concurrency_vision_reservation: 3 }));
});

test("char: concurrency_vision_reservation — 0 fails with hard_cap=5 unless vision is disabled", () => {
  const r = validateConfig({ concurrency_hard_cap: 5, concurrency_vision_reservation: 0 });
  expect(r.errors).toContain("concurrency_vision_reservation must be a positive integer (min 1)");
});

test("char: concurrency_vision_reservation — 0 passes when vision_strategy is 'never'", () => {
  const r = validateConfig({
    concurrency_hard_cap: 5,
    concurrency_vision_reservation: 0,
    vision_strategy: "never",
  });
  expectNoErrors(r);
  expect(r.normalized.concurrency_vision_reservation).toBe(0);
});

test("char: concurrency_vision_reservation — normalized to 0 when vision_strategy is 'never'", () => {
  const r = validateConfig({
    concurrency_hard_cap: 5,
    concurrency_vision_reservation: 3,
    vision_strategy: "never",
  });
  expectNoErrors(r);
  expect(r.normalized.concurrency_vision_reservation).toBe(0);
});

test("char: concurrency_vision_reservation — exceeds hard_cap-2 fails", () => {
  const r = validateConfig({ concurrency_hard_cap: 5, concurrency_vision_reservation: 5 });
  expect(r.errors).toContain("concurrency_vision_reservation must be <= hard_cap - 2 (=3)");
});

test("char: concurrency_vision_reservation — skipped when hard_cap=1 (bootstrap)", () => {
  expectNoErrors(validateConfig({ concurrency_hard_cap: 1, concurrency_vision_reservation: 999 }));
});

test("char: concurrency_vision_reservation — skipped when hard_cap undefined", () => {
  // hard_cap defaults to 16, so resMax=14 — 999 > 14 produces an error
  const r = validateConfig({ concurrency_vision_reservation: 999 });
  expect(r.errors).toContain("concurrency_vision_reservation must be <= hard_cap - 2 (=14)");
});

// ============================================================================
// rate_limit_requests: -1 = unlimited, 0 = auto-derive from /v1/usage, >0 = explicit
// ============================================================================

test("char: rate_limit_requests — 0 passes (auto-derive)", () => {
  expectNoErrors(validateConfig({ rate_limit_requests: 0 }));
});

test("char: rate_limit_requests — null passes (derive from /v1/usage)", () => {
  expectNoErrors(validateConfig({ rate_limit_requests: null as unknown as number }));
});

test("char: rate_limit_requests — positive integer passes", () => {
  expectNoErrors(validateConfig({ rate_limit_requests: 100 }));
});

test("char: rate_limit_requests — -1 passes (unlimited)", () => {
  expectNoErrors(validateConfig({ rate_limit_requests: -1 }));
});

test("char: rate_limit_requests — float fails", () => {
  expectSingleError(
    validateConfig({ rate_limit_requests: 1.5 }),
    "rate_limit_requests must be -1 (unlimited), 0 (auto-derive from /v1/usage), or a positive integer",
  );
});

test("char: rate_limit_requests — numeric string coerced and passes", () => {
  const r = validateConfig({ rate_limit_requests: "100" });
  expectNoErrors(r);
  expect(r.normalized.rate_limit_requests).toBe(100);
});

// ============================================================================
// queue_timeout_ms: must be an integer >= 100
// ============================================================================

test("char: queue_timeout_ms — valid values pass", () => {
  expectNoErrors(validateConfig({ queue_timeout_ms: 100 }));
  expectNoErrors(validateConfig({ queue_timeout_ms: 30000 }));
});

test("char: queue_timeout_ms — 99 fails", () => {
  expectSingleError(
    validateConfig({ queue_timeout_ms: 99 }),
    "queue_timeout_ms must be an integer >= 100",
  );
});

test("char: queue_timeout_ms — float fails", () => {
  expectSingleError(
    validateConfig({ queue_timeout_ms: 100.5 }),
    "queue_timeout_ms must be an integer >= 100",
  );
});

// ============================================================================
// max_queue_depth: must be a positive integer
// ============================================================================

test("char: max_queue_depth — valid values pass", () => {
  expectNoErrors(validateConfig({ max_queue_depth: 1 }));
  expectNoErrors(validateConfig({ max_queue_depth: 256 }));
});

test("char: max_queue_depth — 0 fails", () => {
  expectSingleError(
    validateConfig({ max_queue_depth: 0 }),
    "max_queue_depth must be a positive integer",
  );
});

test("char: max_queue_depth — negative fails", () => {
  expectSingleError(
    validateConfig({ max_queue_depth: -1 }),
    "max_queue_depth must be a positive integer",
  );
});

// ============================================================================
// release_cooldown_ms: must be a non-negative integer
// ============================================================================

test("char: release_cooldown_ms — 0 passes", () => {
  expectNoErrors(validateConfig({ release_cooldown_ms: 0 }));
});

test("char: release_cooldown_ms — positive passes", () => {
  expectNoErrors(validateConfig({ release_cooldown_ms: 1000 }));
});

test("char: release_cooldown_ms — negative fails", () => {
  expectSingleError(
    validateConfig({ release_cooldown_ms: -1 }),
    "release_cooldown_ms must be a non-negative integer",
  );
});

test("char: release_cooldown_ms — float fails", () => {
  expectSingleError(
    validateConfig({ release_cooldown_ms: 1.5 }),
    "release_cooldown_ms must be a non-negative integer",
  );
});

// ============================================================================
// breaker_threshold: must be a positive integer
// ============================================================================

test("char: breaker_threshold — valid values pass", () => {
  expectNoErrors(validateConfig({ breaker_threshold: 1 }));
  expectNoErrors(validateConfig({ breaker_threshold: 5 }));
});

test("char: breaker_threshold — 0 fails", () => {
  expectSingleError(
    validateConfig({ breaker_threshold: 0 }),
    "breaker_threshold must be a positive integer",
  );
});

test("char: breaker_threshold — float fails", () => {
  expectSingleError(
    validateConfig({ breaker_threshold: 5.5 }),
    "breaker_threshold must be a positive integer",
  );
});

// ============================================================================
// breaker_window_ms: must be an integer >= 1000
// ============================================================================

test("char: breaker_window_ms — valid values pass", () => {
  expectNoErrors(validateConfig({ breaker_window_ms: 1000 }));
  expectNoErrors(validateConfig({ breaker_window_ms: 300000 }));
});

test("char: breaker_window_ms — 999 fails", () => {
  expectSingleError(
    validateConfig({ breaker_window_ms: 999 }),
    "breaker_window_ms must be an integer >= 1000",
  );
});

// ============================================================================
// breaker_cooldown_ms: must be an integer >= 1000
// ============================================================================

test("char: breaker_cooldown_ms — valid values pass", () => {
  expectNoErrors(validateConfig({ breaker_cooldown_ms: 1000 }));
  expectNoErrors(validateConfig({ breaker_cooldown_ms: 60000 }));
});

test("char: breaker_cooldown_ms — 999 fails", () => {
  expectSingleError(
    validateConfig({ breaker_cooldown_ms: 999 }),
    "breaker_cooldown_ms must be an integer >= 1000",
  );
});

// ============================================================================
// vision_strategy: must be 'never', 'catalog', or 'always'
// ============================================================================

test("char: vision_strategy — valid values pass", () => {
  expectNoErrors(validateConfig({ vision_strategy: "never" }));
  expectNoErrors(validateConfig({ vision_strategy: "catalog" }));
  expectNoErrors(validateConfig({ vision_strategy: "always" }));
});

test("char: vision_strategy — invalid value fails", () => {
  expectSingleError(
    validateConfig({ vision_strategy: "sometimes" as unknown as RawConfig["vision_strategy"] }),
    "vision_strategy must be 'never', 'catalog', or 'always'",
  );
});

// ============================================================================
// vision_model: must be a string
// ============================================================================

test("char: vision_model — string passes", () => {
  expectNoErrors(validateConfig({ vision_model: "umans-flash" }));
  expectNoErrors(validateConfig({ vision_model: "" }));
});

test("char: vision_model — non-string fails", () => {
  expectSingleError(
    validateConfig({ vision_model: 123 as unknown as string }),
    "vision_model must be a string",
  );
});

// ============================================================================
// vision_prompt: must be a non-empty string
// ============================================================================

test("char: vision_prompt — non-empty string passes", () => {
  expectNoErrors(validateConfig({ vision_prompt: "Describe this image" }));
});

test("char: vision_prompt — empty string fails", () => {
  expectSingleError(
    validateConfig({ vision_prompt: "" }),
    "vision_prompt must be a non-empty string",
  );
});

test("char: vision_prompt — non-string fails", () => {
  expectSingleError(
    validateConfig({ vision_prompt: 123 as unknown as string }),
    "vision_prompt must be a non-empty string",
  );
});

// ============================================================================
// vision_prompt_version: must be a positive integer
// ============================================================================

test("char: vision_prompt_version — valid values pass", () => {
  expectNoErrors(validateConfig({ vision_prompt_version: 1 }));
  expectNoErrors(validateConfig({ vision_prompt_version: 2 }));
});

test("char: vision_prompt_version — 0 fails", () => {
  expectSingleError(
    validateConfig({ vision_prompt_version: 0 }),
    "vision_prompt_version must be a positive integer",
  );
});

// ============================================================================
// vision_max_images: must be an integer between 1 and 100
// ============================================================================

test("char: vision_max_images — valid values pass", () => {
  expectNoErrors(validateConfig({ vision_max_images: 1 }));
  expectNoErrors(validateConfig({ vision_max_images: 5 }));
  expectNoErrors(validateConfig({ vision_max_images: 100 }));
});

test("char: vision_max_images — 0 fails", () => {
  expectSingleError(
    validateConfig({ vision_max_images: 0 }),
    "vision_max_images must be an integer between 1 and 100",
  );
});

test("char: vision_max_images — 101 fails", () => {
  expectSingleError(
    validateConfig({ vision_max_images: 101 }),
    "vision_max_images must be an integer between 1 and 100",
  );
});

test("char: vision_max_images — float fails", () => {
  expectSingleError(
    validateConfig({ vision_max_images: 5.5 }),
    "vision_max_images must be an integer between 1 and 100",
  );
});

// ============================================================================
// vision_max_description_tokens: must be an integer between 1 and 200000
// ============================================================================

test("char: vision_max_description_tokens — valid values pass", () => {
  expectNoErrors(validateConfig({ vision_max_description_tokens: 1 }));
  expectNoErrors(validateConfig({ vision_max_description_tokens: 4096 }));
  expectNoErrors(validateConfig({ vision_max_description_tokens: 200000 }));
});

test("char: vision_max_description_tokens — 0 fails", () => {
  expectSingleError(
    validateConfig({ vision_max_description_tokens: 0 }),
    "vision_max_description_tokens must be an integer between 1 and 200000",
  );
});

test("char: vision_max_description_tokens — 200001 fails", () => {
  expectSingleError(
    validateConfig({ vision_max_description_tokens: 200001 }),
    "vision_max_description_tokens must be an integer between 1 and 200000",
  );
});

// ============================================================================
// vision_timeout_ms: must be a non-negative integer (0 = no timeout)
// ============================================================================

test("char: vision_timeout_ms — 0 passes (no timeout)", () => {
  expectNoErrors(validateConfig({ vision_timeout_ms: 0 }));
});

test("char: vision_timeout_ms — positive passes", () => {
  expectNoErrors(validateConfig({ vision_timeout_ms: 30000 }));
});

test("char: vision_timeout_ms — negative fails", () => {
  expectSingleError(
    validateConfig({ vision_timeout_ms: -1 }),
    "vision_timeout_ms must be a non-negative integer (0 = no timeout)",
  );
});

// ============================================================================
// vision_cache_size: must be an integer >= 100
// ============================================================================

test("char: vision_cache_size — valid values pass", () => {
  expectNoErrors(validateConfig({ vision_cache_size: 100 }));
  expectNoErrors(validateConfig({ vision_cache_size: 1000 }));
});

test("char: vision_cache_size — 99 fails", () => {
  expectSingleError(
    validateConfig({ vision_cache_size: 99 }),
    "vision_cache_size must be an integer >= 100",
  );
});

// ============================================================================
// vision_concurrency: must be an integer between 1 and 20
// ============================================================================

test("char: vision_concurrency — valid values pass", () => {
  expectNoErrors(validateConfig({ vision_concurrency: 1 }));
  expectNoErrors(validateConfig({ vision_concurrency: 10 }));
  expectNoErrors(validateConfig({ vision_concurrency: 20 }));
});

test("char: vision_concurrency — 0 fails", () => {
  expectSingleError(
    validateConfig({ vision_concurrency: 0 }),
    "vision_concurrency must be an integer between 1 and 20",
  );
});

test("char: vision_concurrency — 21 fails", () => {
  expectSingleError(
    validateConfig({ vision_concurrency: 21 }),
    "vision_concurrency must be an integer between 1 and 20",
  );
});

// ============================================================================
// vision_reasoning_effort: must be 'none', 'low', 'medium', 'high', or null
// ============================================================================

test("char: vision_reasoning_effort — valid values pass", () => {
  expectNoErrors(validateConfig({ vision_reasoning_effort: "none" }));
  expectNoErrors(validateConfig({ vision_reasoning_effort: "low" }));
  expectNoErrors(validateConfig({ vision_reasoning_effort: "medium" }));
  expectNoErrors(validateConfig({ vision_reasoning_effort: "high" }));
  expectNoErrors(validateConfig({ vision_reasoning_effort: null }));
});

test("char: vision_reasoning_effort — invalid value fails", () => {
  expectSingleError(
    validateConfig({
      vision_reasoning_effort: "ultra" as unknown as RawConfig["vision_reasoning_effort"],
    }),
    "vision_reasoning_effort must be 'none', 'low', 'medium', 'high', or null",
  );
});

// ============================================================================
// vision_max_dimension: must be an integer between 256 and 8192
// ============================================================================

test("char: vision_max_dimension — valid values pass", () => {
  expectNoErrors(validateConfig({ vision_max_dimension: 256 }));
  expectNoErrors(validateConfig({ vision_max_dimension: 2048 }));
  expectNoErrors(validateConfig({ vision_max_dimension: 8192 }));
});

test("char: vision_max_dimension — 255 fails", () => {
  expectSingleError(
    validateConfig({ vision_max_dimension: 255 }),
    "vision_max_dimension must be an integer between 256 and 8192",
  );
});

test("char: vision_max_dimension — 8193 fails", () => {
  expectSingleError(
    validateConfig({ vision_max_dimension: 8193 }),
    "vision_max_dimension must be an integer between 256 and 8192",
  );
});

// ============================================================================
// vision_jpeg_quality: must be an integer between 1 and 100
// ============================================================================

test("char: vision_jpeg_quality — valid values pass", () => {
  expectNoErrors(validateConfig({ vision_jpeg_quality: 1 }));
  expectNoErrors(validateConfig({ vision_jpeg_quality: 92 }));
  expectNoErrors(validateConfig({ vision_jpeg_quality: 100 }));
});

test("char: vision_jpeg_quality — 0 fails", () => {
  expectSingleError(
    validateConfig({ vision_jpeg_quality: 0 }),
    "vision_jpeg_quality must be an integer between 1 and 100",
  );
});

test("char: vision_jpeg_quality — 101 fails", () => {
  expectSingleError(
    validateConfig({ vision_jpeg_quality: 101 }),
    "vision_jpeg_quality must be an integer between 1 and 100",
  );
});

// ============================================================================
// vision_image_format: must be 'jpeg' or 'png'
// ============================================================================

test("char: vision_image_format — valid values pass", () => {
  expectNoErrors(validateConfig({ vision_image_format: "jpeg" }));
  expectNoErrors(validateConfig({ vision_image_format: "png" }));
});

test("char: vision_image_format — invalid value fails", () => {
  expectSingleError(
    validateConfig({ vision_image_format: "gif" as unknown as RawConfig["vision_image_format"] }),
    "vision_image_format must be 'jpeg' or 'png'",
  );
});

// ============================================================================
// vision_image_detail: must be 'auto', 'low', or 'high'
// ============================================================================

test("char: vision_image_detail — valid values pass", () => {
  expectNoErrors(validateConfig({ vision_image_detail: "auto" }));
  expectNoErrors(validateConfig({ vision_image_detail: "low" }));
  expectNoErrors(validateConfig({ vision_image_detail: "high" }));
});

test("char: vision_image_detail — invalid value fails", () => {
  expectSingleError(
    validateConfig({ vision_image_detail: "ultra" as unknown as RawConfig["vision_image_detail"] }),
    "vision_image_detail must be 'auto', 'low', or 'high'",
  );
});

// ============================================================================
// vision_cache_ttl_ms: must be an integer >= 1000
// ============================================================================

test("char: vision_cache_ttl_ms — valid values pass", () => {
  expectNoErrors(validateConfig({ vision_cache_ttl_ms: 1000 }));
  expectNoErrors(validateConfig({ vision_cache_ttl_ms: 604800000 }));
});

test("char: vision_cache_ttl_ms — 999 fails", () => {
  expectSingleError(
    validateConfig({ vision_cache_ttl_ms: 999 }),
    "vision_cache_ttl_ms must be an integer >= 1000",
  );
});

// ============================================================================
// vision_cache_max_rows: must be an integer >= 100
// ============================================================================

test("char: vision_cache_max_rows — valid values pass", () => {
  expectNoErrors(validateConfig({ vision_cache_max_rows: 100 }));
  expectNoErrors(validateConfig({ vision_cache_max_rows: 10000 }));
});

test("char: vision_cache_max_rows — 99 fails", () => {
  expectSingleError(
    validateConfig({ vision_cache_max_rows: 99 }),
    "vision_cache_max_rows must be an integer >= 100",
  );
});

// ============================================================================
// vision_persistent_cache: must be a boolean
// ============================================================================

test("char: vision_persistent_cache — boolean passes", () => {
  expectNoErrors(validateConfig({ vision_persistent_cache: true }));
  expectNoErrors(validateConfig({ vision_persistent_cache: false }));
});

test("char: vision_persistent_cache — non-boolean fails", () => {
  expectSingleError(
    validateConfig({ vision_persistent_cache: "yes" as unknown as boolean }),
    "vision_persistent_cache must be a boolean",
  );
});

// ============================================================================
// capture_body_max_bytes: must be a non-negative integer (0 = unlimited)
// ============================================================================

test("char: capture_body_max_bytes — 0 passes (unlimited)", () => {
  expectNoErrors(validateConfig({ capture_body_max_bytes: 0 }));
});

test("char: capture_body_max_bytes — positive passes", () => {
  expectNoErrors(validateConfig({ capture_body_max_bytes: 1_000_000 }));
});

test("char: capture_body_max_bytes — negative fails", () => {
  expectSingleError(
    validateConfig({ capture_body_max_bytes: -1 }),
    "capture_body_max_bytes must be a non-negative integer (0 = unlimited)",
  );
});

test("char: capture_body_max_bytes — float fails", () => {
  expectSingleError(
    validateConfig({ capture_body_max_bytes: 1.5 }),
    "capture_body_max_bytes must be a non-negative integer (0 = unlimited)",
  );
});

// ============================================================================
// queue_max_depth: must be a positive integer
// ============================================================================

test("char: queue_max_depth — valid values pass", () => {
  expectNoErrors(validateConfig({ queue_max_depth: 1 }));
  expectNoErrors(validateConfig({ queue_max_depth: 100 }));
});

test("char: queue_max_depth — 0 fails", () => {
  expectSingleError(
    validateConfig({ queue_max_depth: 0 }),
    "queue_max_depth must be a positive integer",
  );
});

// ============================================================================
// ws_backpressure_limit: must be a non-negative integer (0 = Bun default)
// ============================================================================

test("char: ws_backpressure_limit — 0 passes (Bun default)", () => {
  expectNoErrors(validateConfig({ ws_backpressure_limit: 0 }));
});

test("char: ws_backpressure_limit — positive passes", () => {
  expectNoErrors(validateConfig({ ws_backpressure_limit: 1_048_576 }));
});

test("char: ws_backpressure_limit — negative fails", () => {
  expectSingleError(
    validateConfig({ ws_backpressure_limit: -1 }),
    "ws_backpressure_limit must be a non-negative integer (0 = Bun default)",
  );
});

// ============================================================================
// ws_close_on_backpressure_limit: must be a boolean
// ============================================================================

test("char: ws_close_on_backpressure_limit — boolean passes", () => {
  expectNoErrors(validateConfig({ ws_close_on_backpressure_limit: true }));
  expectNoErrors(validateConfig({ ws_close_on_backpressure_limit: false }));
});

test("char: ws_close_on_backpressure_limit — non-boolean fails", () => {
  expectSingleError(
    validateConfig({ ws_close_on_backpressure_limit: "yes" as unknown as boolean }),
    "ws_close_on_backpressure_limit must be a boolean",
  );
});

// ============================================================================
// vision_pending_max_batch: must be a positive integer
// ============================================================================

test("char: vision_pending_max_batch — valid values pass", () => {
  expectNoErrors(validateConfig({ vision_pending_max_batch: 1 }));
  expectNoErrors(validateConfig({ vision_pending_max_batch: 50 }));
});

test("char: vision_pending_max_batch — 0 fails", () => {
  expectSingleError(
    validateConfig({ vision_pending_max_batch: 0 }),
    "vision_pending_max_batch must be a positive integer",
  );
});

// ============================================================================
// Warnings
// ============================================================================

test("char: warning — warmer_enabled=false produces warning", () => {
  const r = validateConfig({ warmer_enabled: false });
  expect(r.warnings).toContain(
    "Connection warmer is disabled — first request after idle will have ~750ms cold-start penalty",
  );
  expect(r.errors).toEqual([]);
});

test("char: warning — warmer_enabled=true does NOT produce warmer warning", () => {
  const r = validateConfig({ warmer_enabled: true });
  expect(r.warnings).not.toContain(
    "Connection warmer is disabled — first request after idle will have ~750ms cold-start penalty",
  );
});

test("char: warning — rate_limit_requests=-1 produces unlimited warning", () => {
  const r = validateConfig({ rate_limit_requests: -1 });
  expect(r.warnings).toContain(
    "Rate limiting is unlimited (rate_limit_requests=-1). No request cap is enforced.",
  );
});

test("char: warning — rate_limit_requests=-1 warning suppressed when upstream is unlimited (ctx.upstreamRequestsLimit=null)", () => {
  const r = validateConfig({ rate_limit_requests: -1 }, { upstreamRequestsLimit: null });
  expect(r.warnings).not.toContain(
    "Rate limiting is unlimited (rate_limit_requests=-1). No request cap is enforced.",
  );
});

test("char: warning — rate_limit_requests=-1 warning fires when upstream has a limit (ctx.upstreamRequestsLimit=1000)", () => {
  const r = validateConfig({ rate_limit_requests: -1 }, { upstreamRequestsLimit: 1000 });
  expect(r.warnings).toContain(
    "Rate limiting is unlimited (rate_limit_requests=-1). No request cap is enforced.",
  );
});

test("char: warning — rate_limit_requests=0 does NOT produce rate-limit warning", () => {
  const r = validateConfig({ rate_limit_requests: 0 });
  expect(r.warnings).not.toContain(
    "Rate limiting is unlimited (rate_limit_requests=-1). No request cap is enforced.",
  );
});

test("char: warning — rate_limit_requests=100 does NOT produce rate-limit warning", () => {
  const r = validateConfig({ rate_limit_requests: 100 });
  expect(r.warnings).not.toContain(
    "Rate limiting is unlimited (rate_limit_requests=-1). No request cap is enforced.",
  );
});

test("char: warning — stamp_claude_code_enabled !== true produces warning", () => {
  const r = validateConfig({ stamp_claude_code_enabled: false });
  expect(r.warnings).toContain(
    "Claude Code stamping is off — ephemeral cache entries will have no default TTL, no top_k/max_tokens/thinking/output_config/context_management injection",
  );
  expect(r.errors).toEqual([]);
});

test("char: warning — stamp_claude_code_enabled=true does NOT produce Claude Code warning", () => {
  const r = validateConfig({ stamp_claude_code_enabled: true });
  expect(r.warnings).not.toContain(
    "Claude Code stamping is off — ephemeral cache entries will have no default TTL, no top_k/max_tokens/thinking/output_config/context_management injection",
  );
});

test("char: warning — umans_api_key empty produces warning", () => {
  const r = validateConfig({ umans_api_key: "" });
  expect(r.warnings).toContain(
    "umans_api_key is empty — proxy runs in fail-safe mode (worst-case limits, priority_low=true). Set umans_api_key in the Server section to enable usage-based limits.",
  );
});

test("char: warning — umans_api_key undefined produces warning", () => {
  const r = validateConfig({ umans_api_key: undefined });
  expect(r.warnings).toContain(
    "umans_api_key is empty — proxy runs in fail-safe mode (worst-case limits, priority_low=true). Set umans_api_key in the Server section to enable usage-based limits.",
  );
});

test("char: warning — umans_api_key set does NOT produce empty-key warning", () => {
  const r = validateConfig({ umans_api_key: "sk-test123" });
  expect(r.warnings).not.toContain(
    "umans_api_key is empty — proxy runs in fail-safe mode (worst-case limits, priority_low=true). Set umans_api_key in the Server section to enable usage-based limits.",
  );
});

// ============================================================================
// Default config produces all 4 warnings
// ============================================================================

test("char: default config (empty input) produces exactly the 2 default warnings", () => {
  const r = validateConfig({});
  expect(r.ok).toBe(true);
  expect(r.errors).toEqual([]);
  // Default config has: warmer_enabled=true (no warning), rate_limit_requests=0 (no warning, auto-derive),
  // stamp_claude_code_enabled=false (warning), umans_api_key="" (warning)
  expect(r.warnings).toEqual([
    "Claude Code stamping is off — ephemeral cache entries will have no default TTL, no top_k/max_tokens/thinking/output_config/context_management injection",
    "umans_api_key is empty — proxy runs in fail-safe mode (worst-case limits, priority_low=true). Set umans_api_key in the Server section to enable usage-based limits.",
  ]);
});

// ============================================================================
// Normalized config: defaults filled in for omitted fields
// ============================================================================

test("char: normalized — omitted fields get DEFAULT_CONFIG values", () => {
  const r = validateConfig({});
  expect(r.normalized.port).toBe(1945);
  expect(r.normalized.max_captures).toBe(200);
  expect(r.normalized.db_path).toBe("./umans-gate.db");
  expect(r.normalized.idle_timeout).toBe(255);
  expect(r.normalized.upstream_protocol).toBe("http1.1");
  expect(r.normalized.concurrency_hard_cap).toBe(16);
  expect(r.normalized.concurrency_soft_limit).toBe(8);
  expect(r.normalized.vision_strategy).toBe("catalog");
  expect(r.normalized.vision_model).toBe("umans-flash");
});

test("char: normalized — provided values override defaults", () => {
  const r = validateConfig({ port: 8080 });
  expect(r.normalized.port).toBe(8080);
  // Other fields still default
  expect(r.normalized.max_captures).toBe(200);
});

// ============================================================================
// ok field reflects errors.length === 0
// ============================================================================

test("char: ok — true when no errors", () => {
  expect(validateConfig({}).ok).toBe(true);
});

test("char: ok — false when errors exist", () => {
  expect(validateConfig({ port: 0 }).ok).toBe(false);
});

// ============================================================================
// Multiple errors accumulate
// ============================================================================

test("char: multiple errors — port + max_captures fail simultaneously", () => {
  const r = validateConfig({ port: 0, max_captures: -1 });
  expect(r.errors).toEqual([
    "port must be an integer between 1 and 65535",
    "max_captures must be an integer >= 200",
  ]);
  expect(r.ok).toBe(false);
});

// ============================================================================
// Cross-field: both reservations can fail simultaneously
// ============================================================================

test("char: cross-field — both reservations exceed hard_cap-2 simultaneously", () => {
  const r = validateConfig({
    concurrency_hard_cap: 5,
    concurrency_main_reservation: 5,
    concurrency_vision_reservation: 5,
  });
  expect(r.errors).toContain("concurrency_main_reservation must be <= hard_cap - 2 (=3)");
  expect(r.errors).toContain("concurrency_vision_reservation must be <= hard_cap - 2 (=3)");
});
