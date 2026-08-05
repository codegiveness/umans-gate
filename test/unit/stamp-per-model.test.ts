import { describe, expect, it } from "bun:test";
import { parseModelInfoResponse } from "../../src/model-info-parser.js";
import { resolvePerModelRule } from "../../src/stamp-catalog.js";
import type { StampContext } from "../../src/stamp-pipeline.js";
import {
  AnthropicBodyStep,
  OpenAiReasoningStep,
  PerModelRuleStep,
} from "../../src/stamp-pipeline.js";
import type { PerModelRule, ProxyConfig } from "../../src/types.js";

function makeConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    port: 1945,
    host: "127.0.0.1",
    target: "https://api.code.umans.ai",
    maxCaptures: 200,
    dbPath: "./umans-gate.db",
    viewerPrefix: "/dashboard",
    flushIntervalMs: 50,
    flushBatch: 25,
    idleTimeout: 255,
    upstreamProtocol: "http1.1",
    incomingProtocol: "http1.1",
    stampClaudeCode: true,
    stampModelRules: [],
    stampReasoningEffort: "high",
    openaiPath: "chat/completions",
    warmerEnabled: true,
    warmerIntervalMs: 20000,
    warmerPath: "/v1/models",
    umansApiKey: null,
    dashboardToken: null,
    usageRefreshMs: 60000,
    usageHistoryEnabled: true,
    usageRawRetentionDays: 7,
    usageGapThresholdMinutes: 60,
    usageIdleSessionTimeoutMinutes: 5,
    modelsRefreshMs: 3600000,
    concurrencyHardCap: 16,
    concurrencySoftLimit: 8,
    useHardCap: false,
    rateLimitRequests: 0,
    queueTimeoutMs: 180000,
    maxQueueDepth: 256,
    releaseCooldownMs: 1000,
    breakerThreshold: 5,
    breakerWindowMs: 300000,
    breakerCooldownMs: 60000,
    visionStrategy: "catalog",
    visionTarget: null,
    visionModel: "umans-flash",
    visionPrompt: "",
    visionPromptVersion: 2,
    visionMaxImages: 5,
    visionMaxDescriptionTokens: 4096,
    visionReasoningEffort: "none",
    visionTimeoutMs: 0,
    visionCacheSize: 1000,
    visionCacheTtlMs: 604800000,
    visionCacheMaxRows: 10000,
    visionPersistentCache: true,
    visionForceInterceptCapable: false,
    visionConcurrency: 1,
    visionMaxDimension: 2048,
    visionJpegQuality: 92,
    visionImageFormat: "png",
    visionImageDetail: "high",
    visionIntentStrategy: "auto",
    visionDecompositionEnabled: true,
    visionDecompositionTimeoutMs: 3000,
    visionCraftingTimeoutMs: 3000,
    visionAdjacentTextMaxChars: 500,
    visionRecentMessagesCount: 6,
    visionSystemPromptMaxChars: 1000,
    backgroundVision: false,
    concurrencyMainReservation: 1,
    concurrencyVisionReservation: 1,
    captureBodyMaxBytes: 10000000,
    queueMaxDepth: 100,
    wsBackpressureLimit: 1048576,
    wsCloseOnBackpressureLimit: true,
    visionPendingMaxBatch: 50,
    compressionEnabled: true,
    useWriteWorker: false,
    upstreamTimeoutMs: 1800000,
    experimentRewriteIds: false,
    experimentRewriteTtlMs: 3600000,
    experimentStripOmoReminder: false,
    experimentTtftWatchdog: false,
    ttftTimeoutMs: 60000,
    ttftRetryMaxAttempts: 3,
    ttftRetryGateSaturationPct: 80,
    ttftRetryCooldownMs: 5000,
    ttftWatchdogMultiplier: 5,
    ttftWatchdogHardCapMs: 300000,
    performanceSampleCount: 200,
    incidentRetentionDays: 30,
    ...overrides,
  } as ProxyConfig;
}

function makeCtx(
  config: ProxyConfig,
  modelName: string | undefined,
  isOpenAi: boolean,
): StampContext {
  return {
    config: config as never,
    isOpenAi,
    headers: {},
    url: new URL("http://localhost/v1/messages"),
    method: "POST",
    modelName,
    catalog: parseModelInfoResponse({}),
  };
}

