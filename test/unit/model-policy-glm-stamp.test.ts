import { describe, expect, it } from "bun:test";
import type { ParsedModelInfo } from "../../src/model-info-parser.js";
import { matchStampOverlay, resolveStampPolicy } from "../../src/stamp-catalog.js";

function makeEntry(name: string): ParsedModelInfo {
  return {
    name,
    display_name: "",
    description: "",
    base_model: { name: "", provider: undefined, family: undefined, oss_base: undefined },
    capabilities: {
      max_completion_tokens: 0,
      recommended_max_tokens: 0,
      context_window: 0,
      supports_vision: false,
      supports_tools: false,
      reasoning: { supported: false, can_disable: false, levels: [], default_level: null },
    },
    benchmarks: {},
    weights: { precision: undefined, hf_url: undefined },
    stage: undefined,
    lifecycle: undefined,
    stamps: matchStampOverlay(name),
  };
}

describe("resolveStampPolicy", () => {
  it("resolves GLM models to max-effort policy from catalog", () => {
    const catalog = new Map<string, ParsedModelInfo>([
      ["umans-glm-foo", makeEntry("umans-glm-foo")],
    ]);
    const p = resolveStampPolicy("umans-glm-foo", catalog);
    expect(p.max_tokens).toBe(131071);
    expect(p.effort).toBe("max");
    expect(p.thinking).toBe(true);
    expect(p.top_k).toBe(20);
  });

  it("resolves non-GLM models to high-effort policy from catalog", () => {
    const catalog = new Map<string, ParsedModelInfo>([["umans-legacy", makeEntry("umans-legacy")]]);
    const p = resolveStampPolicy("umans-legacy", catalog);
    expect(p.max_tokens).toBe(32767);
    expect(p.effort).toBe("high");
    expect(p.thinking).toBe(false);
    expect(p.top_k).toBe(null);
  });

  it("falls back to pattern match when model is absent from catalog", () => {
    const catalog = new Map<string, ParsedModelInfo>();
    const p = resolveStampPolicy("umans-glm-foo", catalog);
    expect(p.max_tokens).toBe(131071);
    expect(p.effort).toBe("max");
    expect(p.thinking).toBe(true);
    expect(p.top_k).toBe(20);
  });

  it("falls back to STAMP_OVERLAY['*'] when modelName is undefined", () => {
    const catalog = new Map<string, ParsedModelInfo>([
      ["umans-glm-foo", makeEntry("umans-glm-foo")],
    ]);
    const p = resolveStampPolicy(undefined, catalog);
    expect(p.max_tokens).toBe(32767);
    expect(p.effort).toBe("high");
    expect(p.thinking).toBe(false);
    expect(p.top_k).toBe(null);
  });
});
