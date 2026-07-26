import { expect, test } from "bun:test";
import { matchStampOverlay, type StampPolicy } from "../src/stamp-catalog.js";
import { isThinkingDisabled, isThinkingEnabled, stampThinking } from "../src/stamp-thinking.js";
import type { AnthropicBody } from "../src/types.js";

const GLM_MAX_TOKENS = 131071;
const NON_GLM_MAX_TOKENS = 32767;
const DEFAULT_OUTPUT_CONFIG = { effort: "high" } as const;
const GLM_OUTPUT_CONFIG = { effort: "max" } as const;

// ─── isThinkingDisabled / isThinkingEnabled ───────────────────────────────

test("isThinkingDisabled: true for disabled/off/none/enabled:false", () => {
  expect(isThinkingDisabled({ type: "disabled" })).toBe(true);
  expect(isThinkingDisabled({ type: "off" })).toBe(true);
  expect(isThinkingDisabled({ type: "none" })).toBe(true);
  expect(isThinkingDisabled({ type: "DISABLED" })).toBe(true);
  expect(isThinkingDisabled({ enabled: false })).toBe(true);
});

test("isThinkingDisabled: false for enabled/adaptive/absent", () => {
  expect(isThinkingDisabled({ type: "enabled" })).toBe(false);
  expect(isThinkingDisabled({ type: "adaptive" })).toBe(false);
  expect(isThinkingDisabled({ enabled: true })).toBe(false);
  expect(isThinkingDisabled(null)).toBe(false);
  expect(isThinkingDisabled(undefined)).toBe(false);
});

test("isThinkingEnabled: true for enabled/adaptive, false for absent/disabled", () => {
  expect(isThinkingEnabled({ type: "enabled" })).toBe(true);
  expect(isThinkingEnabled({ type: "adaptive" })).toBe(true);
  expect(isThinkingEnabled({ type: "disabled" })).toBe(false);
  expect(isThinkingEnabled({ type: "off" })).toBe(false);
  expect(isThinkingEnabled({ enabled: false })).toBe(false);
  expect(isThinkingEnabled(null)).toBe(false);
  expect(isThinkingEnabled(undefined)).toBe(false);
});

// ─── max_tokens stamping (no thinking option) ─────────────────────────────

test("stamps max_tokens for GLM models when thinking enabled", () => {
  const body: AnthropicBody = {
    model: "umans-glm-5.2",
    thinking: { type: "adaptive" },
    messages: [],
  };
  expect(stampThinking(body, { maxTokens: true })).toBe(true);
  expect(body.max_tokens).toBe(GLM_MAX_TOKENS);
  expect(body.output_config).toBeUndefined();
});

test("stamps max_tokens for non-GLM models when thinking enabled", () => {
  const body: AnthropicBody = {
    model: "umans-coder",
    thinking: { type: "adaptive" },
    messages: [],
  };
  expect(stampThinking(body, { maxTokens: true })).toBe(true);
  expect(body.max_tokens).toBe(NON_GLM_MAX_TOKENS);
  expect(body.output_config).toBeUndefined();
});

test("does NOT stamp max_tokens when thinking is absent", () => {
  const body: AnthropicBody = { model: "umans-glm-5.2", messages: [] };
  expect(stampThinking(body, { maxTokens: true })).toBe(false);
  expect(body.max_tokens).toBeUndefined();
});