describe("PerModelRuleStep — Anthropic route", () => {
  it("overrides thinkingShape when rule matches (GLM 5.2 clear_thinking:false)", () => {
    const rules: PerModelRule[] = [
      {
        pattern: "umans-glm-*",
        anthropicThinkingShape: { type: "enabled", clear_thinking: false },
      },
    ];
    const config = makeConfig({ stampModelRules: rules });
    const ctx = makeCtx(config, "umans-glm-5.2", false);
    const body: Record<string, unknown> = {
      model: "umans-glm-5.2",
      thinking: { type: "adaptive" },
      messages: [],
    };
    expect(PerModelRuleStep.applies(ctx)).toBe(true);
    expect(PerModelRuleStep.apply(body, ctx)).toBe(true);
    expect(body.thinking).toEqual({ type: "enabled", clear_thinking: false });
  });

  it("overrides thinkingShape when rule matches (Kimi K2.7 keep:all)", () => {
    const rules: PerModelRule[] = [
      {
        pattern: "umans-kimi-k2.7",
        anthropicThinkingShape: { type: "enabled", keep: "all" },
      },
    ];
    const config = makeConfig({ stampModelRules: rules });
    const ctx = makeCtx(config, "umans-kimi-k2.7", false);
    const body: Record<string, unknown> = {
      model: "umans-kimi-k2.7",
      thinking: { type: "adaptive" },
      messages: [],
    };
    expect(PerModelRuleStep.applies(ctx)).toBe(true);
    expect(PerModelRuleStep.apply(body, ctx)).toBe(true);
    expect(body.thinking).toEqual({ type: "enabled", keep: "all" });
  });

  it("injects bare {type:enabled} for umans-flash (Qwen preserved thinking)", () => {
    const rules: PerModelRule[] = [
      {
        pattern: "umans-flash",
        anthropicThinkingShape: { type: "enabled" },
      },
    ];
    const config = makeConfig({ stampModelRules: rules });
    const ctx = makeCtx(config, "umans-flash", false);
    const body: Record<string, unknown> = {
      model: "umans-flash",
      thinking: { type: "adaptive" },
      messages: [],
    };
    expect(PerModelRuleStep.apply(body, ctx)).toBe(true);
    expect(body.thinking).toEqual({ type: "enabled" });
  });

  it("does NOT apply when rules array is empty", () => {
    const config = makeConfig({ stampModelRules: [] });
    const ctx = makeCtx(config, "umans-glm-5.2", false);
    expect(PerModelRuleStep.applies(ctx)).toBe(false);
  });

  it("does NOT apply when no rule matches the model", () => {
    const rules: PerModelRule[] = [
      {
        pattern: "umans-glm-*",
        anthropicThinkingShape: { type: "enabled", clear_thinking: false },
      },
    ];
    const config = makeConfig({ stampModelRules: rules });
    const ctx = makeCtx(config, "umans-kimi-k2.7", false);
    expect(PerModelRuleStep.applies(ctx)).toBe(false);
  });

  it("fires even when stampClaudeCode is OFF (independent, thinking enabled)", () => {
    const rules: PerModelRule[] = [
      {
        pattern: "umans-glm-*",
        anthropicThinkingShape: { type: "enabled", clear_thinking: false },
      },
    ];
    const config = makeConfig({ stampClaudeCode: false, stampModelRules: rules });
    const ctx = makeCtx(config, "umans-glm-5.2", false);
    expect(PerModelRuleStep.applies(ctx)).toBe(true);
    const body: Record<string, unknown> = {
      model: "umans-glm-5.2",
      thinking: { type: "adaptive" },
      messages: [],
    };
    expect(PerModelRuleStep.apply(body, ctx)).toBe(true);
    expect(body.thinking).toEqual({ type: "enabled", clear_thinking: false });
  });
});

