// Bug C1: Classify 5 orphan config fields correctly.
// Before the fix, these fields were neither in RESTART_REQUIRED_FIELDS nor
// RELOAD_FIELDS, so applyReloadToConfig misclassified them as hot-reloadable
// (pushed into `applied[]`) without any apply function, leaving the live
// ProxyConfig stale.

import { describe, expect, test } from "bun:test";
import { applyReloadToConfig, loadConfig } from "../../src/config.js";
import type { ProxyConfig } from "../../src/types.js";

function makeLiveConfig(): ProxyConfig {
  return loadConfig({});
}

describe("applyReloadToConfig orphan field classification", () => {
  test("upstream_timeout_ms change is hot-reloaded into live config", () => {
    const live = makeLiveConfig();
    const fresh = loadConfig({ UPSTREAM_TIMEOUT_MS: "120000" });
    const oldRaw = { upstream_timeout_ms: 300000 };
    const newRaw = { upstream_timeout_ms: 120000 };
    const r = applyReloadToConfig(live, fresh, oldRaw, newRaw);

    expect(r.applied).toContain("upstream_timeout_ms");
    expect(r.restartRequired).not.toContain("upstream_timeout_ms");
    expect(live.upstreamTimeoutMs).toBe(120000);
  });

  test("queue_max_depth change is flagged as restartRequired", () => {
    const live = makeLiveConfig();
    const fresh = loadConfig({});
    const oldRaw = { queue_max_depth: 100 };
    const newRaw = { queue_max_depth: 500 };
    const r = applyReloadToConfig(live, fresh, oldRaw, newRaw);

    expect(r.restartRequired).toContain("queue_max_depth");
    expect(r.applied).not.toContain("queue_max_depth");
  });

  test("ws_backpressure_limit change is flagged as restartRequired", () => {
    const live = makeLiveConfig();
    const fresh = loadConfig({});
    const oldRaw = { ws_backpressure_limit: 1048576 };
    const newRaw = { ws_backpressure_limit: 2097152 };
    const r = applyReloadToConfig(live, fresh, oldRaw, newRaw);

    expect(r.restartRequired).toContain("ws_backpressure_limit");
    expect(r.applied).not.toContain("ws_backpressure_limit");
  });

  test("ws_close_on_backpressure_limit change is flagged as restartRequired", () => {
    const live = makeLiveConfig();
    const fresh = loadConfig({});
    const oldRaw = { ws_close_on_backpressure_limit: true };
    const newRaw = { ws_close_on_backpressure_limit: false };
    const r = applyReloadToConfig(live, fresh, oldRaw, newRaw);

    expect(r.restartRequired).toContain("ws_close_on_backpressure_limit");
    expect(r.applied).not.toContain("ws_close_on_backpressure_limit");
  });

  test("vision_pending_max_batch change is flagged as restartRequired", () => {
    const live = makeLiveConfig();
    const fresh = loadConfig({});
    const oldRaw = { vision_pending_max_batch: 8 };
    const newRaw = { vision_pending_max_batch: 32 };
    const r = applyReloadToConfig(live, fresh, oldRaw, newRaw);

    expect(r.restartRequired).toContain("vision_pending_max_batch");
    expect(r.applied).not.toContain("vision_pending_max_batch");
  });
});
