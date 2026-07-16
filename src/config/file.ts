// Config file I/O: read, save, reset, ensure.

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { DEFAULT_CONFIG } from "./defaults.js";
import { loadJsonConfig } from "./env.js";
import { resolveConfigPath } from "./paths.js";
import type { RawConfig, RawConfigInput } from "./types.js";
import { type ValidationContext, coerceRawForValidation, validateConfig } from "./validation.js";

/**
 * Write the default config template if no config file exists.
 */
export function ensureConfigFile(): string {
  const path = resolveConfigPath();
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
    try {
      chmodSync(path, 0o600);
    } catch {
      // File permissions are best-effort — some filesystems (e.g. Windows) don't support chmod.
    }
  }
  return path;
}

/**
 * Read the raw config.json from disk (for the config UI).
 * Returns defaults merged with the file contents (no env override).
 */
export function readConfigFile(): RawConfig {
  const path = ensureConfigFile();
  const raw = loadJsonConfig(path);
  return { ...DEFAULT_CONFIG, ...raw };
}

/**
 * Save a partial config to disk (validate first, merge with existing).
 * Returns validation result + the merged config that was written.
 */
export function saveConfig(
  patch: RawConfigInput,
  ctx?: ValidationContext,
): {
  ok: boolean;
  errors: string[];
  warnings: string[];
  written: RawConfig | null;
} {
  const existing = readConfigFile();
  const merged: RawConfig = { ...existing, ...coerceRawForValidation(patch) };
  const result = validateConfig(merged, ctx);
  if (!result.ok) {
    return { ok: false, errors: result.errors, warnings: result.warnings, written: null };
  }
  const path = resolveConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(result.normalized, null, 2), "utf-8");
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort: not all platforms support chmod.
  }
  return { ok: true, errors: [], warnings: result.warnings, written: result.normalized };
}

/**
 * Reset config to defaults on disk, preserving `umans_api_key` so the user is
 * not locked out of the upstream. Returns the written config.
 */
export function resetConfig(): { ok: boolean; written: RawConfig | null } {
  const existing = readConfigFile();
  const reset: RawConfig = {
    ...DEFAULT_CONFIG,
    umans_api_key: existing.umans_api_key ?? DEFAULT_CONFIG.umans_api_key,
  };
  const path = resolveConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(reset, null, 2), "utf-8");
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort: not all platforms support chmod.
  }
  return { ok: true, written: reset };
}
