// Tests for saveConfigLocked: async mutex wrapper around saveConfig.
// Bug C4 — refreshLimits + saveConfig read-modify-write race.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig, saveConfigLocked } from "../../src/config.js";

let tmpConfigDir: string;
let origXdg: string | undefined;

beforeEach(() => {
  tmpConfigDir = mkdtempSync(join(tmpdir(), "umans-gate-test-"));
  origXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmpConfigDir;
  // Seed an initial config file so readConfigFile has something to merge.
  saveConfig({ port: 1945, concurrency_hard_cap: 1, concurrency_soft_limit: 1 });
});

afterEach(() => {
  if (origXdg === undefined) {
    Reflect.deleteProperty(process.env, "XDG_CONFIG_HOME");
  } else {
    process.env.XDG_CONFIG_HOME = origXdg;
  }
  rmSync(tmpConfigDir, { recursive: true, force: true });
});

function readJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(tmpConfigDir, "umans-gate", "config.json"), "utf-8"));
}

describe("saveConfigLocked — async mutex wrapper", () => {
  test("concurrent saves with different fields → both fields persisted (no lost update)", async () => {
    await Promise.all([
      saveConfigLocked({ concurrency_hard_cap: 10 }),
      saveConfigLocked({ concurrency_soft_limit: 5 }),
    ]);

    const cfg = readJson();
    expect(cfg.concurrency_hard_cap).toBe(10);
    expect(cfg.concurrency_soft_limit).toBe(5);
  });

  test("refreshLimits-style save concurrent with dashboard-style save → both changes preserved", async () => {
    // refreshLimits saves concurrency fields; dashboard saves an unrelated field.
    await Promise.all([
      saveConfigLocked({ concurrency_hard_cap: 8, concurrency_soft_limit: 4 }),
      saveConfigLocked({ max_captures: 500 }),
    ]);

    const cfg = readJson();
    expect(cfg.concurrency_hard_cap).toBe(8);
    expect(cfg.concurrency_soft_limit).toBe(4);
    expect(cfg.max_captures).toBe(500);
  });

  test("mutex does not deadlock — all queued saves eventually complete", async () => {
    const N = 20;
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < N; i++) {
      promises.push(saveConfigLocked({ max_captures: 200 + i }));
    }
    await Promise.all(promises);

    const cfg = readJson();
    // Last write wins for max_captures (serial execution).
    expect(cfg.max_captures).toBe(200 + N - 1);
  });

  test("saveConfig (sync) is unchanged — returns sync result object", () => {
    const result = saveConfig({ port: 7777 });
    expect(result.ok).toBe(true);
    expect(result.written).not.toBeNull();
    expect(result.written?.port).toBe(7777);

    const cfg = readJson();
    expect(cfg.port).toBe(7777);
  });

  test("saveConfigLocked returns the save result (ok + written)", async () => {
    const result = await saveConfigLocked({ port: 8888 });
    expect(result.ok).toBe(true);
    expect(result.written).not.toBeNull();
    expect(result.written?.port).toBe(8888);

    const cfg = readJson();
    expect(cfg.port).toBe(8888);
  });
});