describe("PerModelRuleStep — OpenAI route", () => {
  it("sets openaiThinkingShape when rule matches", () => {
    const rules: PerModelRule[] = [
      { pattern: "umans-glm-*", openaiThinkingShape: { type: "enabled", keep: "all" } },
    ];
    const config = makeConfig({ stampModelRules: rules });
    const ctx = makeCtx(config, "umans-glm-5.2", true);
    const body: Record<string, unknown> = {
      model: "umans-glm-5.2",
      thinking: { type: "adaptive" },
      messages: [],
    };
    expect(PerModelRuleStep.apply(body, ctx)).toBe(true);
    expect(body.thinking).toEqual({ type: "enabled", keep: "all" });
  });

  it("merges openaiExtraBody fields at top level when openaiExtraBody is set", () => {
    const rules: PerModelRule[] = [
      {
        pattern: "umans-flash",
        openaiExtraBody: { enable_thinking: true, preserve_thinking: true },
      },
    ];
    const config = makeConfig({ stampModelRules: rules });
    const ctx = makeCtx(config, "umans-flash", true);
    const body: Record<string, unknown> = { model: "umans-flash", messages: [] };
    expect(PerModelRuleStep.apply(body, ctx)).toBe(true);
    expect(body.enable_thinking).toBe(true);
    expect(body.preserve_thinking).toBe(true);
    expect(body.extra_body).toBeUndefined();
  });

  it("merges openaiExtraBody fields onto existing top-level keys (shallow merge)", () => {
    const rules: PerModelRule[] = [
      {
        pattern: "umans-flash",
        openaiExtraBody: { preserve_thinking: true },
      },
    ];
    const config = makeConfig({ stampModelRules: rules });
    const ctx = makeCtx(config, "umans-flash", true);
    const body: Record<string, unknown> = {
      model: "umans-flash",
      enable_thinking: true,
      messages: [],
    };
    expect(PerModelRuleStep.apply(body, ctx)).toBe(true);
    expect(body.enable_thinking).toBe(true);
    expect(body.preserve_thinking).toBe(true);
    expect(body.extra_body).toBeUndefined();
  });

  it("combines openaiThinkingShape + openaiExtraBody in one rule", () => {
    const rules: PerModelRule[] = [
      {
        pattern: "umans-flash",
        openaiThinkingShape: { type: "enabled" },
        openaiExtraBody: { enable_thinking: true, preserve_thinking: true },
      },
    ];
    const config = makeConfig({ stampModelRules: rules });
    const ctx = makeCtx(config, "umans-flash", true);
    const body: Record<string, unknown> = {
      model: "umans-flash",
      thinking: { type: "adaptive" },
      messages: [],
    };
    expect(PerModelRuleStep.apply(body, ctx)).toBe(true);
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.enable_thinking).toBe(true);
    expect(body.preserve_thinking).toBe(true);
    expect(body.extra_body).toBeUndefined();
  });
});

