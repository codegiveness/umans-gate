import { describe, expect, it } from "bun:test";
import { applyModelSpecificThinkingOverride, type StampPolicy } from "../../src/stamp-catalog.js";

/** A representative Kimi overlay policy used as the input base. */
const KIMI_BASE: StampPolicy = {
  max_tokens: 32767,
  effort: "high",
  thinking: true,
  top_k: null,
  canDisableThinking: false,
  thinkingShape: { type: "enabled", keep: "all", budget_tokens: 32000 },
};

describe("applyModelSpecificThinkingOverride — Kimi K2.7-Code toggle", () => {
  it("overrides thinkingShape to Kimi Preserved Thinking when child ON + version matches", () => {
    const out = applyModelSpecificThinkingOverride(KIMI_BASE, "umans-kimi-k2.7-code", {
      stampGlm52Thinking: false,
      stampKimiK27CodeThinking: true,
    });
    expect(out.thinkingShape).toEqual({
      type: "enabled",
      keep: "all",
      budget_tokens: 32000,
    });
  });

  it("matches version segment with suffix (umans-kimi-k2.7-code-highspeed)", () => {
    const out = applyModelSpecificThinkingOverride(KIMI_BASE, "umans-kimi-k2.7-code-highspeed", {
      stampGlm52Thinking: false,
      stampKimiK27CodeThinking: true,
    });
    expect(out.thinkingShape).toEqual({
      type: "enabled",
      keep: "all",
      budget_tokens: 32000,
    });
  });

  it("falls back to adaptive when child ON but version does NOT match (k2.6)", () => {
    const out = applyModelSpecificThinkingOverride(KIMI_BASE, "umans-kimi-k2.6", {
      stampGlm52Thinking: false,
      stampKimiK27CodeThinking: true,
    });
    expect(out.thinkingShape).toEqual({ type: "adaptive" });
  });

  it("falls back to adaptive when child OFF (regardless of model)", () => {
    const out = applyModelSpecificThinkingOverride(KIMI_BASE, "umans-kimi-k2.7-code", {
      stampGlm52Thinking: false,
      stampKimiK27CodeThinking: false,
    });
    expect(out.thinkingShape).toEqual({ type: "adaptive" });
  });

  it("does NOT override canDisableThinking — stays false from the Kimi overlay", () => {
    const out = applyModelSpecificThinkingOverride(KIMI_BASE, "umans-kimi-k2.7-code", {
      stampGlm52Thinking: false,
      stampKimiK27CodeThinking: true,
    });
    expect(out.canDisableThinking).toBe(false);
    expect(out.canDisableThinking).toBe(KIMI_BASE.canDisableThinking);
  });

  it("does NOT override max_tokens, effort, top_k, thinking", () => {
    const out = applyModelSpecificThinkingOverride(KIMI_BASE, "umans-kimi-k2.7-code", {
      stampGlm52Thinking: false,
      stampKimiK27CodeThinking: true,
    });
    expect(out.max_tokens).toBe(KIMI_BASE.max_tokens);
    expect(out.effort).toBe(KIMI_BASE.effort);
    expect(out.top_k).toBe(KIMI_BASE.top_k);
    expect(out.thinking).toBe(KIMI_BASE.thinking);
  });

  it("returns a new object (does not mutate the input policy)", () => {
    const input = { ...KIMI_BASE };
    const out = applyModelSpecificThinkingOverride(input, "umans-kimi-k2.7-code", {
      stampGlm52Thinking: false,
      stampKimiK27CodeThinking: true,
    });
    expect(out).not.toBe(input);
    expect(input.thinkingShape).toEqual(KIMI_BASE.thinkingShape);
  });

  it("falls back to adaptive for undefined model name even when child is ON", () => {
    const out = applyModelSpecificThinkingOverride(KIMI_BASE, undefined, {
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
