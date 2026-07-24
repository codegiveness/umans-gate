import { expect, test } from "bun:test";
import { STAMP_OVERLAY } from "../src/stamp-catalog.js";
import { stampReasoning } from "../src/stamp-reasoning.js";
import type { OpenAiBody } from "../src/types.js";

const CODER_POLICY = STAMP_OVERLAY["umans-coder"];
const GLM_POLICY = STAMP_OVERLAY["umans-glm*"];
const FLASH_POLICY = STAMP_OVERLAY["umans-flash"];

// ─── No-op cases ───────────────────────────────────────────────────────────

test("does nothing when reasoningEffort is null", () => {
  const body: OpenAiBody = { model: "umans-coder", reasoning_effort: "high" };
  expect(stampReasoning(body, { reasoningEffort: null })).toBe(false);
  expect(body.reasoning_effort).toBe("high");
});

test("does nothing when both reasoning_effort and thinking are absent", () => {
  const body: OpenAiBody = { model: "umans-coder", max_tokens: 4096 };
  expect(stampReasoning(body, { reasoningEffort: "high" })).toBe(false);
  expect(body.reasoning_effort).toBeUndefined();
});

test("does nothing when thinking is disabled and reasoning_effort absent (canDisable=true)", () => {
  const body: OpenAiBody = {
    model: "umans-flash",
    thinking: { type: "disabled" },
  };
  expect(stampReasoning(body, { reasoningEffort: "high", policy: FLASH_POLICY })).toBe(false);
  expect(body.reasoning_effort).toBeUndefined();
  expect(body.thinking).toEqual({ type: "disabled" });
});

// ─── Inject reasoning_effort from thinking ─────────────────────────────────

test("injects reasoning_effort when thinking is enabled (umans-coder)", () => {
  const body: OpenAiBody = {
    model: "umans-coder",
    thinking: { type: "enabled" },
    max_tokens: 4096,
  };
  expect(stampReasoning(body, { reasoningEffort: "high", policy: CODER_POLICY })).toBe(true);
  expect(body.reasoning_effort).toBe("high");
  expect(body.thinking).toBeUndefined();
});

test("injects reasoning_effort=max when thinking is adaptive (umans-glm)", () => {
  const body: OpenAiBody = {
    model: "umans-glm-5.2",
    thinking: { type: "adaptive" },
  };
  expect(stampReasoning(body, { reasoningEffort: "max", policy: GLM_POLICY })).toBe(true);
  expect(body.reasoning_effort).toBe("max");
  expect(body.thinking).toBeUndefined();
});

test("does not inject when thinking is disabled and canDisableThinking=false (umans-coder)", () => {
  const body: OpenAiBody = {
    model: "umans-coder",
    thinking: { type: "disabled" },
  };
  expect(stampReasoning(body, { reasoningEffort: "high", policy: CODER_POLICY })).toBe(false);
  expect(body.reasoning_effort).toBeUndefined();
  expect(body.thinking).toEqual({ type: "disabled" });
});

// ─── Force existing reasoning_effort ───────────────────────────────────────

test("forces existing reasoning_effort=low to high (umans-coder)", () => {
  const body: OpenAiBody = { model: "umans-coder", reasoning_effort: "low" };
  expect(stampReasoning(body, { reasoningEffort: "high", policy: CODER_POLICY })).toBe(true);
  expect(body.reasoning_effort).toBe("high");
});

test("forces existing reasoning_effort=high to max (umans-glm)", () => {
  const body: OpenAiBody = { model: "umans-glm-5.2", reasoning_effort: "high" };
  expect(stampReasoning(body, { reasoningEffort: "max", policy: GLM_POLICY })).toBe(true);
  expect(body.reasoning_effort).toBe("max");
});

test("strips thinking when forcing existing reasoning_effort", () => {
  const body: OpenAiBody = {
    model: "umans-coder",
    reasoning_effort: "low",
    thinking: { type: "enabled" },
  };
  expect(stampReasoning(body, { reasoningEffort: "high", policy: CODER_POLICY })).toBe(true);
  expect(body.reasoning_effort).toBe("high");
  expect(body.thinking).toBeUndefined();
});