describe("OpenAiReasoningStep — surgical veto behavior", () => {
  it("applies() returns true even when veto=true (veto is in apply, not applies)", () => {
    const rules: PerModelRule[] = [{ pattern: "umans-kimi-k2.7", openaiVetoReasoningEffort: true }];
    const config = makeConfig({ stampModelRules: rules, stampReasoningEffort: "high" });
    const ctx = makeCtx(config, "umans-kimi-k2.7", true);
    expect(OpenAiReasoningStep.applies(ctx)).toBe(true);
  });

  it("veto=true: skips reasoning_effort injection but forces temperature", () => {
    const rules: PerModelRule[] = [{ pattern: "umans-kimi-k2.7", openaiVetoReasoningEffort: true }];
    const config = makeConfig({ stampModelRules: rules, stampReasoningEffort: "high" });
    const ctx = makeCtx(config, "umans-kimi-k2.7", true);
    const body: Record<string, unknown> = {
      model: "umans-kimi-k2.7",
      thinking: { type: "enabled" },
      temperature: 0.5,
      messages: [],
    };
    const changed = OpenAiReasoningStep.apply(body, ctx);
    expect(changed).toBe(true);
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.temperature).toBe(1.0);
  });

  it("veto=true: no thinking field → no-op (nothing to strip)", () => {
    const rules: PerModelRule[] = [{ pattern: "umans-kimi-k2.7", openaiVetoReasoningEffort: true }];
    const config = makeConfig({ stampModelRules: rules, stampReasoningEffort: "high" });
    const ctx = makeCtx(config, "umans-kimi-k2.7", true);
    const body: Record<string, unknown> = { model: "umans-kimi-k2.7", messages: [] };
    expect(OpenAiReasoningStep.apply(body, ctx)).toBe(false);
  });

  it("veto=true: also strips output_config and context_management", () => {
    const rules: PerModelRule[] = [{ pattern: "umans-kimi-k2.7", openaiVetoReasoningEffort: true }];
    const config = makeConfig({ stampModelRules: rules, stampReasoningEffort: "high" });
    const ctx = makeCtx(config, "umans-kimi-k2.7", true);
    const body: Record<string, unknown> = {
      model: "umans-kimi-k2.7",
      thinking: { type: "enabled" },
      output_config: { effort: "high" },
      context_management: { foo: "bar" },
      messages: [],
    };
    OpenAiReasoningStep.apply(body, ctx);
    expect(body.output_config).toBeUndefined();
    expect(body.context_management).toBeUndefined();
  });

  it("veto=false (or absent): injects reasoning_effort normally", () => {
    const rules: PerModelRule[] = [{ pattern: "umans-glm-*" }];
    const config = makeConfig({ stampModelRules: rules, stampReasoningEffort: "high" });
    const ctx = makeCtx(config, "umans-glm-5.2", true);
    const body: Record<string, unknown> = {
      model: "umans-glm-5.2",
      thinking: { type: "enabled" },
      messages: [],
    };
    OpenAiReasoningStep.apply(body, ctx);
    expect(body.reasoning_effort).toBe("max");
    expect(body.thinking).toEqual({ type: "enabled" });
  });

  it("veto only applies on matching rule (non-matching model unaffected)", () => {
    const rules: PerModelRule[] = [{ pattern: "umans-kimi-k2.7", openaiVetoReasoningEffort: true }];
    const config = makeConfig({ stampModelRules: rules, stampReasoningEffort: "high" });
    const ctx = makeCtx(config, "umans-glm-5.2", true);
    const body: Record<string, unknown> = {
      model: "umans-glm-5.2",
      thinking: { type: "enabled" },
      messages: [],
    };
    OpenAiReasoningStep.apply(body, ctx);
    expect(body.reasoning_effort).toBe("max");
  });

  it("applies() returns false when stampReasoningEffort is null", () => {
    const rules: PerModelRule[] = [{ pattern: "umans-glm-*" }];
    const config = makeConfig({ stampModelRules: rules, stampReasoningEffort: null });
    const ctx = makeCtx(config, "umans-glm-5.2", true);
    expect(OpenAiReasoningStep.applies(ctx)).toBe(false);
  });
});

describe("resolvePerModelRule — edge cases", () => {
  it("returns null for undefined model name", () => {
    const rules: PerModelRule[] = [{ pattern: "umans-glm-*" }];
    expect(resolvePerModelRule(undefined, rules)).toBeNull();
  });

  it("returns null for non-array input", () => {
    expect(resolvePerModelRule("umans-glm-5.2", null as never)).toBeNull();
  });

  it("orphan config keys (stamp_glm_5_2_thinking_enabled) are silently ignored", () => {
    const rules: PerModelRule[] = [
      {
        pattern: "umans-glm-*",
        anthropicThinkingShape: { type: "enabled", clear_thinking: false },
      },
    ];
    const rule = resolvePerModelRule("umans-glm-5.2", rules);
    expect(rule).not.toBeNull();
    expect(rule?.pattern).toBe("umans-glm-*");
  });
});

