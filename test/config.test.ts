// Tests for config.ts: JSON SSOT, auto-create, no-overwrite, env precedence,
// YAML migration, validateConfig, saveConfig, applyReloadToConfig.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyReloadToConfig,
  ensureConfigFile,
  loadConfig,
  resolveConfigDir,
  resolveConfigPath,
  saveConfig,
  validateConfig,
} from "../src/config.js";
import type { ProxyConfig } from "../src/types.js";

let tmpConfigDir: string;
let origXdg: string | undefined;

beforeEach(() => {
  tmpConfigDir = mkdtempSync(join(tmpdir(), "umans-gate-test-"));
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

test("resolveConfigDir uses XDG_CONFIG_HOME when set", () => {
  const dir = resolveConfigDir();
  expect(dir).toBe(join(tmpConfigDir, "umans-gate"));
});

test("resolveConfigPath appends config.json", () => {
  const path = resolveConfigPath();
  expect(path).toBe(join(tmpConfigDir, "umans-gate", "config.json"));
});

test("ensureConfigFile creates JSON config on first run", () => {
  const path = resolveConfigPath();
  expect(existsSync(path)).toBe(false);
  const result = ensureConfigFile();
  expect(result).toBe(path);
  expect(existsSync(path)).toBe(true);
  const content = readFileSync(path, "utf-8");
  expect(content).toContain('"port": 1945');
  expect(content).toContain('"upstream_protocol": "http1.1"');
  expect(content).toContain('"stamp_claude_code_enabled": false');
});

test("ensureConfigFile does not overwrite existing JSON config", () => {
  const path = resolveConfigPath();
  mkdirSync(join(tmpConfigDir, "umans-gate"), { recursive: true });
  const customContent = JSON.stringify({ port: 7777, umans_api_key: "secret" }, null, 2);
  writeFileSync(path, customContent, "utf-8");
  ensureConfigFile();
  const content = readFileSync(path, "utf-8");
  expect(content).toBe(customContent);
});

test("loadConfig writes JSON config on first run and returns defaults", () => {
  const path = resolveConfigPath();
  expect(existsSync(path)).toBe(false);
  const config = loadConfig({});
  expect(existsSync(path)).toBe(true);
  expect(config.port).toBe(1945);
  expect(config.host).toBe("127.0.0.1");
  expect(config.target).toBe("https://api.code.umans.ai");
  expect(config.upstreamProtocol).toBe("http1.1");
  expect(config.stampClaudeCode).toBe(false);
  expect(config.warmerEnabled).toBe(true);
});

test("loadConfig reads JSON config file when present", () => {
  const dir = join(tmpConfigDir, "umans-gate");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      port: 8080,
      upstream_protocol: "http2",
      stamp_claude_code_enabled: true,
    }),
    "utf-8",
  );
  const config = loadConfig({});
  expect(config.port).toBe(8080);
  expect(config.upstreamProtocol).toBe("http2");
  expect(config.stampClaudeCode).toBe(true);
});

test("loadConfig env vars override JSON config", () => {
  const dir = join(tmpConfigDir, "umans-gate");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      port: 8080,
      upstream_protocol: "http2",
    }),
    "utf-8",
  );
  const config = loadConfig({
    PORT: "3000",
    UPSTREAM_PROTOCOL: "http1.1",
    STAMP_CLAUDE_CODE_ENABLED: "true",
  });
  expect(config.port).toBe(3000);
  expect(config.upstreamProtocol).toBe("http1.1");
  expect(config.stampClaudeCode).toBe(true);
});

test("loadConfig falls back gracefully on malformed JSON", () => {
  const dir = join(tmpConfigDir, "umans-gate");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), "{ this is not valid json }}}", "utf-8");
  const config = loadConfig({});
  expect(config.port).toBe(1945);
  expect(config.target).toBe("https://api.code.umans.ai");
  expect(config.upstreamProtocol).toBe("http1.1");
});

test("loadConfig handles stamp_claude_code_enabled toggle", () => {
  expect(loadConfig({ STAMP_CLAUDE_CODE_ENABLED: "false" }).stampClaudeCode).toBe(false);
  expect(loadConfig({ STAMP_CLAUDE_CODE_ENABLED: "0" }).stampClaudeCode).toBe(false);
  expect(loadConfig({ STAMP_CLAUDE_CODE_ENABLED: undefined }).stampClaudeCode).toBe(false);
  expect(loadConfig({ STAMP_CLAUDE_CODE_ENABLED: "true" }).stampClaudeCode).toBe(true);
  expect(loadConfig({ STAMP_CLAUDE_CODE_ENABLED: "1" }).stampClaudeCode).toBe(true);
});

