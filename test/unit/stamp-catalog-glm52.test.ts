import { describe, expect, it } from "bun:test";
import { resolvePerModelRule } from "../../src/stamp-catalog.js";
import type { PerModelRule } from "../../src/types.js";

const GLM_RULE: PerModelRule = {
  pattern: "umans-glm-*",
  anthropicThinkingShape: { type: "enabled", clear_thinking: false },
  openaiThinkingShape: { type: "enabled", keep: "all" },
};

describe("resolvePerModelRule — GLM pattern", () => {
  it("matches umans-glm-5.2 against umans-glm-* glob", () => {
    const rule = resolvePerModelRule("umans-glm-5.2", [GLM_RULE]);
    expect(rule).not.toBeNull();
    expect(rule?.anthropicThinkingShape).toEqual({
      type: "enabled",
      clear_thinking: false,
    });
  });

  it("matches umans-glm-5.2-turbo against umans-glm-* glob", () => {
    const rule = resolvePerModelRule("umans-glm-5.2-turbo", [GLM_RULE]);
    expect(rule).not.toBeNull();
    expect(rule?.pattern).toBe("umans-glm-*");
  });

  it("returns null when no rule matches", () => {
    const rule = resolvePerModelRule("umans-kimi-k2.7", [GLM_RULE]);
    expect(rule).toBeNull();
  });

  it("returns null for undefined model name", () => {
    const rule = resolvePerModelRule(undefined, [GLM_RULE]);
    expect(rule).toBeNull();
  });

  it("returns null when rules array is empty", () => {
    const rule = resolvePerModelRule("umans-glm-5.2", []);
    expect(rule).toBeNull();
  });

  it("first-match-wins when multiple rules could match", () => {
    const broad: PerModelRule = {
      pattern: "umans-*",
      anthropicThinkingShape: { type: "adaptive" },
    };
    const specific: PerModelRule = {
      pattern: "umans-glm-*",
      anthropicThinkingShape: { type: "enabled", clear_thinking: false },
    };
    const rule = resolvePerModelRule("umans-glm-5.2", [broad, specific]);
    expect(rule?.pattern).toBe("umans-*");
  });

  it("exact pattern match (no glob suffix)", () => {
    const exact: PerModelRule = {
      pattern: "umans-coder",
      anthropicThinkingShape: { type: "enabled", keep: "all" },
    };
    const rule = resolvePerModelRule("umans-coder", [exact]);
    expect(rule).not.toBeNull();
    expect(rule?.pattern).toBe("umans-coder");
  });

  it("exact pattern does NOT match prefix-only", () => {
    const exact: PerModelRule = {
      pattern: "umans-coder",
      anthropicThinkingShape: { type: "enabled", keep: "all" },
    };
    const rule = resolvePerModelRule("umans-coder-v2", [exact]);
    expect(rule).toBeNull();
  });

  it("* wildcard matches any model", () => {
    const fallback: PerModelRule = { pattern: "*", anthropicThinkingShape: { type: "adaptive" } };
    const rule = resolvePerModelRule("anything-here", [fallback]);
    expect(rule?.pattern).toBe("*");
  });
});