describe("PerModelRuleStep — umans-coder (veto=yes, keep:all)", () => {
  it("Anthropic: forces {type:enabled, keep:all}", () => {
    const rules: PerModelRule[] = [
      {
        pattern: "umans-coder",
        anthropicThinkingShape: { type: "enabled", keep: "all" },
        openaiThinkingShape: { type: "enabled", keep: "all" },
        openaiVetoReasoningEffort: true,
      },
    ];
    const config = makeConfig({ stampModelRules: rules });
    const ctx = makeCtx(config, "umans-coder", false);
    const body: Record<string, unknown> = {
      model: "umans-coder",
      thinking: { type: "adaptive" },
      messages: [],
    };
    PerModelRuleStep.apply(body, ctx);
    expect(body.thinking).toEqual({ type: "enabled", keep: "all" });
  });

  it("OpenAI: sets thinking shape, veto prevents reasoning_effort injection", () => {
    const rules: PerModelRule[] = [
      {
        pattern: "umans-coder",
        anthropicThinkingShape: { type: "enabled", keep: "all" },
        openaiThinkingShape: { type: "enabled", keep: "all" },
        openaiVetoReasoningEffort: true,
      },
    ];
    const config = makeConfig({ stampModelRules: rules, stampReasoningEffort: "high" });
    const ctx = makeCtx(config, "umans-coder", true);
    const body: Record<string, unknown> = {
      model: "umans-coder",
      thinking: { type: "adaptive" },
      messages: [],
    };
    PerModelRuleStep.apply(body, ctx);
    expect(body.thinking).toEqual({ type: "enabled", keep: "all" });
    OpenAiReasoningStep.apply(body, ctx);
    expect(body.reasoning_effort).toBeUndefined();
  });
});

describe("PerModelRuleStep — umans-qwen3.6-35b-a3b (bare enabled + extra_body)", () => {
  it("Anthropic: forces bare {type:enabled}", () => {
    const rules: PerModelRule[] = [
      {
        pattern: "umans-qwen*",
        anthropicThinkingShape: { type: "enabled" },
        openaiExtraBody: { enable_thinking: true, preserve_thinking: true },
      },
    ];
    const config = makeConfig({ stampModelRules: rules });
    const ctx = makeCtx(config, "umans-qwen3.6-35b-a3b", false);
    const body: Record<string, unknown> = {
      model: "umans-qwen3.6-35b-a3b",
      thinking: { type: "adaptive" },
      messages: [],
    };
    PerModelRuleStep.apply(body, ctx);
    expect(body.thinking).toEqual({ type: "enabled" });
  });

  it("OpenAI: merges openaiExtraBody fields at top level", () => {
    const rules: PerModelRule[] = [
      {
        pattern: "umans-qwen*",
        anthropicThinkingShape: { type: "enabled" },
        openaiExtraBody: { enable_thinking: true, preserve_thinking: true },
      },
    ];
    const config = makeConfig({ stampModelRules: rules });
    const ctx = makeCtx(config, "umans-qwen3.6-35b-a3b", true);
    const body: Record<string, unknown> = { model: "umans-qwen3.6-35b-a3b", messages: [] };
    PerModelRuleStep.apply(body, ctx);
    expect(body.enable_thinking).toBe(true);
    expect(body.preserve_thinking).toBe(true);
    expect(body.extra_body).toBeUndefined();
  });
});

describe("Pipeline ordering — PerModelRuleStep overrides AnthropicBodyStep", () => {
  it("rule with adaptive shape overrides GLM overlay's clear_thinking shape", () => {
    const rules: PerModelRule[] = [
      {
        pattern: "umans-glm-*",
        anthropicThinkingShape: { type: "adaptive" },
      },
    ];
    const config = makeConfig({ stampModelRules: rules, stampClaudeCode: true });
    const ctx = makeCtx(config, "umans-glm-5.2", false);
    const body: Record<string, unknown> = {
      model: "umans-glm-5.2",
      thinking: { type: "enabled", budget_tokens: 1024 },
      messages: [],
    };
    AnthropicBodyStep.apply(body, ctx);
    expect(body.thinking).toEqual({ type: "adaptive" });
    PerModelRuleStep.apply(body, ctx);
    expect(body.thinking).toEqual({ type: "adaptive" });
  });

  it("rule with bare enabled overrides overlay's adaptive shape", () => {
    const rules: PerModelRule[] = [
      {
        pattern: "umans-flash",
        anthropicThinkingShape: { type: "enabled" },
      },
    ];
    const config = makeConfig({ stampModelRules: rules, stampClaudeCode: true });
    const ctx = makeCtx(config, "umans-flash", false);
    const body: Record<string, unknown> = {
      model: "umans-flash",
      thinking: { type: "adaptive" },
      messages: [],
    };
    AnthropicBodyStep.apply(body, ctx);
    PerModelRuleStep.apply(body, ctx);
    expect(body.thinking).toEqual({ type: "enabled" });
  });
});

