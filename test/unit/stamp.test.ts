// Unit tests: stamp module functions called directly.
//
// Covers stampCacheTtl, stampThinking, stampReasoning, stampTopK,
// stampTemperature, and the catalog helpers matchStampOverlay /
// resolveStampPolicy / applyModelSpecificThinkingOverride.
//
// The stamp functions MUTATE the body in place and return a boolean (true
// if changed). Tests construct a body, call the function, then assert on
// the mutated body fields and the return value.

import { describe, expect, it } from "bun:test";
import { parseModelInfoResponse } from "../../src/model-info-parser.js";
import { stampCacheTtl } from "../../src/stamp.js";
import {
  applyModelSpecificThinkingOverride,
  matchStampOverlay,
  resolveStampPolicy,
  STAMP_OVERLAY,
  type StampPolicy,
} from "../../src/stamp-catalog.js";
import { stampReasoning } from "../../src/stamp-reasoning.js";
import { stampTemperature } from "../../src/stamp-temperature.js";
import { isThinkingDisabled, isThinkingEnabled, stampThinking } from "../../src/stamp-thinking.js";
import { stampTopK } from "../../src/stamp-topk.js";
import type { AnthropicBody, OpenAiBody } from "../../src/types.js";

const GLM_MAX_TOKENS = 131071;
const NON_GLM_MAX_TOKENS = 32767;
const DEFAULT_OUTPUT_CONFIG = { effort: "high" } as const;
const GLM_OUTPUT_CONFIG = { effort: "max" } as const;

const CODER_POLICY = STAMP_OVERLAY["umans-coder"];
const GLM_POLICY = STAMP_OVERLAY["umans-glm*"];
const FLASH_POLICY = STAMP_OVERLAY["umans-flash"];

// ─── stampCacheTtl ─────────────────────────────────────────────────────────

describe("stampCacheTtl", () => {
  it("stamps ttl on system ephemeral block", () => {
    const body: AnthropicBody = {
      system: [{ type: "text", text: "You are helpful", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "hi" }],
    };
    expect(stampCacheTtl(body, "1h")).toBe(1);
    expect((body.system as Array<{ cache_control?: { ttl?: string } }>)[0].cache_control?.ttl).toBe(
      "1h",
    );
  });

  it("stamps ttl on message content ephemeral block", () => {
    const body: AnthropicBody = {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
        },
      ],
    };
    expect(stampCacheTtl(body, "1h")).toBe(1);
    const content = body.messages![0].content as Array<{
      cache_control?: { ttl?: string };
    }>;
    expect(content[0].cache_control?.ttl).toBe("1h");
  });

  it("preserves existing ttl (does not overwrite)", () => {
    const body: AnthropicBody = {
      system: [{ type: "text", text: "x", cache_control: { type: "ephemeral", ttl: "5m" } }],
    };
    expect(stampCacheTtl(body, "1h")).toBe(0);
    expect((body.system as Array<{ cache_control?: { ttl?: string } }>)[0].cache_control?.ttl).toBe(
      "5m",
    );
  });

  it("skips non-array system (plain string) safely", () => {
    const body = {
      system: "You are helpful",
      messages: [{ role: "user", content: "hi" }],
    } as unknown as AnthropicBody;
    expect(stampCacheTtl(body, "1h")).toBe(0);
    expect(body.system).toBe("You are helpful");
  });

  it("skips cache_control blocks that are not ephemeral", () => {
    const body: AnthropicBody = {
      system: [{ type: "text", text: "x", cache_control: { type: "persistent" } }],
    };
    expect(stampCacheTtl(body, "1h")).toBe(0);
    expect(
      (body.system as Array<{ cache_control?: { ttl?: string } }>)[0].cache_control?.ttl,
    ).toBeUndefined();
  });

  it("returns 0 when body has no cache_control blocks", () => {
    const body: AnthropicBody = {
      system: [{ type: "text", text: "x" }],
      messages: [{ role: "user", content: "hi" }],
    };
    expect(stampCacheTtl(body, "1h")).toBe(0);
  });
});

