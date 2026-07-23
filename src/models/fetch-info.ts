// Shared model-info fetch utility.
//
// Fetches the /v1/models/info endpoint — a public catalog endpoint that
// does NOT require authentication. No Authorization header is sent.

import { parseModelInfoResponse } from "../model-info-parser.js";

export type { ParsedModelInfo } from "../model-info-parser.js";

import type { ParsedModelInfo } from "../model-info-parser.js";

/** Timeout for the upstream fetch (ms). */
const FETCH_TIMEOUT_MS = 15000;

/**
 * Fetch /v1/models/info from `target` and return a map keyed by model id.
 *
 * No Authorization header is sent — /v1/models/info is a public catalog.
 * Throws on any failure — non-ok HTTP status, network error, or parse
 * error — so callers can preserve their own error-handling semantics.
 */
export async function fetchModelsInfo(
  target: string,
  signal?: AbortSignal,
): Promise<Map<string, ParsedModelInfo>> {
  const resp = await fetch(target, {
    method: "GET",
    signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} from ${target}`);
  }
  const parsed = await resp.json();
  return parseModelInfoResponse(parsed);
}
