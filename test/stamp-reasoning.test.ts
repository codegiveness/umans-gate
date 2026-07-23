import { expect, test } from "bun:test";
import { stampReasoning } from "../src/stamp-reasoning.js";
import type { OpenAiBody } from "../src/types.js";

test("does NOT strip max_tokens or thinking, does NOT inject reasoning_effort", () => {
  const body: OpenAiBody = {
    model: "umans-coder",
    max_tokens: 4096,
    thinking: { type: "enabled" },
  };
  expect(stampReasoning(body, { reasoningEffort: "high" })).toBe(false);
  // max_tokens and thinking preserved (respect-if-present)
  expect(body.max_tokens).toBe(4096);
  expect(body.thinking).toEqual({ type: "enabled" });
  // reasoning_effort NOT injected
  expect(body.reasoning_effort).toBeUndefined();
});

test("respects existing reasoning_effort=high", () => {
  const body: OpenAiBody = { model: "umans-coder", reasoning_effort: "high" };
  expect(stampReasoning(body, { reasoningEffort: "high" })).toBe(false);
  expect(body.reasoning_effort).toBe("high");
});

test("respects mismatched reasoning_effort (does NOT overwrite)", () => {
  const body: OpenAiBody = { model: "umans-coder", reasoning_effort: "low" as never };
  expect(stampReasoning(body, { reasoningEffort: "max" })).toBe(false);
  // reasoning_effort respected, NOT overwritten
  expect(body.reasoning_effort as string).toBe("low");
});

test("returns false for empty body (does NOT inject)", () => {
  const body: OpenAiBody = {};
  expect(stampReasoning(body, { reasoningEffort: "high" })).toBe(false);
  expect(body.reasoning_effort).toBeUndefined();
});

test("does NOT delete reasoning_effort when feature is disabled", () => {
  const body: OpenAiBody = { model: "umans-coder", reasoning_effort: "high" };
  expect(stampReasoning(body, { reasoningEffort: null })).toBe(false);
  // reasoning_effort respected, NOT deleted
  expect(body.reasoning_effort).toBe("high");
  expect(Object.hasOwn(body, "reasoning_effort")).toBe(true);
});

test("returns false for empty body when feature is disabled", () => {
  const body: OpenAiBody = {};
  expect(stampReasoning(body, { reasoningEffort: null })).toBe(false);
  expect(Object.hasOwn(body, "reasoning_effort")).toBe(false);
});

test("respects reasoning_effort=none (does NOT strip or overwrite)", () => {
  const body: OpenAiBody = {
    model: "umans-glm-5.2",
    reasoning_effort: "none" as never,
    max_tokens: 8192,
    thinking: { type: "adaptive" },
  };
  expect(stampReasoning(body, { reasoningEffort: "max" })).toBe(false);
  expect(body.reasoning_effort as string).toBe("none");
  expect(body.max_tokens).toBe(8192);
  expect(body.thinking).toEqual({ type: "adaptive" });
});

test("respects reasoning_effort=off (does NOT strip or overwrite)", () => {
  const body: OpenAiBody = {
    model: "umans-glm-5.2",
    reasoning_effort: "off" as never,
    max_tokens: 4096,
    thinking: { type: "enabled" },
  };
  expect(stampReasoning(body, { reasoningEffort: "high" })).toBe(false);
  expect(body.reasoning_effort as string).toBe("off");
  expect(body.max_tokens).toBe(4096);
  expect(body.thinking).toEqual({ type: "enabled" });
});
