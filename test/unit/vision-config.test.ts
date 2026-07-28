// Unit tests for src/config — vision intent config defaults + hot-reload.
// Verifies the 7 vision intent config keys load with correct defaults,
// are hot-reloadable (NOT in RESTART_REQUIRED_FIELDS), and apply to live ProxyConfig.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawConfig } from "../../src/config/types.js";
import { applyReloadToConfig, loadConfig } from "../../src/config.js";
import type { ProxyConfig } from "../../src/types.js";

let tmpConfigDir: string;
let origXdg: string | undefined;

beforeEach(() => {
  tmpConfigDir = mkdtempSync(join(tmpdir(), "umans-gate-vision-cfg-"));
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

function makeLiveConfig(): ProxyConfig {
  return loadConfig({});
}

const VISION_INTENT_RAW: Record<string, RawConfig> = {
  auto: {
    vision_intent_strategy: "auto",
    vision_decomposition_enabled: true,
    vision_decomposition_timeout_ms: 3000,
    vision_crafting_timeout_ms: 3000,
    vision_adjacent_text_max_chars: 500,
    vision_recent_messages_count: 6,
    vision_system_prompt_max_chars: 1000,
  },
  reloaded: {
    vision_intent_strategy: "slotted",
    vision_decomposition_enabled: false,
    vision_decomposition_timeout_ms: 8000,
    vision_crafting_timeout_ms: 9000,
    vision_adjacent_text_max_chars: 123,
    vision_recent_messages_count: 9,
    vision_system_prompt_max_chars: 555,
  },
  applied: {
    vision_intent_strategy: "crafted",
    vision_decomposition_enabled: false,
    vision_decomposition_timeout_ms: 4500,
    vision_crafting_timeout_ms: 6200,
    vision_adjacent_text_max_chars: 777,
    vision_recent_messages_count: 3,
    vision_system_prompt_max_chars: 2048,
  },
};

const VISION_INTENT_KEYS = [
  "vision_intent_strategy",
  "vision_decomposition_enabled",
  "vision_decomposition_timeout_ms",
  "vision_crafting_timeout_ms",
  "vision_adjacent_text_max_chars",
  "vision_recent_messages_count",
  "vision_system_prompt_max_chars",
] as const;

describe("vision intent config defaults", () => {
  test("loadConfig returns the 7 new defaults verbatim", () => {
    const config = loadConfig({});
    expect(config.visionIntentStrategy).toBe("auto");
    expect(config.visionDecompositionEnabled).toBe(true);
    expect(config.visionDecompositionTimeoutMs).toBe(3000);
    expect(config.visionCraftingTimeoutMs).toBe(3000);
    expect(config.visionAdjacentTextMaxChars).toBe(500);
    expect(config.visionRecentMessagesCount).toBe(6);
    expect(config.visionSystemPromptMaxChars).toBe(1000);
  });

  test("env vars override defaults for all 7 keys", () => {
    const config = loadConfig({
      VISION_INTENT_STRATEGY: "off",
      VISION_DECOMPOSITION_ENABLED: "false",
      VISION_DECOMPOSITION_TIMEOUT_MS: "5000",
      VISION_CRAFTING_TIMEOUT_MS: "7000",
      VISION_ADJACENT_TEXT_MAX_CHARS: "999",
      VISION_RECENT_MESSAGES_COUNT: "12",
      VISION_SYSTEM_PROMPT_MAX_CHARS: "2048",
    });
    expect(config.visionIntentStrategy).toBe("off");
    expect(config.visionDecompositionEnabled).toBe(false);
    expect(config.visionDecompositionTimeoutMs).toBe(5000);
    expect(config.visionCraftingTimeoutMs).toBe(7000);
    expect(config.visionAdjacentTextMaxChars).toBe(999);
    expect(config.visionRecentMessagesCount).toBe(12);
    expect(config.visionSystemPromptMaxChars).toBe(2048);
  });
});

describe("vision intent config hot-reload", () => {
  test("all 7 keys are hot-reloadable (not restart-required)", () => {
    const live = makeLiveConfig();
    const fresh = loadConfig({
      VISION_INTENT_STRATEGY: "slotted",
      VISION_DECOMPOSITION_ENABLED: "false",
      VISION_DECOMPOSITION_TIMEOUT_MS: "8000",
      VISION_CRAFTING_TIMEOUT_MS: "9000",
      VISION_ADJACENT_TEXT_MAX_CHARS: "123",
      VISION_RECENT_MESSAGES_COUNT: "9",
      VISION_SYSTEM_PROMPT_MAX_CHARS: "555",
    });
    const r = applyReloadToConfig(live, fresh, VISION_INTENT_RAW.auto, VISION_INTENT_RAW.reloaded);

    for (const key of VISION_INTENT_KEYS) {
      expect(r.applied).toContain(key);
      expect(r.restartRequired).not.toContain(key);
    }
  });

  test("reload applies all 7 new values to the live ProxyConfig", () => {
    const live = makeLiveConfig();
    const fresh = loadConfig({
      VISION_INTENT_STRATEGY: "crafted",
      VISION_DECOMPOSITION_ENABLED: "false",
      VISION_DECOMPOSITION_TIMEOUT_MS: "4500",
      VISION_CRAFTING_TIMEOUT_MS: "6200",
      VISION_ADJACENT_TEXT_MAX_CHARS: "777",
      VISION_RECENT_MESSAGES_COUNT: "3",
      VISION_SYSTEM_PROMPT_MAX_CHARS: "2048",
    });
    applyReloadToConfig(live, fresh, VISION_INTENT_RAW.auto, VISION_INTENT_RAW.applied);

    expect(live.visionIntentStrategy).toBe("crafted");
    expect(live.visionDecompositionEnabled).toBe(false);
    expect(live.visionDecompositionTimeoutMs).toBe(4500);
    expect(live.visionCraftingTimeoutMs).toBe(6200);
    expect(live.visionAdjacentTextMaxChars).toBe(777);
    expect(live.visionRecentMessagesCount).toBe(3);
    expect(live.visionSystemPromptMaxChars).toBe(2048);
  });

  test("unchanged keys are not flagged as applied or restartRequired", () => {
    const live = makeLiveConfig();
    const fresh = makeLiveConfig();
    const r = applyReloadToConfig(live, fresh, VISION_INTENT_RAW.auto, VISION_INTENT_RAW.auto);
    for (const key of VISION_INTENT_KEYS) {
      expect(r.applied).not.toContain(key);
      expect(r.restartRequired).not.toContain(key);
    }
  });
});