// ─── isThinkingDisabled / isThinkingEnabled ───────────────────────────────

describe("isThinkingDisabled", () => {
  it("returns true for disabled/off/none/enabled:false", () => {
    expect(isThinkingDisabled({ type: "disabled" })).toBe(true);
    expect(isThinkingDisabled({ type: "off" })).toBe(true);
    expect(isThinkingDisabled({ type: "none" })).toBe(true);
    expect(isThinkingDisabled({ type: "DISABLED" })).toBe(true);
    expect(isThinkingDisabled({ enabled: false })).toBe(true);
  });

  it("returns false for enabled/adaptive/absent", () => {
    expect(isThinkingDisabled({ type: "enabled" })).toBe(false);
    expect(isThinkingDisabled({ type: "adaptive" })).toBe(false);
    expect(isThinkingDisabled({ enabled: true })).toBe(false);
    expect(isThinkingDisabled(null)).toBe(false);
    expect(isThinkingDisabled(undefined)).toBe(false);
  });
});

describe("isThinkingEnabled", () => {
  it("returns true for enabled/adaptive, false for absent/disabled", () => {
    expect(isThinkingEnabled({ type: "enabled" })).toBe(true);
    expect(isThinkingEnabled({ type: "adaptive" })).toBe(true);
    expect(isThinkingEnabled({ type: "disabled" })).toBe(false);
    expect(isThinkingEnabled({ type: "off" })).toBe(false);
    expect(isThinkingEnabled({ enabled: false })).toBe(false);
    expect(isThinkingEnabled(null)).toBe(false);
    expect(isThinkingEnabled(undefined)).toBe(false);
  });
});

// ─── stampThinking: max_tokens ─────────────────────────────────────────────

describe("stampThinking — max_tokens", () => {
  it("stamps max_tokens for GLM models when thinking enabled", () => {
    const body: AnthropicBody = {
      model: "umans-glm-5.2",
      thinking: { type: "adaptive" },
      messages: [],
    };
    expect(stampThinking(body, { maxTokens: true })).toBe(true);
    expect(body.max_tokens).toBe(GLM_MAX_TOKENS);
    expect(body.output_config).toBeUndefined();
  });

  it("stamps max_tokens for non-GLM models when thinking enabled", () => {
    const body: AnthropicBody = {
      model: "umans-coder",
      thinking: { type: "adaptive" },
      messages: [],
    };
    expect(stampThinking(body, { maxTokens: true })).toBe(true);
    expect(body.max_tokens).toBe(NON_GLM_MAX_TOKENS);
  });

  it("does NOT stamp max_tokens when thinking is absent", () => {
    const body: AnthropicBody = { model: "umans-glm-5.2", messages: [] };
    expect(stampThinking(body, { maxTokens: true })).toBe(false);
    expect(body.max_tokens).toBeUndefined();
  });

  it("does NOT stamp max_tokens when thinking is disabled (canDisable=true)", () => {
    const body: AnthropicBody = {
      model: "umans-glm-5.2",
      thinking: { type: "disabled" } as never,
      messages: [],
    };
    expect(stampThinking(body, { maxTokens: true })).toBe(false);
    expect(body.max_tokens).toBeUndefined();
  });
});

// ─── stampThinking: output_config ──────────────────────────────────────────

