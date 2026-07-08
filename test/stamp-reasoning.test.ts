import { expect, test } from "bun:test";
import { stampReasoning } from "../src/stamp-reasoning.js";
import type { OpenAiBody } from "../src/types.js";

test("strips max_tokens and thinking and injects reasoning_effort", () => {
  const body: OpenAiBody = {
    model: "umans-coder",
    max_tokens: 4096,
    thinking: { type: "enabled" },
  };
  expect(stampReasoning(body, { reasoningEffort: "high" })).toBe(true);
  expect(body.max_tokens).toBeUndefined();
  expect(body.thinking).toBeUndefined();
  expect(body.reasoning_effort).toBe("high");
});

test("no-op when reasoning_effort already matches", () => {
  const body: OpenAiBody = { model: "umans-coder", reasoning_effort: "high" };
  expect(stampReasoning(body, { reasoningEffort: "high" })).toBe(false);
  expect(body.reasoning_effort).toBe("high");
});

test("overwrites mismatched reasoning_effort", () => {
  const body: OpenAiBody = { model: "umans-coder", reasoning_effort: "low" as never };
  expect(stampReasoning(body, { reasoningEffort: "max" })).toBe(true);
  expect(body.reasoning_effort).toBe("max");
});

test("returns false for empty body", () => {
  const body: OpenAiBody = {};
  expect(stampReasoning(body, { reasoningEffort: "high" })).toBe(true);
  expect(body.reasoning_effort).toBe("high");
});

test("deletes reasoning_effort when feature is disabled", () => {
  const body: OpenAiBody = { model: "umans-coder", reasoning_effort: "high" };
  expect(stampReasoning(body, { reasoningEffort: null })).toBe(true);
  expect(body.reasoning_effort).toBeUndefined();
  expect(Object.prototype.hasOwnProperty.call(body, "reasoning_effort")).toBe(false);
});

test("returns false for empty body when feature is disabled", () => {
  const body: OpenAiBody = {};
  expect(stampReasoning(body, { reasoningEffort: null })).toBe(false);
  expect(Object.prototype.hasOwnProperty.call(body, "reasoning_effort")).toBe(false);
});
