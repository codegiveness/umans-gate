// Tests for the `request_rate_margin` config field: default value, env override,
// and validation (must be a non-negative integer, 0 allowed).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, validateConfig } from "../../src/config.js";

let tmpConfigDir: string;
let origXdg: string | undefined;

beforeEach(() => {
  tmpConfigDir = mkdtempSync(join(tmpdir(), "umans-gate-margin-test-"));
  origXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmpConfigDir;
});

afterEach(() => {
  if (origXdg === undefined) {
    Reflect.deleteProperty(process.env, "XDG_CONFIG_HOME");
  } else {
    process.env.XDG_CONFIG_HOME = origXdg;
  }
  rmSync(tmpConfigDir, { recursive: true, force: true });
});

describe("request_rate_margin", () => {
  test("loadConfig defaults to 50", () => {
    expect(loadConfig({}).requestRateMargin).toBe(50);
  });

  test("loadConfig env REQUEST_RATE_MARGIN overrides", () => {
    expect(loadConfig({ REQUEST_RATE_MARGIN: "120" }).requestRateMargin).toBe(120);
  });

  test("validation accepts 0", () => {
    const r = validateConfig({ request_rate_margin: 0 });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test("validation accepts positive integer", () => {
    const r = validateConfig({ request_rate_margin: 75 });
    expect(r.ok).toBe(true);
    expect(r.normalized.request_rate_margin).toBe(75);
  });

  test("validation rejects negative integer", () => {
    const r = validateConfig({ request_rate_margin: -5 });
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(["request_rate_margin must be a non-negative integer"]);
  });

  test("validation rejects float", () => {
    const r = validateConfig({ request_rate_margin: 49.5 });
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(["request_rate_margin must be a non-negative integer"]);
  });

  test("validation rejects non-integer string", () => {
    const r = validateConfig({ request_rate_margin: "abc" as unknown as number });
    expect(r.ok).toBe(false);
  });
});