describe("stampThinking — output_config", () => {
  it("stamps output_config=high for non-glm models when thinking enabled", () => {
    const body: AnthropicBody = {
      model: "umans-coder",
      thinking: { type: "adaptive" },
      messages: [],
    };
    expect(stampThinking(body, { outputConfig: true })).toBe(true);
    expect(body.output_config).toEqual(DEFAULT_OUTPUT_CONFIG);
  });

  it("stamps output_config=max for umans-glm* models when thinking enabled", () => {
    const body: AnthropicBody = {
      model: "umans-glm-5.2",
      thinking: { type: "adaptive" },
      messages: [],
    };
    expect(stampThinking(body, { outputConfig: true })).toBe(true);
    expect(body.output_config).toEqual(GLM_OUTPUT_CONFIG);
  });

  it("does NOT stamp output_config when body lacks thinking", () => {
    const body: AnthropicBody = { model: "umans-coder", messages: [] };
    expect(stampThinking(body, { outputConfig: true })).toBe(false);
    expect(body.output_config).toBeUndefined();
  });

  it("does NOT stamp output_config for unknown model with thinking=false policy", () => {
    const body: AnthropicBody = {
      model: "umans-legacy",
      thinking: { type: "adaptive" } as never,
      messages: [],
    };
    expect(stampThinking(body, { outputConfig: true })).toBe(false);
    expect(body.output_config).toBeUndefined();
  });

  it("uses custom output_config object when thinking is enabled", () => {
    const customOutput = { effort: "max" } as const;
    const body: AnthropicBody = {
      model: "umans-coder",
      thinking: { type: "adaptive" },
      messages: [],
    };
    expect(stampThinking(body, { outputConfig: customOutput })).toBe(true);
    expect(body.output_config).toEqual(customOutput);
  });
});

// ─── stampThinking: thinking forcing ───────────────────────────────────────

describe("stampThinking — thinking:true forcing", () => {
  it("forces {type:enabled,...} to Kimi Preserved Thinking for umans-coder", () => {
    const body: AnthropicBody = {
      model: "umans-coder",
      thinking: { type: "enabled", budget_tokens: 1024 } as never,
      messages: [],
    };
    expect(stampThinking(body, { thinking: true })).toBe(true);
    expect(body.thinking).toEqual({ type: "enabled", keep: "all", budget_tokens: 32000 });
  });

  it("forces {type:enabled,...} to Kimi Preserved Thinking for umans-kimi*", () => {
    const body: AnthropicBody = {
      model: "umans-kimi-k2.7",
      thinking: { type: "enabled", budget_tokens: 1024 } as never,
      messages: [],
    };
    expect(stampThinking(body, { thinking: true })).toBe(true);
    expect(body.thinking).toEqual({ type: "enabled", keep: "all", budget_tokens: 32000 });
  });

  it("forces disabled to Kimi Preserved Thinking when canDisableThinking=false (umans-coder)", () => {
    const body: AnthropicBody = {
      model: "umans-coder",
      thinking: { type: "disabled" } as never,
      messages: [],
    };
    expect(stampThinking(body, { thinking: true })).toBe(true);
    expect(body.thinking).toEqual({ type: "enabled", keep: "all", budget_tokens: 32000 });
  });

  it("respects disabled when canDisableThinking=true (umans-glm)", () => {
    const body: AnthropicBody = {
      model: "umans-glm-5.2",
      thinking: { type: "disabled" } as never,
      messages: [],
    };
    expect(stampThinking(body, { thinking: true })).toBe(false);
    expect(body.thinking as { type?: string }).toEqual({ type: "disabled" });
  });

  it("respects disabled when canDisableThinking=true (umans-flash)", () => {
    const body: AnthropicBody = {
      model: "umans-flash",
      thinking: { type: "off" } as never,
      messages: [],
    };
    expect(stampThinking(body, { thinking: true })).toBe(false);
    expect(body.thinking as { type?: string }).toEqual({ type: "off" });
  });

  it("respects {enabled:false} when canDisableThinking=true (umans-qwen)", () => {
    const body: AnthropicBody = {
      model: "umans-qwen-72b",
      thinking: { enabled: false } as never,
      messages: [],
    };
    expect(stampThinking(body, { thinking: true })).toBe(false);
    expect(body.thinking as { enabled?: boolean }).toEqual({ enabled: false });
  });

  it("does not force when thinking is absent", () => {
    const body: AnthropicBody = { model: "umans-coder", messages: [] };
    expect(stampThinking(body, { thinking: true })).toBe(false);
    expect(body.thinking).toBeUndefined();
  });
});

