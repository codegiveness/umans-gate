import { expect, test } from "bun:test";
import { stampThinking } from "../src/stamp-thinking.js";
import type { AnthropicBody } from "../src/types.js";

const GLM_MAX_TOKENS = 131071;
const NON_GLM_MAX_TOKENS = 32767;
const DEFAULT_OUTPUT_CONFIG = { effort: "high" } as const;
const GLM_OUTPUT_CONFIG = { effort: "max" } as const;

test("stamps max_tokens for GLM models when enabled", () => {
  const body: AnthropicBody = { model: "umans-glm-5.2", messages: [] };
  expect(stampThinking(body, { maxTokens: true })).toBe(true);
  expect(body.max_tokens).toBe(GLM_MAX_TOKENS);
  expect(body.thinking).toBeUndefined();
  expect(body.output_config).toBeUndefined();
});

test("stamps max_tokens for non-GLM models when enabled", () => {
  const body: AnthropicBody = { model: "umans-coder", messages: [] };
  expect(stampThinking(body, { maxTokens: true })).toBe(true);
  expect(body.max_tokens).toBe(NON_GLM_MAX_TOKENS);
  expect(body.thinking).toBeUndefined();
  expect(body.output_config).toBeUndefined();
});

test("does NOT inject thinking when body lacks it (respect-if-present)", () => {
  for (const model of [
    "umans-coder",
    "umans-flash",
    "umans-kimi-7b",
    "umans-qwen-72b",
    "umans-glm-5.2",
  ]) {
    const body: AnthropicBody = { model, messages: [] };
    expect(stampThinking(body, { maxTokens: true })).toBe(true);
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
  }
});

test("does NOT stamp output_config when body lacks thinking", () => {
  const body: AnthropicBody = { model: "umans-coder", messages: [] };
  expect(stampThinking(body, { outputConfig: true })).toBe(false);
  expect(body.output_config).toBeUndefined();
});

test("stamps output_config=high for non-glm models when thinking is enabled", () => {
  const body: AnthropicBody = {
    model: "umans-coder",
    thinking: { type: "adaptive" },
    messages: [],
  };
  expect(stampThinking(body, { outputConfig: true })).toBe(true);
  expect(body.output_config).toEqual(DEFAULT_OUTPUT_CONFIG);
});

test("stamps output_config=max for umans-glm* models when thinking is enabled", () => {
  for (const model of ["umans-glm-5.2", "umans-glm-lite"]) {
    const body: AnthropicBody = { model, thinking: { type: "adaptive" }, messages: [] };
    expect(stampThinking(body, { outputConfig: true })).toBe(true);
    expect(body.output_config).toEqual(GLM_OUTPUT_CONFIG);
  }
});

test("respects existing thinking and stamps max_tokens + output_config", () => {
  const body: AnthropicBody = {
    model: "umans-coder",
    thinking: { type: "enabled" } as never,
    max_tokens: 8192,
    output_config: { effort: "low" } as never,
    messages: [],
  };
  expect(stampThinking(body, { maxTokens: true, outputConfig: true })).toBe(true);
  expect(body.thinking as { type?: string }).toEqual({ type: "enabled" });
  expect(body.max_tokens).toBe(NON_GLM_MAX_TOKENS);
  expect(body.output_config).toEqual(DEFAULT_OUTPUT_CONFIG);
});

test("respects existing thinking type=disabled and skips output_config", () => {
  const body: AnthropicBody = {
    model: "umans-coder",
    thinking: { type: "disabled" } as never,
    max_tokens: 8192,
    messages: [],
  };
  expect(stampThinking(body, { maxTokens: true, outputConfig: true })).toBe(true);
  expect(body.thinking as { type?: string }).toEqual({ type: "disabled" });
  expect(body.max_tokens).toBe(NON_GLM_MAX_TOKENS);
  expect(body.output_config).toBeUndefined();
});

test("respects existing thinking type=adaptive and stamps output_config", () => {
  const body: AnthropicBody = {
    model: "umans-glm-5.2",
    thinking: { type: "adaptive" },
    max_tokens: 100,
    messages: [],
  };
  expect(stampThinking(body, { maxTokens: true, outputConfig: true })).toBe(true);
  expect(body.thinking).toEqual({ type: "adaptive" });
  expect(body.max_tokens).toBe(GLM_MAX_TOKENS);
  expect(body.output_config).toEqual(GLM_OUTPUT_CONFIG);
});

test("does NOT stamp output_config for unknown model with thinking=false policy", () => {
  // The "*" fallback overlay entry has thinking: false.
  // Even when the client sends thinking: { type: "adaptive" }, output_config
  // should NOT be stamped because the model family doesn't support thinking.
  const body: AnthropicBody = {
    model: "claude-sonnet-4",
    thinking: { type: "adaptive" } as never,
    messages: [],
  };
  expect(stampThinking(body, { outputConfig: true })).toBe(false);
  expect(body.output_config).toBeUndefined();
});

test("uses custom output_config object when thinking is enabled", () => {
  const customOutput = { effort: "max" } as const;
  const body: AnthropicBody = {
    model: "umans-coder",
    thinking: { type: "adaptive" },
    messages: [],
  };
  expect(stampThinking(body, { outputConfig: customOutput })).toBe(true);
  expect(body.output_config).toEqual(customOutput);
});

test("no-op when no toggles enabled", () => {
  const body: AnthropicBody = { model: "umans-coder", messages: [] };
  expect(stampThinking(body, {})).toBe(false);
});
