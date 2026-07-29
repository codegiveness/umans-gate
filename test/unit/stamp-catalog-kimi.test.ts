import { describe, expect, it } from "bun:test";
import { resolvePerModelRule } from "../../src/stamp-catalog.js";
import type { PerModelRule } from "../../src/types.js";

const KIMI_RULE: PerModelRule = {
  pattern: "umans-kimi-k2.7",
  anthropicThinkingShape: { type: "enabled", keep: "all" },
  openaiThinkingShape: { type: "enabled", keep: "all" },
  openaiVetoReasoningEffort: true,
};

describe("resolvePerModelRule — Kimi K2.7 pattern", () => {
  it("matches umans-kimi-k2.7 exact pattern", () => {
    const rule = resolvePerModelRule("umans-kimi-k2.7", [KIMI_RULE]);
    expect(rule).not.toBeNull();
    expect(rule?.anthropicThinkingShape).toEqual({
      type: "enabled",
      keep: "all",
    });
    expect(rule?.openaiVetoReasoningEffort).toBe(true);
  });

  it("does NOT match umans-kimi-k2.7-code (exact match only)", () => {
    const rule = resolvePerModelRule("umans-kimi-k2.7-code", [KIMI_RULE]);
    expect(rule).toBeNull();
  });

  it("does NOT match umans-kimi-k2.6", () => {
    const rule = resolvePerModelRule("umans-kimi-k2.6", [KIMI_RULE]);
    expect(rule).toBeNull();
  });

  it("GLM rule does not match kimi model", () => {
    const glmRule: PerModelRule = {
      pattern: "umans-glm-*",
      anthropicThinkingShape: { type: "enabled", clear_thinking: false },
    };
    const rule = resolvePerModelRule("umans-kimi-k2.7", [glmRule]);
    expect(rule).toBeNull();
  });

  it("returns null for undefined model name", () => {
    const rule = resolvePerModelRule(undefined, [KIMI_RULE]);
    expect(rule).toBeNull();
  });

  it("returns null when rules array is empty", () => {
    const rule = resolvePerModelRule("umans-kimi-k2.7", []);
    expect(rule).toBeNull();
  });

  it("kimi-k3 uses glob pattern with veto=false", () => {
    const k3Rule: PerModelRule = {
      pattern: "umans-kimi-k3*",
      anthropicThinkingShape: { type: "adaptive" },
      openaiThinkingShape: { type: "enabled" },
    };
    const rule = resolvePerModelRule("umans-kimi-k3", [k3Rule]);
    expect(rule).not.toBeNull();
    expect(rule?.anthropicThinkingShape).toEqual({ type: "adaptive" });
    expect(rule?.openaiVetoReasoningEffort).toBeUndefined();
  });
});
