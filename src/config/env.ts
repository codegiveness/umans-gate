// Env helper functions and JSON config loading.

import { existsSync, readFileSync } from "node:fs";
import type { UpstreamProtocol } from "../types.js";
import type { RawConfig } from "./types.js";

function resolveUpstreamProtocol(raw: string | undefined): UpstreamProtocol {
  const v = (raw ?? "http1.1").toLowerCase();
  if (v === "http2" || v === "h2") return "http2";
  return "http1.1";
}

function num(val: number | string | undefined | null, fallback: number): number {
  if (val === undefined || val === null) return fallback;
  const n = Number(val);
  return Number.isNaN(n) ? fallback : n;
}

function str(val: string | undefined, fallback: string): string {
  return val ?? fallback;
}

function loadJsonConfig(path: string): RawConfig {
  if (!existsSync(path)) return {};
  try {
    const text = readFileSync(path, "utf-8");
    const parsed = JSON.parse(text) as RawConfig;
    return parsed ?? {};
  } catch (err) {
    console.error(`Failed to parse config at ${path}, using defaults`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

/**
 * Coerce a raw config value to a boolean from various input shapes.
 * Accepts true/false, "true"/"false", 1/0.
 */
function bool(val: unknown, fallback: boolean): boolean {
  if (val === undefined || val === null) return fallback;
  if (typeof val === "boolean") return val;
  if (typeof val === "string") return val === "true" || val === "1";
  if (typeof val === "number") return val !== 0;
  return fallback;
}

function envOrRawNum(
  envVal: string | undefined,
  raw: RawConfig,
  key: keyof RawConfig,
  fallback: number,
): number {
  if (envVal !== undefined) return num(envVal, fallback);
  const rawVal = raw[key];
  return typeof rawVal === "number" && !Number.isNaN(rawVal) ? rawVal : fallback;
}

function envOrRawBool(
  envVal: string | undefined,
  raw: RawConfig,
  key: keyof RawConfig,
  fallback: boolean,
): boolean {
  if (envVal !== undefined) return bool(envVal, fallback);
  const rawVal = raw[key];
  return typeof rawVal === "boolean" ? rawVal : fallback;
}

export { bool, envOrRawBool, envOrRawNum, loadJsonConfig, num, resolveUpstreamProtocol, str };