test("loadConfig strips trailing slashes from target", () => {
  const config = loadConfig({ TARGET: "https://api.example.com/" });
  expect(config.target).toBe("https://api.example.com");
  const config2 = loadConfig({ TARGET: "https://api.example.com///" });
  expect(config2.target).toBe("https://api.example.com");
});

test("loadConfig clamps idle_timeout to 255", () => {
  expect(loadConfig({ IDLE_TIMEOUT: "999" }).idleTimeout).toBe(255);
  expect(loadConfig({ IDLE_TIMEOUT: "100" }).idleTimeout).toBe(100);
  expect(loadConfig({ IDLE_TIMEOUT: undefined }).idleTimeout).toBe(255);
});

test("loadConfig warmer_enabled env overrides JSON config", () => {
  const dir = join(tmpConfigDir, "umans-gate");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ warmer_enabled: false }), "utf-8");
  expect(loadConfig({ WARMER_ENABLED: "true" }).warmerEnabled).toBe(true);
  expect(loadConfig({ WARMER_ENABLED: "1" }).warmerEnabled).toBe(true);
  expect(loadConfig({ WARMER_ENABLED: "false" }).warmerEnabled).toBe(false);
  expect(loadConfig({ WARMER_ENABLED: "0" }).warmerEnabled).toBe(false);
  expect(loadConfig({}).warmerEnabled).toBe(false);
});

test("loadConfig warmer_enabled defaults to true when absent from JSON", () => {
  const dir = join(tmpConfigDir, "umans-gate");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ port: 1945 }), "utf-8");
  expect(loadConfig({}).warmerEnabled).toBe(true);
});

// --- validateConfig tests ---

test("validateConfig accepts a valid default config", () => {
  const r = validateConfig({});
  expect(r.ok).toBe(true);
  expect(r.errors).toEqual([]);
  expect(r.normalized.port).toBe(1945);
});

test("validateConfig rejects out-of-range port", () => {
  expect(validateConfig({ port: 0 }).ok).toBe(false);
  expect(validateConfig({ port: 70000 }).ok).toBe(false);
  expect(validateConfig({ port: 1945 }).ok).toBe(true);
});

test("validateConfig rejects invalid upstream_protocol", () => {
  expect(validateConfig({ upstream_protocol: "http3" }).ok).toBe(false);
  expect(validateConfig({ upstream_protocol: "http1.1" }).ok).toBe(true);
  expect(validateConfig({ upstream_protocol: "http2" }).ok).toBe(true);
});

test("validateConfig accepts boolean stamp_claude_code_enabled", () => {
  expect(validateConfig({ stamp_claude_code_enabled: true }).ok).toBe(true);
  expect(validateConfig({ stamp_claude_code_enabled: false }).ok).toBe(true);
  expect(validateConfig({ stamp_claude_code_enabled: undefined }).ok).toBe(true);
});

test("validateConfig rejects non-boolean stamp_claude_code_enabled", () => {
  expect(validateConfig({ stamp_claude_code_enabled: "yes" as unknown as boolean }).ok).toBe(false);
  expect(validateConfig({ stamp_claude_code_enabled: 1 as unknown as boolean }).ok).toBe(false);
});

test("validateConfig rejects invalid idle_timeout", () => {
  expect(validateConfig({ idle_timeout: 0 }).ok).toBe(false);
  expect(validateConfig({ idle_timeout: 256 }).ok).toBe(false);
  expect(validateConfig({ idle_timeout: 100 }).ok).toBe(true);
});

// --- saveConfig tests ---

test("saveConfig writes valid patch to disk", () => {
  ensureConfigFile();
  const r = saveConfig({ port: 7777 });
  expect(r.ok).toBe(true);
  expect(r.errors).toEqual([]);
  const json = JSON.parse(readFileSync(resolveConfigPath(), "utf-8"));
  expect(json.port).toBe(7777);
});

test("saveConfig rejects invalid patch and does not write", () => {
  ensureConfigFile();
  const before = readFileSync(resolveConfigPath(), "utf-8");
  const r = saveConfig({ port: 99999 });
  expect(r.ok).toBe(false);
  expect(r.errors.length).toBeGreaterThan(0);
  // File unchanged.
  expect(readFileSync(resolveConfigPath(), "utf-8")).toBe(before);
});

test("saveConfig merges patch with existing config", () => {
  ensureConfigFile();
  saveConfig({ port: 7777 });
  const r = saveConfig({ max_captures: 500 });
  expect(r.ok).toBe(true);
  const json = JSON.parse(readFileSync(resolveConfigPath(), "utf-8"));
  // Both the earlier and the new change are present.
  expect(json.port).toBe(7777);
  expect(json.max_captures).toBe(500);
});

