import { describe, expect, test } from "bun:test";
import { computeRequestWeight } from "../../src/helpers.js";

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
  test("known model returns derived weight", () => {
    const models = new FakeModelsClient({ "umans-coder": 0.5 });
    const weight = computeRequestWeight("umans-coder", models);
    expect(weight).toBe(0.5);
  });

  test("unknown model returns default weight (1)", () => {
    const weight = computeRequestWeight("unknown-model", null);
    expect(weight).toBe(1);
  });

  test("falls back to default when model not in catalog", () => {
    const models = new FakeModelsClient({ "umans-flash": 0.25 });
    const weight = computeRequestWeight("other-model", models);
    expect(weight).toBe(1);
  });

  test("returns default weight when model name is undefined", () => {
    const models = new FakeModelsClient({ "umans-coder": 0.5 });
    const weight = computeRequestWeight(undefined, models);
    expect(weight).toBe(1);
  });

  test("returns default weight when no model source", () => {
    const weight = computeRequestWeight("umans-coder", null);
    expect(weight).toBe(1);
  });
});