describe("PerModelRuleStep — umans-kimi-k3 (adaptive rule)", () => {
  it("Anthropic: forces {type:adaptive} matching overlay", () => {
    const rules: PerModelRule[] = [
      {
        pattern: "umans-kimi-k3",
        anthropicThinkingShape: { type: "adaptive" },
      },
    ];
    const config = makeConfig({ stampModelRules: rules });
    const ctx = makeCtx(config, "umans-kimi-k3", false);
    const body: Record<string, unknown> = {
      model: "umans-kimi-k3",
      thinking: { type: "enabled", keep: "all" },
      messages: [],
    };
    PerModelRuleStep.apply(body, ctx);
    expect(body.thinking).toEqual({ type: "adaptive" });
  });

  it("OpenAI: forces {type:enabled} via openaiThinkingShape, reasoning_effort injected", () => {
    const rules: PerModelRule[] = [
      {
        pattern: "umans-kimi-k3",
        anthropicThinkingShape: { type: "adaptive" },
        openaiThinkingShape: { type: "enabled" },
      },
    ];
    const config = makeConfig({ stampModelRules: rules, stampReasoningEffort: "high" });
    const ctx = makeCtx(config, "umans-kimi-k3", true);
    const body: Record<string, unknown> = {
      model: "umans-kimi-k3",
      thinking: { type: "adaptive" },
      messages: [],
    };
    PerModelRuleStep.apply(body, ctx);
    expect(body.thinking).toEqual({ type: "enabled" });
    OpenAiReasoningStep.apply(body, ctx);
    expect(body.reasoning_effort).toBe("max");
  });
});