test("does not strip thinking when reasoning_effort already matches", () => {
  const body: OpenAiBody = {
    model: "umans-coder",
    reasoning_effort: "high",
    thinking: { type: "enabled" },
  };
  expect(stampReasoning(body, { reasoningEffort: "high", policy: CODER_POLICY })).toBe(true);
  expect(body.reasoning_effort).toBe("high");
  expect(body.thinking).toBeUndefined();
});

// ─── Disabled reasoning_effort values ──────────────────────────────────────

test("respects reasoning_effort=none when canDisableThinking=true (umans-flash)", () => {
  const body: OpenAiBody = {
    model: "umans-flash",
    reasoning_effort: "none",
    thinking: { type: "adaptive" },
  };
  expect(stampReasoning(body, { reasoningEffort: "high", policy: FLASH_POLICY })).toBe(false);
  expect(body.reasoning_effort).toBe("none");
  expect(body.thinking).toEqual({ type: "adaptive" });
});

test("forces reasoning_effort=none to high when canDisableThinking=false (umans-coder)", () => {
  const body: OpenAiBody = {
    model: "umans-coder",
    reasoning_effort: "none",
  };
  expect(stampReasoning(body, { reasoningEffort: "high", policy: CODER_POLICY })).toBe(true);
  expect(body.reasoning_effort).toBe("high");
});

test("forces reasoning_effort=off to high when canDisableThinking=false (umans-coder)", () => {
  const body: OpenAiBody = {
    model: "umans-coder",
    reasoning_effort: "off",
  };
  expect(stampReasoning(body, { reasoningEffort: "high", policy: CODER_POLICY })).toBe(true);
  expect(body.reasoning_effort).toBe("high");
});

test("respects reasoning_effort=off when canDisableThinking=true (umans-glm)", () => {
  const body: OpenAiBody = {
    model: "umans-glm-5.2",
    reasoning_effort: "off",
  };
  expect(stampReasoning(body, { reasoningEffort: "max", policy: GLM_POLICY })).toBe(false);
  expect(body.reasoning_effort).toBe("off");
});

// ─── Anthropic field stripping + temperature forcing ──────────────────────

test("strips output_config and context_management when reasoning active", () => {
  const body: OpenAiBody = {
    model: "umans-coder",
    reasoning_effort: "low",
    output_config: { effort: "high" },
    context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
  };
  expect(stampReasoning(body, { reasoningEffort: "high", policy: CODER_POLICY })).toBe(true);
  expect(body.reasoning_effort).toBe("high");
  expect(body.output_config).toBeUndefined();
  expect(body.context_management).toBeUndefined();
});

test("forces temperature=1.0 when reasoning active", () => {
  const body: OpenAiBody = {
    model: "umans-coder",
    reasoning_effort: "low",
    temperature: 0.7,
  };
  expect(stampReasoning(body, { reasoningEffort: "high", policy: CODER_POLICY })).toBe(true);
  expect(body.reasoning_effort).toBe("high");
  expect(body.temperature).toBe(1.0);
});

test("forces temperature=1.0 when injecting reasoning_effort from thinking", () => {
  const body: OpenAiBody = {
    model: "umans-coder",
    thinking: { type: "enabled" },
    temperature: 0.5,
    output_config: { effort: "low" },
    context_management: { edits: [] },
  };
  expect(stampReasoning(body, { reasoningEffort: "high", policy: CODER_POLICY })).toBe(true);
  expect(body.reasoning_effort).toBe("high");
  expect(body.thinking).toBeUndefined();
  expect(body.output_config).toBeUndefined();
  expect(body.context_management).toBeUndefined();
  expect(body.temperature).toBe(1.0);
});

test("does not strip or force temperature when reasoning is respected (disabled)", () => {
  const body: OpenAiBody = {
    model: "umans-flash",
    reasoning_effort: "none",
    temperature: 0.3,
    output_config: { effort: "high" },
    context_management: { edits: [] },
  };
  expect(stampReasoning(body, { reasoningEffort: "high", policy: FLASH_POLICY })).toBe(false);
  expect(body.temperature).toBe(0.3);
  expect(body.output_config).toBeDefined();
  expect(body.context_management).toBeDefined();
});