// --- applyReloadToConfig tests ---

function makeLiveConfig(): ProxyConfig {
  return loadConfig({});
}

test("applyReloadToConfig applies hot-reloadable fields", () => {
  const live = makeLiveConfig();
  // fresh reflects the newRaw values — simulate a reload from disk where stamp_claude_code_enabled changed.
  const fresh = loadConfig({ STAMP_CLAUDE_CODE_ENABLED: "true" });
  const oldRaw = { stamp_claude_code_enabled: false };
  const newRaw = { stamp_claude_code_enabled: true };
  const r = applyReloadToConfig(live, fresh, oldRaw, newRaw);
  expect(r.applied).toContain("stamp_claude_code_enabled");
  expect(live.stampClaudeCode).toBe(true);
});

test("applyReloadToConfig flags restartRequired for non-reloadable fields", () => {
  const live = makeLiveConfig();
  const fresh = loadConfig({});
  const oldRaw = { port: 1945 };
  const newRaw = { port: 7777 };
  const r = applyReloadToConfig(live, fresh, oldRaw, newRaw);
  expect(r.restartRequired).toContain("port");
  // Port is NOT applied to live.
  expect(live.port).toBe(1945);
});

// --- UI data flow tests (strings from HTML inputs) ---

test("validateConfig coerces numeric strings from UI inputs", () => {
  // The dashboard sends strings (e.target.value) for every field.
  // validateConfig must coerce these before Number.isInteger() checks.
  const r = validateConfig({
    port: "7777",
    idle_timeout: "120",
    max_captures: "5000",
  });
  expect(r.ok).toBe(true);
  expect(r.errors).toEqual([]);
  expect(r.normalized.port).toBe(7777);
  expect(r.normalized.idle_timeout).toBe(120);
  expect(r.normalized.max_captures).toBe(5000);
});

test("saveConfig accepts string-valued numeric patches from UI", () => {
  ensureConfigFile();
  const r = saveConfig({ port: "7777" });
  expect(r.ok).toBe(true);
  expect(r.errors).toEqual([]);
  const json = JSON.parse(readFileSync(resolveConfigPath(), "utf-8"));
  expect(json.port).toBe(7777);
});

test("validateConfig accepts boolean stamp_reasoning_effort_enabled", () => {
  expect(validateConfig({ stamp_reasoning_effort_enabled: true }).ok).toBe(true);
  expect(validateConfig({ stamp_reasoning_effort_enabled: false }).ok).toBe(true);
  expect(validateConfig({ stamp_reasoning_effort_enabled: undefined }).ok).toBe(true);
});

test("validateConfig rejects non-boolean stamp_reasoning_effort_enabled", () => {
  expect(validateConfig({ stamp_reasoning_effort_enabled: "yes" as unknown as boolean }).ok).toBe(
    false,
  );
  expect(validateConfig({ stamp_reasoning_effort_enabled: 1 as unknown as boolean }).ok).toBe(
    false,
  );
});

test("loadConfig handles stamp_reasoning_effort_enabled toggle", () => {
  expect(loadConfig({ STAMP_REASONING_EFFORT_ENABLED: undefined }).stampReasoningEffort).toBeNull();
  expect(loadConfig({ STAMP_REASONING_EFFORT_ENABLED: "false" }).stampReasoningEffort).toBeNull();
  expect(loadConfig({ STAMP_REASONING_EFFORT_ENABLED: "0" }).stampReasoningEffort).toBeNull();
  expect(loadConfig({ STAMP_REASONING_EFFORT_ENABLED: "true" }).stampReasoningEffort).toBe("high");
  expect(loadConfig({ STAMP_REASONING_EFFORT_ENABLED: "1" }).stampReasoningEffort).toBe("high");
});

test("loadConfig returns memory-tuning defaults", () => {
  const c = loadConfig({});
  expect(c.captureBodyMaxBytes).toBe(10_000_000);
  expect(c.queueMaxDepth).toBe(100);
  expect(c.wsBackpressureLimit).toBe(1_048_576);
  expect(c.wsCloseOnBackpressureLimit).toBe(true);
  expect(c.visionPendingMaxBatch).toBe(50);
});

test("loadConfig env overrides memory-tuning fields", () => {
  const c = loadConfig({
    CAPTURE_BODY_MAX_BYTES: "2000000",
    QUEUE_MAX_DEPTH: "250",
    WS_BACKPRESSURE_LIMIT: "2097152",
    WS_CLOSE_ON_BACKPRESSURE_LIMIT: "false",
    VISION_PENDING_MAX_BATCH: "75",
  });
  expect(c.captureBodyMaxBytes).toBe(2_000_000);
  expect(c.queueMaxDepth).toBe(250);
  expect(c.wsBackpressureLimit).toBe(2_097_152);
  expect(c.wsCloseOnBackpressureLimit).toBe(false);
  expect(c.visionPendingMaxBatch).toBe(75);
});