describe("PerModelRuleStep — no reasoning signal → thinking untouched", () => {
  it("OpenAI: null thinking + null reasoning_effort → thinking absent (no stamp)", () => {
    const rules: PerModelRule[] = [
      {
        pattern: "umans-glm-*",
        openaiThinkingShape: { type: "enabled", keep: "all" },
      },
    ];
    const config = makeConfig({ stampModelRules: rules });
    const ctx = makeCtx(config, "umans-glm-5.2", true);
    const body: Record<string, unknown> = { model: "umans-glm-5.2", messages: [] };
    PerModelRuleStep.apply(body, ctx);
    expect(body.thinking).toBeUndefined();
  });

  it("OpenAI: disabled thinking + null reasoning_effort → thinking stays disabled (no override)", () => {
    const rules: PerModelRule[] = [
      {
        pattern: "umans-glm-*",
        openaiThinkingShape: { type: "enabled", keep: "all" },
      },
    ];
    const config = makeConfig({ stampModelRules: rules });
    const ctx = makeCtx(config, "umans-glm-5.2", true);
    const body: Record<string, unknown> = {
      model: "umans-glm-5.2",
      thinking: { type: "disabled" },
      messages: [],
    };
    PerModelRuleStep.apply(body, ctx);
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("Anthropic: null thinking + canDisable=true (GLM) → thinking stays absent (no force)", () => {
    const rules: PerModelRule[] = [
      {
        pattern: "umans-glm-*",
        anthropicThinkingShape: { type: "enabled", clear_thinking: false },
      },
    ];
    const config = makeConfig({ stampModelRules: rules });
    const ctx = makeCtx(config, "umans-glm-5.2", false);
    const body: Record<string, unknown> = { model: "umans-glm-5.2", messages: [] };
    PerModelRuleStep.apply(body, ctx);
    expect(body.thinking).toBeUndefined();
  });

  it("Anthropic: null thinking + canDisable=false (Kimi K2.7) → force shape + max_tokens + output_config", () => {
    const rules: PerModelRule[] = [
      {
        pattern: "umans-kimi-k2.7",
        anthropicThinkingShape: { type: "enabled", keep: "all" },
      },
    ];
    const config = makeConfig({ stampModelRules: rules });
    const ctx = makeCtx(config, "umans-kimi-k2.7", false);
    const body: Record<string, unknown> = { model: "umans-kimi-k2.7", messages: [] };
    PerModelRuleStep.apply(body, ctx);
    expect(body.thinking).toEqual({ type: "enabled", keep: "all" });
    expect(body.max_tokens).toBe(32767);
    expect(body.output_config).toEqual({ effort: "high" });
  });

  it("Anthropic: disabled thinking + canDisable=true (GLM) → thinking stays disabled (no force)", () => {
    const rules: PerModelRule[] = [
      {
        pattern: "umans-glm-*",
        anthropicThinkingShape: { type: "enabled", clear_thinking: false },
      },
    ];
    const config = makeConfig({ stampModelRules: rules });
    const ctx = makeCtx(config, "umans-glm-5.2", false);
    const body: Record<string, unknown> = {
      model: "umans-glm-5.2",
      thinking: { type: "disabled" },
      messages: [],
    };
    PerModelRuleStep.apply(body, ctx);
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("Anthropic: disabled thinking + canDisable=false (Kimi K2.7) → force shape + max_tokens + output_config", () => {
    const rules: PerModelRule[] = [
      {
        pattern: "umans-kimi-k2.7",
        anthropicThinkingShape: { type: "enabled", keep: "all" },
      },
    ];
    const config = makeConfig({ stampModelRules: rules });
    const ctx = makeCtx(config, "umans-kimi-k2.7", false);
    const body: Record<string, unknown> = {
      model: "umans-kimi-k2.7",
      thinking: { type: "disabled" },
      messages: [],
    };
    PerModelRuleStep.apply(body, ctx);
    expect(body.thinking).toEqual({ type: "enabled", keep: "all" });
    expect(body.max_tokens).toBe(32767);
    expect(body.output_config).toEqual({ effort: "high" });
  });
});

describe("PerModelRuleStep — OpenAI reasoning_effort → thinking shape resolution", () => {
  it("OpenAI: reasoning_effort present + null thinking → shape applied (not disabled)", () => {
    const rules: PerModelRule[] = [
      {
        pattern: "umans-glm-*",
        openaiThinkingShape: { type: "enabled", keep: "all" },
      },
    ];
    const config = makeConfig({ stampModelRules: rules });
    const ctx = makeCtx(config, "umans-glm-5.2", true);
    const body: Record<string, unknown> = {
      model: "umans-glm-5.2",
      reasoning_effort: "high",
      messages: [],
    };
    PerModelRuleStep.apply(body, ctx);
    expect(body.thinking).toEqual({ type: "enabled", keep: "all" });
    expect(body.reasoning_effort).toBe("high");
  });

  it("OpenAI: reasoning_effort:off + null thinking → thinking absent (no stamp)", () => {
    const rules: PerModelRule[] = [
      {
        pattern: "umans-glm-*",
        openaiThinkingShape: { type: "enabled", keep: "all" },
      },
    ];
    const config = makeConfig({ stampModelRules: rules });
    const ctx = makeCtx(config, "umans-glm-5.2", true);
    const body: Record<string, unknown> = {
      model: "umans-glm-5.2",
      reasoning_effort: "off",
      messages: [],
    };
    PerModelRuleStep.apply(body, ctx);
    expect(body.thinking).toBeUndefined();
  });

  it("OpenAI: reasoning_effort present + disabled thinking → shape applied (reasoning wins)", () => {
    const rules: PerModelRule[] = [
      {
        pattern: "umans-glm-*",
        openaiThinkingShape: { type: "enabled", keep: "all" },
      },
    ];
    const config = makeConfig({ stampModelRules: rules });
    const ctx = makeCtx(config, "umans-glm-5.2", true);
    const body: Record<string, unknown> = {
      model: "umans-glm-5.2",
      reasoning_effort: "high",
      thinking: { type: "disabled" },
      messages: [],
    };
    PerModelRuleStep.apply(body, ctx);
    expect(body.thinking).toEqual({ type: "enabled", keep: "all" });
  });
});

describe("PerModelRuleStep — umans-deepseek-v4-flash-0731 (thinking {type:enabled} on both routes)", () => {
  const deepseekRule: PerModelRule = {
    pattern: "umans-deepseek-v4-flash-0731",
    anthropicThinkingShape: { type: "enabled" },
    openaiThinkingShape: { type: "enabled" },
  };

  it("Anthropic: force bare enabled thinking shape", () => {
    const config = makeConfig({ stampModelRules: [deepseekRule] });
    const ctx = makeCtx(config, "umans-deepseek-v4-flash-0731", false);
    const body: Record<string, unknown> = {
      model: "umans-deepseek-v4-flash-0731",
      thinking: { type: "adaptive" },
      messages: [],
    };
    PerModelRuleStep.apply(body, ctx);
    expect(body.thinking).toEqual({ type: "enabled" });
  });

  it("OpenAI: reasoning active → force bare enabled thinking shape", () => {
    const config = makeConfig({ stampModelRules: [deepseekRule] });
    const ctx = makeCtx(config, "umans-deepseek-v4-flash-0731", true);
    const body: Record<string, unknown> = {
      model: "umans-deepseek-v4-flash-0731",
      reasoning_effort: "high",
      messages: [],
    };
    PerModelRuleStep.apply(body, ctx);
    expect(body.thinking).toEqual({ type: "enabled" });
  });

  it("Anthropic: forceThinkingWhenAbsent=true forces enabled even when thinking absent (revives max_tokens+output_config)", () => {
    const config = makeConfig({
      stampModelRules: [{ ...deepseekRule, forceThinkingWhenAbsent: true }],
    });
    const ctx = makeCtx(config, "umans-deepseek-v4-flash-0731", false);
    const body: Record<string, unknown> = {
      model: "umans-deepseek-v4-flash-0731",
      messages: [],
    };
    PerModelRuleStep.apply(body, ctx);
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.max_tokens).toBe(32767);
    expect(body.output_config).toEqual({ effort: "high" });
  });

  it("Anthropic: forceThinkingWhenAbsent unset → absent thinking left untouched (respect-absence default)", () => {
    const config = makeConfig({ stampModelRules: [deepseekRule] });
    const ctx = makeCtx(config, "umans-deepseek-v4-flash-0731", false);
    const body: Record<string, unknown> = {
      model: "umans-deepseek-v4-flash-0731",
      messages: [],
    };
    PerModelRuleStep.apply(body, ctx);
    expect("thinking" in body).toBe(false);
  });

  it("OpenAI: forceThinkingWhenAbsent=true forces enabled with no reasoning signal at all", () => {
    const config = makeConfig({
      stampModelRules: [{ ...deepseekRule, forceThinkingWhenAbsent: true }],
    });
    const ctx = makeCtx(config, "umans-deepseek-v4-flash-0731", true);
    const body: Record<string, unknown> = {
      model: "umans-deepseek-v4-flash-0731",
      messages: [],
    };
    PerModelRuleStep.apply(body, ctx);
    expect(body.thinking).toEqual({ type: "enabled" });
  });

  it("OpenAI: forceThinkingWhenAbsent unset → no reasoning signal leaves thinking untouched", () => {
    const config = makeConfig({ stampModelRules: [deepseekRule] });
    const ctx = makeCtx(config, "umans-deepseek-v4-flash-0731", true);
    const body: Record<string, unknown> = {
      model: "umans-deepseek-v4-flash-0731",
      messages: [],
    };
    PerModelRuleStep.apply(body, ctx);
    expect("thinking" in body).toBe(false);
  });

  it("OpenAI: forceThinkingWhenAbsent=true respects explicitly-disabled reasoning_effort (no force on reasoning_effort:none)", () => {
    const config = makeConfig({
      stampModelRules: [{ ...deepseekRule, forceThinkingWhenAbsent: true }],
    });
    const ctx = makeCtx(config, "umans-deepseek-v4-flash-0731", true);
    const body: Record<string, unknown> = {
      model: "umans-deepseek-v4-flash-0731",
      reasoning_effort: "none",
      messages: [],
    };
    PerModelRuleStep.apply(body, ctx);
    expect("thinking" in body).toBe(false);
  });
});
