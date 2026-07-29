import { describe, expect, it } from "bun:test";
import { applyModelSpecificThinkingOverride, type StampPolicy } from "../../src/stamp-catalog.js";

/** A representative GLM overlay policy used as the input base. */
const GLM_BASE: StampPolicy = {
  max_tokens: 131071,
  effort: "max",
  thinking: true,
  top_k: 20,
  canDisableThinking: true,
  thinkingShape: { type: "enabled", clear_thinking: false },
};

describe("applyModelSpecificThinkingOverride — GLM 5.2 toggle", () => {
  it("overrides thinkingShape to GLM Preserved Thinking when child ON + version matches", () => {
    const out = applyModelSpecificThinkingOverride(GLM_BASE, "umans-glm-5.2", {
      stampGlm52Thinking: true,
      stampKimiK27CodeThinking: false,
    });
    expect(out.thinkingShape).toEqual({
      type: "enabled",
      clear_thinking: false,
    });
  });

  it("falls back to adaptive when child ON but version does NOT match", () => {
    const out = applyModelSpecificThinkingOverride(GLM_BASE, "umans-glm-5.1", {
      stampGlm52Thinking: true,
      stampKimiK27CodeThinking: false,
    });
    expect(out.thinkingShape).toEqual({ type: "adaptive" });
  });

  it("falls back to adaptive when child OFF (regardless of model)", () => {
    const out = applyModelSpecificThinkingOverride(GLM_BASE, "umans-glm-5.2", {
      stampGlm52Thinking: false,
      stampKimiK27CodeThinking: false,
    });
    expect(out.thinkingShape).toEqual({ type: "adaptive" });
  });

  it("does NOT override canDisableThinking — stays from the base policy", () => {
    const out = applyModelSpecificThinkingOverride(GLM_BASE, "umans-glm-5.2", {
      stampGlm52Thinking: true,
      stampKimiK27CodeThinking: false,
    });
    expect(out.canDisableThinking).toBe(GLM_BASE.canDisableThinking);
  });

  it("does NOT override max_tokens, effort, top_k, thinking", () => {
    const out = applyModelSpecificThinkingOverride(GLM_BASE, "umans-glm-5.2", {
      stampGlm52Thinking: true,
      stampKimiK27CodeThinking: false,
    });
    expect(out.max_tokens).toBe(GLM_BASE.max_tokens);
    expect(out.effort).toBe(GLM_BASE.effort);
    expect(out.top_k).toBe(GLM_BASE.top_k);
    expect(out.thinking).toBe(GLM_BASE.thinking);
  });

  it("returns a new object (does not mutate the input policy)", () => {
    const input = { ...GLM_BASE };
    const out = applyModelSpecificThinkingOverride(input, "umans-glm-5.2", {
      stampGlm52Thinking: true,
      stampKimiK27CodeThinking: false,
    });
    expect(out).not.toBe(input);
    expect(input.thinkingShape).toEqual(GLM_BASE.thinkingShape);
  });

  it("matches version segment with suffix (umans-glm-5.2-turbo)", () => {
    const out = applyModelSpecificThinkingOverride(GLM_BASE, "umans-glm-5.2-turbo", {
      stampGlm52Thinking: true,
      stampKimiK27CodeThinking: false,
    });
    expect(out.thinkingShape).toEqual({
      type: "enabled",
      clear_thinking: false,
    });
  });

  it("falls back to adaptive for undefined model name even when child is ON", () => {
    const out = applyModelSpecificThinkingOverride(GLM_BASE, undefined, {
      stampGlm52Thinking: true,
      stampKimiK27CodeThinking: false,
    });
    expect(out.thinkingShape).toEqual({ type: "adaptive" });
  });
});