// ─── stampThinking: per-family thinkingShape (ADR-0017) ────────────────────

describe("stampThinking — per-family thinkingShape", () => {
  it("forces non-adaptive to GLM Preserved Thinking for umans-glm*", () => {
    const body: AnthropicBody = {
      model: "umans-glm-5.2",
      thinking: { type: "enabled", budget_tokens: 1024 } as never,
      messages: [],
    };
    expect(stampThinking(body, { thinking: true })).toBe(true);
    expect(body.thinking).toEqual({
      type: "enabled",
      clear_thinking: false,
      budget_tokens: 32000,
    });
  });

  it("forces adaptive to GLM Preserved Thinking for umans-glm*", () => {
    const body: AnthropicBody = {
      model: "umans-glm-5.2",
      thinking: { type: "adaptive" },
      messages: [],
    };
    expect(stampThinking(body, { thinking: true })).toBe(true);
    expect(body.thinking).toEqual({
      type: "enabled",
      clear_thinking: false,
      budget_tokens: 32000,
    });
  });

  it("keeps adaptive for umans-flash (non-GLM, non-Kimi family)", () => {
    const body: AnthropicBody = {
      model: "umans-flash",
      thinking: { type: "enabled", budget_tokens: 1024 } as never,
      messages: [],
    };
    expect(stampThinking(body, { thinking: true })).toBe(true);
    expect(body.thinking).toEqual({ type: "adaptive" });
  });

  it("keeps adaptive for umans-qwen*", () => {
    const body: AnthropicBody = {
      model: "umans-qwen-72b",
      thinking: { type: "enabled", budget_tokens: 1024 } as never,
      messages: [],
    };
    expect(stampThinking(body, { thinking: true })).toBe(true);
    expect(body.thinking).toEqual({ type: "adaptive" });
  });

  it("does not re-write when body already matches policy thinkingShape (umans-glm)", () => {
    const body: AnthropicBody = {
      model: "umans-glm-5.2",
      thinking: { type: "enabled", clear_thinking: false, budget_tokens: 32000 },
      messages: [],
    };
    expect(stampThinking(body, { thinking: true })).toBe(false);
    expect(body.thinking).toEqual({
      type: "enabled",
      clear_thinking: false,
      budget_tokens: 32000,
    });
  });

  it("does not re-write when body already matches policy thinkingShape (umans-coder)", () => {
    const body: AnthropicBody = {
      model: "umans-coder",
      thinking: { type: "enabled", keep: "all", budget_tokens: 32000 },
      messages: [],
    };
    expect(stampThinking(body, { thinking: true })).toBe(false);
    expect(body.thinking).toEqual({ type: "enabled", keep: "all", budget_tokens: 32000 });
  });
});

// ─── stampThinking: backward compat + no-op ─────────────────────────────────

