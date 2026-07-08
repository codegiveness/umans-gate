import { describe, expect, test } from "bun:test";
import { computeRequestWeight } from "../src/helpers.js";

class FakeModelsClient {
  private readonly weights: Map<string, number>;

  constructor(entries: Record<string, number> = {}) {
    this.weights = new Map(Object.entries(entries));
  }

  getWeight(modelId: string): number {
    return this.weights.get(modelId) ?? 1;
  }
}

describe("computeRequestWeight", () => {
  test("known model maps to configured weight", () => {
    const models = new FakeModelsClient({ "umans-coder": 0.5 });
    const weight = computeRequestWeight(
      { concurrencyWeights: { "umans-coder": 2 } },
      "umans-coder",
      models,
    );
    expect(weight).toBe(2);
  });

  test("unknown model returns default weight (1)", () => {
    const weight = computeRequestWeight({ concurrencyWeights: {} }, "unknown-model", null);
    expect(weight).toBe(1);
  });

  test("explicit weight of 0 is respected", () => {
    const models = new FakeModelsClient({ cheap: 0.5 });
    const weight = computeRequestWeight({ concurrencyWeights: { cheap: 0 } }, "cheap", models);
    expect(weight).toBe(0);
  });

  test("falls back to ModelsClient when no config override", () => {
    const models = new FakeModelsClient({ "umans-flash": 0.25 });
    const weight = computeRequestWeight({ concurrencyWeights: {} }, "umans-flash", models);
    expect(weight).toBe(0.25);
  });

  test("returns default weight when model name is undefined", () => {
    const models = new FakeModelsClient({ "umans-coder": 0.5 });
    const weight = computeRequestWeight({ concurrencyWeights: {} }, undefined, models);
    expect(weight).toBe(1);
  });
});
