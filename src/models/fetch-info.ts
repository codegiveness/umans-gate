// Shared model-info fetch utility.
//
// Both src/models.ts (ModelsClient) and src/vision/catalog.ts
// (ModelInfoClient) fetch the /v1/models/info endpoint with the same
// pattern: add a Bearer Authorization header, GET the JSON body, and
// parse it via parseModelInfoResponse into a map keyed by model id.
// This module extracts that shared fetch+parse pipeline so both
// consumers share one implementation.

import { parseModelInfoResponse } from "../model-info-parser.js";

export type { ParsedModelInfo } from "../model-info-parser.js";
import type { ParsedModelInfo } from "../model-info-parser.js";

/** Timeout for the upstream fetch (ms). */
const FETCH_TIMEOUT_MS = 15000;

/**
 * Fetch /v1/models/info from `target` and return a map keyed by model id.
 *
 * Adds a `Bearer <apiKey>` Authorization header when `apiKey` is non-empty.
 * Throws on any failure — non-ok HTTP status, network error, or parse
 * error — so callers can preserve their own error-handling semantics.
 */
export async function fetchModelsInfo(
  target: string,
  apiKey: string | undefined,
  signal?: AbortSignal,
): Promise<Map<string, ParsedModelInfo>> {
  const headers: Record<string, string> = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const resp = await fetch(target, {
    method: "GET",
    headers,
    signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} from ${target}`);
  }
  const parsed = await resp.json();
  return parseModelInfoResponse(parsed);
}