describe("stampThinking — backward compat", () => {
  it("without thinking option: existing thinking respected even if non-adaptive", () => {
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

  it("without thinking option: disabled thinking respected, no max_tokens/output_config", () => {
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

  it("respects existing thinking type=adaptive and stamps output_config", () => {
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

  it("no-op when no toggles enabled", () => {
    const body: AnthropicBody = { model: "umans-coder", messages: [] };
    expect(stampThinking(body, {})).toBe(false);
  });
});

// ─── stampThinking: child-toggle override (ADR-0019) ───────────────────────

describe("stampThinking — GLM 5.2 child-toggle override", () => {
  it("child ON: forces to GLM Preserved Thinking shape", () => {
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

  it("child OFF: forces to adaptive shape", () => {
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
});

describe("stampThinking — Kimi K2.7-Code child-toggle override", () => {
  it("child ON: forces to Kimi Preserved Thinking shape", () => {
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
    expect(body.thinking).toEqual({ type: "enabled", keep: "all", budget_tokens: 32000 });
  });

  it("child ON: disabled thinking forced to Kimi Preserved Thinking (canDisable=false)", () => {
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
    expect(body.thinking).toEqual({ type: "enabled", keep: "all", budget_tokens: 32000 });
  });
});

// ─── stampReasoning ─────────────────────────────────────────────────────────

describe("stampReasoning — no-op cases", () => {
  it("does nothing when reasoningEffort is null", () => {
    const body: OpenAiBody = { model: "umans-coder", reasoning_effort: "high" };
    expect(stampReasoning(body, { reasoningEffort: null })).toBe(false);
    expect(body.reasoning_effort).toBe("high");
  });

  it("does nothing when both reasoning_effort and thinking are absent", () => {
    const body: OpenAiBody = { model: "umans-coder", max_tokens: 4096 };
    expect(stampReasoning(body, { reasoningEffort: "high" })).toBe(false);
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("does nothing when thinking disabled and reasoning_effort absent (canDisable=true)", () => {
    const body: OpenAiBody = {
      model: "umans-flash",
      thinking: { type: "disabled" },
    };
    expect(stampReasoning(body, { reasoningEffort: "high", policy: FLASH_POLICY })).toBe(false);
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.thinking).toEqual({ type: "disabled" });
  });
});

describe("stampReasoning — inject from thinking", () => {
  it("injects reasoning_effort when thinking enabled (umans-coder)", () => {
    const body: OpenAiBody = {
      model: "umans-coder",
      thinking: { type: "enabled" },
      max_tokens: 4096,
    };
    expect(stampReasoning(body, { reasoningEffort: "high", policy: CODER_POLICY })).toBe(true);
    expect(body.reasoning_effort).toBe("high");
    expect(body.thinking).toBeUndefined();
  });

  it("injects reasoning_effort=max when thinking adaptive (umans-glm)", () => {
    const body: OpenAiBody = {
      model: "umans-glm-5.2",
      thinking: { type: "adaptive" },
    };
    expect(stampReasoning(body, { reasoningEffort: "max", policy: GLM_POLICY })).toBe(true);
    expect(body.reasoning_effort).toBe("max");
    expect(body.thinking).toBeUndefined();
  });

  it("does not inject when thinking disabled and canDisableThinking=false (umans-coder)", () => {
    const body: OpenAiBody = {
      model: "umans-coder",
      thinking: { type: "disabled" },
    };
    expect(stampReasoning(body, { reasoningEffort: "high", policy: CODER_POLICY })).toBe(false);
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.thinking).toEqual({ type: "disabled" });
  });
});

describe("stampReasoning — force existing reasoning_effort", () => {
  it("forces existing reasoning_effort=low to high (umans-coder)", () => {
    const body: OpenAiBody = { model: "umans-coder", reasoning_effort: "low" };
    expect(stampReasoning(body, { reasoningEffort: "high", policy: CODER_POLICY })).toBe(true);
    expect(body.reasoning_effort).toBe("high");
  });

  it("forces existing reasoning_effort=high to max (umans-glm)", () => {
    const body: OpenAiBody = { model: "umans-glm-5.2", reasoning_effort: "high" };
    expect(stampReasoning(body, { reasoningEffort: "max", policy: GLM_POLICY })).toBe(true);
    expect(body.reasoning_effort).toBe("max");
  });

  it("strips thinking when forcing existing reasoning_effort", () => {
    const body: OpenAiBody = {
      model: "umans-coder",
      reasoning_effort: "low",
      thinking: { type: "enabled" },
    };
    expect(stampReasoning(body, { reasoningEffort: "high", policy: CODER_POLICY })).toBe(true);
    expect(body.reasoning_effort).toBe("high");
    expect(body.thinking).toBeUndefined();
  });
});

describe("stampReasoning — disabled values", () => {
  it("respects reasoning_effort=none when canDisableThinking=true (umans-flash)", () => {
    const body: OpenAiBody = {
      model: "umans-flash",
      reasoning_effort: "none",
      thinking: { type: "adaptive" },
    };
    expect(stampReasoning(body, { reasoningEffort: "high", policy: FLASH_POLICY })).toBe(false);
    expect(body.reasoning_effort).toBe("none");
    expect(body.thinking).toEqual({ type: "adaptive" });
  });

  it("forces reasoning_effort=none to high when canDisableThinking=false (umans-coder)", () => {
    const body: OpenAiBody = { model: "umans-coder", reasoning_effort: "none" };
    expect(stampReasoning(body, { reasoningEffort: "high", policy: CODER_POLICY })).toBe(true);
    expect(body.reasoning_effort).toBe("high");
  });

  it("forces reasoning_effort=off to high when canDisableThinking=false (umans-coder)", () => {
    const body: OpenAiBody = { model: "umans-coder", reasoning_effort: "off" };
    expect(stampReasoning(body, { reasoningEffort: "high", policy: CODER_POLICY })).toBe(true);
    expect(body.reasoning_effort).toBe("high");
  });

  it("respects reasoning_effort=off when canDisableThinking=true (umans-glm)", () => {
    const body: OpenAiBody = { model: "umans-glm-5.2", reasoning_effort: "off" };
    expect(stampReasoning(body, { reasoningEffort: "max", policy: GLM_POLICY })).toBe(false);
    expect(body.reasoning_effort).toBe("off");
  });
});

describe("stampReasoning — field stripping + temperature", () => {
  it("strips output_config and context_management when reasoning active", () => {
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

  it("forces temperature=1.0 when reasoning active", () => {
    const body: OpenAiBody = {
      model: "umans-coder",
      reasoning_effort: "low",
      temperature: 0.7,
    };
    expect(stampReasoning(body, { reasoningEffort: "high", policy: CODER_POLICY })).toBe(true);
    expect(body.reasoning_effort).toBe("high");
    expect(body.temperature).toBe(1.0);
  });

  it("forces temperature=1.0 when injecting reasoning_effort from thinking", () => {
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

  it("does not strip or force temperature when reasoning respected (disabled)", () => {
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
});

// ─── matchStampOverlay ─────────────────────────────────────────────────────

describe("matchStampOverlay", () => {
  const cases: Array<[string, StampPolicy]> = [
    ["umans-glm-foo", STAMP_OVERLAY["umans-glm*"]],
    ["umans-glm", STAMP_OVERLAY["umans-glm*"]],
    ["umans-coder", STAMP_OVERLAY["umans-coder"]],
    ["umans-flash", STAMP_OVERLAY["umans-flash"]],
    ["umans-kimi-x", STAMP_OVERLAY["umans-kimi*"]],
    ["umans-qwen-y", STAMP_OVERLAY["umans-qwen*"]],
    ["umans-legacy", STAMP_OVERLAY["*"]],
  ];

  for (const [model, expected] of cases) {
    it(`matches ${model}`, () => {
      expect(matchStampOverlay(model)).toBe(expected);
    });
  }

  it("does not treat umans-coder-extra as umans-coder (exact match required)", () => {
    expect(matchStampOverlay("umans-coder-extra")).toBe(STAMP_OVERLAY["*"]);
  });
});

// ─── resolveStampPolicy ────────────────────────────────────────────────────

function catalogWith(
  ...modelIds: string[]
): Map<string, ReturnType<typeof parseModelInfoResponse> extends Map<string, infer V> ? V : never> {
  const body: Record<string, unknown> = {};
  for (const id of modelIds) body[id] = { name: id };
  return parseModelInfoResponse(body);
}

describe("resolveStampPolicy", () => {
  it("resolves umans-glm* to the GLM policy", () => {
    const catalog = catalogWith("umans-glm-foo");
    expect(resolveStampPolicy("umans-glm-foo", catalog)).toEqual({
      max_tokens: 131071,
      effort: "max",
      thinking: true,
      top_k: 20,
      canDisableThinking: false,
      thinkingShape: { type: "enabled", clear_thinking: false, budget_tokens: 32000 },
    });
  });

  it("resolves umans-coder to the high-effort Kimi Preserved Thinking policy", () => {
    const catalog = catalogWith("umans-coder");
    expect(resolveStampPolicy("umans-coder", catalog)).toEqual({
      max_tokens: 32767,
      effort: "high",
      thinking: true,
      top_k: null,
      canDisableThinking: false,
      thinkingShape: { type: "enabled", keep: "all", budget_tokens: 32000 },
    });
  });

  it("falls back to the * policy for an unknown model", () => {
    const catalog = catalogWith("umans-coder");
    const resolved = resolveStampPolicy("umans-legacy", catalog);
    expect(resolved).toEqual(STAMP_OVERLAY["*"]);
    expect(resolved.thinking).toBe(false);
    expect(resolved.top_k).toBeNull();
  });

  it("falls back to the * policy for undefined model name", () => {
    const catalog = catalogWith("umans-coder");
    expect(resolveStampPolicy(undefined, catalog)).toEqual(STAMP_OVERLAY["*"]);
  });

  it("falls back to pattern match when the catalog is empty", () => {
    const catalog = catalogWith();
    expect(resolveStampPolicy("umans-glm-anything", catalog)).toEqual(STAMP_OVERLAY["umans-glm*"]);
  });
});

// ─── applyModelSpecificThinkingOverride ───────────────────────────────────

describe("applyModelSpecificThinkingOverride — GLM 5.2 toggle", () => {
  const GLM_BASE: StampPolicy = {
    max_tokens: 131071,
    effort: "max",
    thinking: true,
    top_k: 20,
    canDisableThinking: true,
    thinkingShape: { type: "enabled", clear_thinking: false, budget_tokens: 32000 },
  };

  it("overrides thinkingShape when child ON + version matches", () => {
    const out = applyModelSpecificThinkingOverride(GLM_BASE, "umans-glm-5.2", {
      stampGlm52Thinking: true,
      stampKimiK27CodeThinking: false,
    });
    expect(out.thinkingShape).toEqual({
      type: "enabled",
      clear_thinking: false,
      budget_tokens: 32000,
    });
  });

  it("falls back to adaptive when child ON but version does NOT match", () => {
    const out = applyModelSpecificThinkingOverride(GLM_BASE, "umans-glm-5.1", {
      stampGlm52Thinking: true,
      stampKimiK27CodeThinking: false,
    });
    expect(out.thinkingShape).toEqual({ type: "adaptive" });
  });

  it("falls back to adaptive when child OFF", () => {
    const out = applyModelSpecificThinkingOverride(GLM_BASE, "umans-glm-5.2", {
      stampGlm52Thinking: false,
      stampKimiK27CodeThinking: false,
    });
    expect(out.thinkingShape).toEqual({ type: "adaptive" });
  });

  it("does NOT override canDisableThinking", () => {
    const out = applyModelSpecificThinkingOverride(GLM_BASE, "umans-glm-5.2", {
      stampGlm52Thinking: true,
      stampKimiK27CodeThinking: false,
    });
    expect(out.canDisableThinking).toBe(GLM_BASE.canDisableThinking);
  });

  it("returns a new object (does not mutate input)", () => {
    const input = { ...GLM_BASE };
    const out = applyModelSpecificThinkingOverride(input, "umans-glm-5.2", {
      stampGlm52Thinking: true,
      stampKimiK27CodeThinking: false,
    });
    expect(out).not.toBe(input);
    expect(input.thinkingShape).toEqual(GLM_BASE.thinkingShape);
  });
});

describe("applyModelSpecificThinkingOverride — Kimi K2.7-Code toggle", () => {
  const KIMI_BASE: StampPolicy = {
    max_tokens: 32767,
    effort: "high",
    thinking: true,
    top_k: null,
    canDisableThinking: false,
    thinkingShape: { type: "enabled", keep: "all", budget_tokens: 32000 },
  };

  it("overrides thinkingShape when child ON + version matches", () => {
    const out = applyModelSpecificThinkingOverride(KIMI_BASE, "umans-kimi-k2.7-code", {
      stampGlm52Thinking: false,
      stampKimiK27CodeThinking: true,
    });
    expect(out.thinkingShape).toEqual({ type: "enabled", keep: "all", budget_tokens: 32000 });
  });

  it("falls back to adaptive when child ON but version does NOT match (k2.6)", () => {
    const out = applyModelSpecificThinkingOverride(KIMI_BASE, "umans-kimi-k2.6", {
      stampGlm52Thinking: false,
      stampKimiK27CodeThinking: true,
    });
    expect(out.thinkingShape).toEqual({ type: "adaptive" });
  });

  it("GLM toggle takes precedence when both children ON and GLM model matches", () => {
    const out = applyModelSpecificThinkingOverride(KIMI_BASE, "umans-glm-5.2", {
      stampGlm52Thinking: true,
      stampKimiK27CodeThinking: true,
    });
    expect(out.thinkingShape).toEqual({
      type: "enabled",
      clear_thinking: false,
      budget_tokens: 32000,
    });
  });
});

// ─── stampTopK ─────────────────────────────────────────────────────────────

describe("stampTopK", () => {
  it("injects top_k after model for glm model", () => {
    const body: Record<string, unknown> = {
      model: "umans-glm-5.2",
      messages: [{ role: "user", content: "hi" }],
    };
    expect(stampTopK(body, 20)).toBe(true);
    expect(body.top_k).toBe(20);
    expect(body.model).toBe("umans-glm-5.2");
    const keys = Object.keys(body);
    expect(keys.indexOf("model")).toBeLessThan(keys.indexOf("top_k"));
  });

  it("does NOT inject top_k when policy.top_k is null (umans-coder)", () => {
    const body: Record<string, unknown> = {
      model: "umans-coder",
      messages: [],
    };
    expect(stampTopK(body, 20)).toBe(false);
    expect(body.top_k).toBeUndefined();
  });

  it("preserves existing top_k (does not overwrite)", () => {
    const body: Record<string, unknown> = {
      model: "umans-glm-5.2",
      top_k: 40,
      messages: [],
    };
    expect(stampTopK(body, 20)).toBe(false);
    expect(body.top_k).toBe(40);
  });

  it("skips when body has no model", () => {
    const body: Record<string, unknown> = { messages: [] };
    expect(stampTopK(body, 20)).toBe(false);
    expect(body.top_k).toBeUndefined();
  });
});

// ─── stampTemperature ──────────────────────────────────────────────────────

describe("stampTemperature", () => {
  it("forces temperature when absent", () => {
    const body: Record<string, unknown> = { model: "umans-glm-5.2", messages: [] };
    expect(stampTemperature(body, 1.0)).toBe(true);
    expect(body.temperature).toBe(1.0);
  });

  it("overwrites existing temperature when different", () => {
    const body: Record<string, unknown> = {
      model: "umans-glm-5.2",
      temperature: 0.5,
      messages: [],
    };
    expect(stampTemperature(body, 1.0)).toBe(true);
    expect(body.temperature).toBe(1.0);
  });

  it("returns false when temperature already matches", () => {
    const body: Record<string, unknown> = {
      model: "umans-glm-5.2",
      temperature: 1.0,
      messages: [],
    };
    expect(stampTemperature(body, 1.0)).toBe(false);
    expect(body.temperature).toBe(1.0);
  });

  it("skips non-object bodies safely", () => {
    expect(stampTemperature(null, 1.0)).toBe(false);
    expect(stampTemperature("not-an-object", 1.0)).toBe(false);
    expect(stampTemperature([], 1.0)).toBe(false);
  });
});
