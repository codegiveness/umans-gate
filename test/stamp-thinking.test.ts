import { expect, test } from "bun:test";
import { stampThinking } from "../src/stamp-thinking.js";
import type { AnthropicBody } from "../src/types.js";

const DEFAULT_THINKING = { type: "adaptive" } as const;
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

test("stamps thinking only for matching models", () => {
  for (const model of [
    "umans-coder",
    "umans-flash",
    "umans-kimi-7b",
    "umans-qwen-72b",
    "umans-glm-5.2",
  ]) {
    const body: AnthropicBody = { model, messages: [] };
    expect(stampThinking(body, { thinking: true })).toBe(true);
    expect(body.thinking).toEqual(DEFAULT_THINKING);
    expect(body.max_tokens).toBeUndefined();
    expect(body.output_config).toBeUndefined();
  }
});

test("stamps thinking for umans-glm* models", () => {
  for (const model of ["umans-glm-5.2", "umans-glm-lite"]) {
    const body: AnthropicBody = { model, messages: [] };
    expect(stampThinking(body, { thinking: true })).toBe(true);
    expect(body.thinking).toEqual(DEFAULT_THINKING);
  }
});

test("stamps output_config=high for non-glm models", () => {
  const body: AnthropicBody = { model: "umans-coder", messages: [] };
  expect(stampThinking(body, { outputConfig: true })).toBe(true);
  expect(body.output_config).toEqual(DEFAULT_OUTPUT_CONFIG);
});

test("stamps output_config=max for umans-glm* models", () => {
  for (const model of ["umans-glm-5.2", "umans-glm-lite"]) {
    const body: AnthropicBody = { model, messages: [] };
    expect(stampThinking(body, { outputConfig: true })).toBe(true);
    expect(body.output_config).toEqual(GLM_OUTPUT_CONFIG);
  }
});

test("overwrites existing max_tokens, thinking, and output_config", () => {
  const body: AnthropicBody = {
    model: "umans-coder",
    thinking: { type: "enabled" } as never,
    max_tokens: 8192,
    output_config: { effort: "low" } as never,
    messages: [],
  };
  expect(stampThinking(body, { maxTokens: true, thinking: true, outputConfig: true })).toBe(true);
  expect(body.thinking).toEqual(DEFAULT_THINKING);
  expect(body.max_tokens).toBe(NON_GLM_MAX_TOKENS);
  expect(body.output_config).toEqual(DEFAULT_OUTPUT_CONFIG);
});

test("uses custom thinking config when provided", () => {
  const customThinking = { type: "adaptive" } as const;
  const body: AnthropicBody = { model: "umans-coder", messages: [] };
  expect(stampThinking(body, { thinking: customThinking })).toBe(true);
  expect(body.thinking).toEqual(customThinking);
});

test("uses custom output_config object when provided", () => {
  const customOutput = { effort: "max" } as const;
  const body: AnthropicBody = { model: "umans-coder", messages: [] };
  expect(stampThinking(body, { outputConfig: customOutput })).toBe(true);
  expect(body.output_config).toEqual(customOutput);
});

test("no-op when no toggles enabled", () => {
  const body: AnthropicBody = { model: "umans-coder", messages: [] };
  expect(stampThinking(body, {})).toBe(false);
});