test("does NOT stamp max_tokens when thinking is disabled (canDisable=true)", () => {
  const body: AnthropicBody = {
    model: "umans-glm-5.2",
    thinking: { type: "disabled" } as never,
    messages: [],
  };
  expect(stampThinking(body, { maxTokens: true })).toBe(false);
  expect(body.max_tokens).toBeUndefined();
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
    expect(stampThinking(body, { maxTokens: true })).toBe(false);
    expect(body.thinking).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
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

// ─── thinking forcing (options.thinking: true) ─────────────────────────────

test("thinking:true forces {type:enabled,...} to Kimi Preserved Thinking for canDisable=false model (umans-coder)", () => {
  const body: AnthropicBody = {
    model: "umans-coder",
    thinking: { type: "enabled", budget_tokens: 1024 } as never,
    messages: [],
  };
  expect(stampThinking(body, { thinking: true })).toBe(true);
  expect(body.thinking).toEqual({ type: "enabled", keep: "all", budget_tokens: 32000 });
});

test("thinking:true forces {type:enabled,...} to Kimi Preserved Thinking for canDisable=false model (umans-kimi)", () => {
  const body: AnthropicBody = {
    model: "umans-kimi-k2.7",
    thinking: { type: "enabled", budget_tokens: 1024 } as never,
    messages: [],
  };
  expect(stampThinking(body, { thinking: true })).toBe(true);
  expect(body.thinking).toEqual({ type: "enabled", keep: "all", budget_tokens: 32000 });
});

test("thinking:true forces disabled to Kimi Preserved Thinking when canDisableThinking is false (umans-coder)", () => {
  const body: AnthropicBody = {
    model: "umans-coder",
    thinking: { type: "disabled" } as never,
    messages: [],
  };
  expect(stampThinking(body, { thinking: true })).toBe(true);
  expect(body.thinking).toEqual({ type: "enabled", keep: "all", budget_tokens: 32000 });
});

test("thinking:true forces disabled to Kimi Preserved Thinking when canDisableThinking is false (umans-kimi)", () => {
  const body: AnthropicBody = {
    model: "umans-kimi-k2.7",
    thinking: { type: "disabled" } as never,
    messages: [],
  };
  expect(stampThinking(body, { thinking: true })).toBe(true);
  expect(body.thinking).toEqual({ type: "enabled", keep: "all", budget_tokens: 32000 });
});

test("thinking:true forces {enabled:false} to Kimi Preserved Thinking when canDisableThinking is false (umans-coder)", () => {
  const body: AnthropicBody = {
    model: "umans-coder",
    thinking: { enabled: false } as never,
    messages: [],
  };
  expect(stampThinking(body, { thinking: true })).toBe(true);
  expect(body.thinking).toEqual({ type: "enabled", keep: "all", budget_tokens: 32000 });
});

test("thinking:true respects disabled when canDisableThinking is true (umans-glm)", () => {
  const body: AnthropicBody = {
    model: "umans-glm-5.2",
    thinking: { type: "disabled" } as never,
    messages: [],
  };
  expect(stampThinking(body, { thinking: true })).toBe(false);
  expect(body.thinking as { type?: string }).toEqual({ type: "disabled" });
});

test("thinking:true respects disabled when canDisableThinking is true (umans-flash)", () => {
  const body: AnthropicBody = {
    model: "umans-flash",
    thinking: { type: "off" } as never,
    messages: [],
  };
  expect(stampThinking(body, { thinking: true })).toBe(false);
  expect(body.thinking as { type?: string }).toEqual({ type: "off" });
});

test("thinking:true respects {enabled:false} when canDisableThinking is true (umans-qwen)", () => {
  const body: AnthropicBody = {
    model: "umans-qwen-72b",
    thinking: { enabled: false } as never,
    messages: [],
  };
  expect(stampThinking(body, { thinking: true })).toBe(false);
  expect(body.thinking as { enabled?: boolean }).toEqual({ enabled: false });
});

test("thinking:true does not force when thinking is absent", () => {
  const body: AnthropicBody = { model: "umans-coder", messages: [] };
  expect(stampThinking(body, { thinking: true })).toBe(false);
  expect(body.thinking).toBeUndefined();
});

// ─── per-family thinkingShape forcing (ADR-0017) ────────────────────────────

test("thinking:true forces non-adaptive to GLM Preserved Thinking for umans-glm* (Z.ai clear_thinking:false)", () => {
  const body: AnthropicBody = {
    model: "umans-glm-5.2",
    thinking: { type: "enabled", budget_tokens: 1024 } as never,
    messages: [],
  };
  expect(stampThinking(body, { thinking: true })).toBe(true);
  expect(body.thinking).toEqual({ type: "enabled", clear_thinking: false, budget_tokens: 32000 });
});

test("thinking:true forces adaptive to GLM Preserved Thinking for umans-glm*", () => {
  const body: AnthropicBody = {
    model: "umans-glm-5.2",
    thinking: { type: "adaptive" },
    messages: [],
  };
  expect(stampThinking(body, { thinking: true })).toBe(true);
  expect(body.thinking).toEqual({ type: "enabled", clear_thinking: false, budget_tokens: 32000 });
});

test("thinking:true forces disabled to GLM Preserved Thinking when canDisableThinking is false (umans-glm with policy override)", () => {
  const body: AnthropicBody = {
    model: "umans-glm-5.2",
    thinking: { type: "disabled" } as never,
    messages: [],
  };
  expect(
    stampThinking(body, {
      thinking: true,
      policy: { ...matchStampOverlay("umans-glm-5.2"), canDisableThinking: false },
    }),
  ).toBe(true);
  expect(body.thinking).toEqual({ type: "enabled", clear_thinking: false, budget_tokens: 32000 });
});

test("thinking:true forces adaptive to Kimi Preserved Thinking for umans-coder (keep:all)", () => {
  const body: AnthropicBody = {
    model: "umans-coder",
    thinking: { type: "adaptive" },
    messages: [],
  };
  expect(stampThinking(body, { thinking: true })).toBe(true);
  expect(body.thinking).toEqual({ type: "enabled", keep: "all", budget_tokens: 32000 });
});

test("thinking:true forces adaptive to Kimi Preserved Thinking for umans-kimi* (keep:all)", () => {
  const body: AnthropicBody = {
    model: "umans-kimi-k2.6",
    thinking: { type: "adaptive" },
    messages: [],
  };
  expect(stampThinking(body, { thinking: true })).toBe(true);
  expect(body.thinking).toEqual({ type: "enabled", keep: "all", budget_tokens: 32000 });
});

test("thinking:true keeps adaptive for umans-flash (non-GLM, non-Kimi family)", () => {
  const body: AnthropicBody = {
    model: "umans-flash",
    thinking: { type: "enabled", budget_tokens: 1024 } as never,
    messages: [],
  };
  expect(stampThinking(body, { thinking: true })).toBe(true);
  expect(body.thinking).toEqual({ type: "adaptive" });
});

test("thinking:true keeps adaptive for umans-qwen* (non-GLM, non-Kimi family)", () => {
  const body: AnthropicBody = {
    model: "umans-qwen-72b",
    thinking: { type: "enabled", budget_tokens: 1024 } as never,
    messages: [],
  };
  expect(stampThinking(body, { thinking: true })).toBe(true);
  expect(body.thinking).toEqual({ type: "adaptive" });
});

test("thinking:true does not re-write when body already matches policy thinkingShape (umans-glm)", () => {
  const body: AnthropicBody = {
    model: "umans-glm-5.2",
    thinking: { type: "enabled", clear_thinking: false, budget_tokens: 32000 },
    messages: [],
  };
  expect(stampThinking(body, { thinking: true })).toBe(false);
  expect(body.thinking).toEqual({ type: "enabled", clear_thinking: false, budget_tokens: 32000 });
});

test("thinking:true does not re-write when body already matches policy thinkingShape (umans-coder)", () => {
  const body: AnthropicBody = {
    model: "umans-coder",
    thinking: { type: "enabled", keep: "all", budget_tokens: 32000 },
    messages: [],
  };
  expect(stampThinking(body, { thinking: true })).toBe(false);
  expect(body.thinking).toEqual({ type: "enabled", keep: "all", budget_tokens: 32000 });
});

// ─── backward compat: no thinking option = no forcing ─────────────────────

test("without thinking option: existing thinking respected even if non-adaptive", () => {
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

test("without thinking option: disabled thinking respected, no max_tokens/output_config", () => {
  const body: AnthropicBody = {
    model: "umans-coder",
    thinking: { type: "disabled" } as never,
    max_tokens: 8192,
    messages: [],
  };
  expect(stampThinking(body, { maxTokens: true, outputConfig: true })).toBe(false);
  expect(body.thinking as { type?: string }).toEqual({ type: "disabled" });
  expect(body.max_tokens).toBe(8192);
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

// ─── GLM 5.2 child-toggle: overridden thinkingShape (ADR-0019) ────────────────

test("GLM 5.2 child ON: stampThinking forces to GLM Preserved Thinking shape", () => {
  const body: AnthropicBody = {
    model: "umans-glm-5.2",
    thinking: { type: "adaptive" },
    messages: [],
  };
  const policy: StampPolicy = {
    max_tokens: GLM_MAX_TOKENS,
    effort: "max",
    thinking: true,
    top_k: 20,
    canDisableThinking: true,
    thinkingShape: { type: "enabled", clear_thinking: false, budget_tokens: 32000 },
  };
  expect(stampThinking(body, { thinking: true, policy })).toBe(true);
  expect(body.thinking).toEqual({
    type: "enabled",
    clear_thinking: false,
    budget_tokens: 32000,
  });
});

test("GLM 5.2 child OFF: stampThinking forces to adaptive shape", () => {
  const body: AnthropicBody = {
    model: "umans-glm-5.2",
    thinking: { type: "enabled", clear_thinking: false, budget_tokens: 32000 } as never,
    messages: [],
  };
  const policy: StampPolicy = {
    max_tokens: GLM_MAX_TOKENS,
    effort: "max",
    thinking: true,
    top_k: 20,
    canDisableThinking: true,
    thinkingShape: { type: "adaptive" },
  };
  expect(stampThinking(body, { thinking: true, policy })).toBe(true);
  expect(body.thinking).toEqual({ type: "adaptive" });
});

test("GLM 5.2 child ON: disabled thinking respected when canDisableThinking=true (GLM overlay default)", () => {
  const body: AnthropicBody = {
    model: "umans-glm-5.2",
    thinking: { type: "disabled" } as never,
    messages: [],
  };
  const policy: StampPolicy = {
    max_tokens: GLM_MAX_TOKENS,
    effort: "max",
    thinking: true,
    top_k: 20,
    canDisableThinking: true,
    thinkingShape: { type: "enabled", clear_thinking: false, budget_tokens: 32000 },
  };
  expect(stampThinking(body, { thinking: true, policy })).toBe(false);
  expect(body.thinking as { type?: string }).toEqual({ type: "disabled" });
});

// ─── Kimi K2.7-Code child-toggle: overridden thinkingShape (ADR-0019) ────────

test("Kimi K2.7-Code child ON: stampThinking forces to Kimi Preserved Thinking shape", () => {
  const body: AnthropicBody = {
    model: "umans-kimi-k2.7-code",
    thinking: { type: "adaptive" },
    messages: [],
  };
  const policy: StampPolicy = {
    max_tokens: NON_GLM_MAX_TOKENS,
    effort: "high",
    thinking: true,
    top_k: null,
    canDisableThinking: false,
    thinkingShape: { type: "enabled", keep: "all", budget_tokens: 32000 },
  };
  expect(stampThinking(body, { thinking: true, policy })).toBe(true);
  expect(body.thinking).toEqual({
    type: "enabled",
    keep: "all",
    budget_tokens: 32000,
  });
});

test("Kimi K2.7-Code child OFF: stampThinking forces to adaptive shape", () => {
  const body: AnthropicBody = {
    model: "umans-kimi-k2.7-code",
    thinking: { type: "enabled", keep: "all", budget_tokens: 32000 } as never,
    messages: [],
  };
  const policy: StampPolicy = {
    max_tokens: NON_GLM_MAX_TOKENS,
    effort: "high",
    thinking: true,
    top_k: null,
    canDisableThinking: false,
    thinkingShape: { type: "adaptive" },
  };
  expect(stampThinking(body, { thinking: true, policy })).toBe(true);
  expect(body.thinking).toEqual({ type: "adaptive" });
});

test("Kimi K2.7-Code child ON: disabled thinking forced to Kimi Preserved Thinking (canDisable=false)", () => {
  const body: AnthropicBody = {
    model: "umans-kimi-k2.7-code",
    thinking: { type: "disabled" } as never,
    messages: [],
  };
  const policy: StampPolicy = {
    max_tokens: NON_GLM_MAX_TOKENS,
    effort: "high",
    thinking: true,
    top_k: null,
    canDisableThinking: false,
    thinkingShape: { type: "enabled", keep: "all", budget_tokens: 32000 },
  };
  expect(stampThinking(body, { thinking: true, policy })).toBe(true);
  expect(body.thinking).toEqual({
    type: "enabled",
    keep: "all",
    budget_tokens: 32000,
  });
});
