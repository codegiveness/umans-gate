import { describe, expect, it } from "bun:test";
import { isGlmModel, resolveEffortForModel } from "../src/model-policy.js";

describe("isGlmModel", () => {
  it("returns true for umans-glm family", () => {
    expect(isGlmModel("umans-glm-foo")).toBe(true);
  });

  it("returns false for non-GLM models", () => {
    expect(isGlmModel("claude-sonnet")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isGlmModel(undefined)).toBe(false);
  });
});

describe("resolveEffortForModel", () => {
  it("resolves GLM models to 'max' when enabled", () => {
    expect(resolveEffortForModel("umans-glm-foo", true)).toBe("max");
  });

  it("resolves non-GLM models to 'high' when enabled", () => {
    expect(resolveEffortForModel("claude-sonnet", true)).toBe("high");
  });

  it("returns undefined when disabled", () => {
    expect(resolveEffortForModel("any", false)).toBe(undefined);
  });

  it("returns undefined for undefined model when disabled", () => {
    expect(resolveEffortForModel(undefined, false)).toBe(undefined);
  });
});