test("loadConfig memory-tuning JSON config overrides defaults", () => {
  const dir = join(tmpConfigDir, "umans-gate");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      capture_body_max_bytes: 4_000_000,
      queue_max_depth: 150,
      ws_backpressure_limit: 0,
      ws_close_on_backpressure_limit: false,
      vision_pending_max_batch: 25,
    }),
    "utf-8",
  );
  const c = loadConfig({});
  expect(c.captureBodyMaxBytes).toBe(4_000_000);
  expect(c.queueMaxDepth).toBe(150);
  expect(c.wsBackpressureLimit).toBe(0);
  expect(c.wsCloseOnBackpressureLimit).toBe(false);
  expect(c.visionPendingMaxBatch).toBe(25);
});

test("loadConfig env takes precedence over JSON for memory-tuning fields", () => {
  const dir = join(tmpConfigDir, "umans-gate");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      capture_body_max_bytes: 4_000_000,
      queue_max_depth: 150,
      ws_backpressure_limit: 0,
      ws_close_on_backpressure_limit: false,
      vision_pending_max_batch: 25,
    }),
    "utf-8",
  );
  const c = loadConfig({
    CAPTURE_BODY_MAX_BYTES: "500000",
    QUEUE_MAX_DEPTH: "10",
    WS_BACKPRESSURE_LIMIT: "1024",
    WS_CLOSE_ON_BACKPRESSURE_LIMIT: "true",
    VISION_PENDING_MAX_BATCH: "5",
  });
  expect(c.captureBodyMaxBytes).toBe(500_000);
  expect(c.queueMaxDepth).toBe(10);
  expect(c.wsBackpressureLimit).toBe(1024);
  expect(c.wsCloseOnBackpressureLimit).toBe(true);
  expect(c.visionPendingMaxBatch).toBe(5);
});

test("validateConfig accepts memory-tuning defaults", () => {
  const r = validateConfig({});
  expect(r.ok).toBe(true);
  expect(r.normalized.capture_body_max_bytes).toBe(10_000_000);
  expect(r.normalized.queue_max_depth).toBe(100);
  expect(r.normalized.ws_backpressure_limit).toBe(1_048_576);
  expect(r.normalized.ws_close_on_backpressure_limit).toBe(true);
  expect(r.normalized.vision_pending_max_batch).toBe(50);
});

test("validateConfig rejects invalid memory-tuning values", () => {
  expect(validateConfig({ capture_body_max_bytes: -1 }).ok).toBe(false);
  expect(validateConfig({ capture_body_max_bytes: 1.5 }).ok).toBe(false);
  expect(validateConfig({ queue_max_depth: 0 }).ok).toBe(false);
  expect(validateConfig({ ws_backpressure_limit: -1 }).ok).toBe(false);
  expect(validateConfig({ ws_close_on_backpressure_limit: "yes" as unknown as boolean }).ok).toBe(
    false,
  );
  expect(validateConfig({ vision_pending_max_batch: 0 }).ok).toBe(false);
});

test("validateConfig coerces memory-tuning numeric strings from UI", () => {
  const r = validateConfig({
    capture_body_max_bytes: "2000000",
    queue_max_depth: "250",
    ws_backpressure_limit: "0",
    vision_pending_max_batch: "75",
  });
  expect(r.ok).toBe(true);
  expect(r.normalized.capture_body_max_bytes).toBe(2_000_000);
  expect(r.normalized.queue_max_depth).toBe(250);
  expect(r.normalized.ws_backpressure_limit).toBe(0);
  expect(r.normalized.vision_pending_max_batch).toBe(75);
});

test("saveConfig persists memory-tuning fields", () => {
  ensureConfigFile();
  const r = saveConfig({
    capture_body_max_bytes: 2_000_000,
    queue_max_depth: 250,
    ws_backpressure_limit: 0,
    ws_close_on_backpressure_limit: false,
    vision_pending_max_batch: 75,
  });
  expect(r.ok).toBe(true);
  const json = JSON.parse(readFileSync(resolveConfigPath(), "utf-8"));
  expect(json.capture_body_max_bytes).toBe(2_000_000);
  expect(json.queue_max_depth).toBe(250);
  expect(json.ws_backpressure_limit).toBe(0);
  expect(json.ws_close_on_backpressure_limit).toBe(false);
  expect(json.vision_pending_max_batch).toBe(75);
});
