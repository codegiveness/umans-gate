// StatusClient — fetches upstream /v1/status for per-model p50 TTFT latency.
//
// The smart TTFT watchdog uses this to compute a dynamic threshold on
// attempt 1: instead of a fixed ttft_timeout_ms, the watchdog fires at
// min(modelP50 * multiplier, effective_hard_cap). This module handles the
// fetch (with shared-promise dedup + 5s timeout) and the model-bridging
// chain (direct name → base_model.name via ModelsClient → overall p50).

import { createLogger } from "./logger.js";
import type { ModelsClient } from "./models.js";

const log = createLogger("status-client");

const STATUS_PATH = "/v1/status";
const FETCH_TIMEOUT_MS = 5000;

/** Per-model entry in the /v1/status response. */
export interface StatusModelEntry {
  p50_ttft_ms: number;
  p50_tps: number | null;
}

/**
 * Shape of the /v1/status response.
 *
 * Designed from ADR-0026: "real-time status endpoint reporting per-model
 * p50 TTFT latency over a 5-minute window" plus an overall p50. The
 * upstream is expected to return `{ models: { [name]: { p50_ttft_ms,
 * p50_tps } }, overall: { p50_ttft_ms } | null }`.
 */
export interface StatusResponse {
  models: Record<string, StatusModelEntry>;
  overall: { p50_ttft_ms: number } | null;
}

/** Result of a status lookup for a specific model. */
export interface StatusResult {
  modelP50: number | null;
  overallP50: number | null;
  tpsP50: number | null;
}

export interface StatusClientOptions {
  target: string;
  apiKey: string | null;
  models: ModelsClient;
}

export class StatusClient {
  private readonly target: string;
  private readonly apiKey: string | null;
  private readonly models: ModelsClient;
  /** Shared-promise dedup: concurrent fetches for the same target share one request. */
  private inflight: Map<string, Promise<StatusResponse | null>> = new Map();

  constructor(opts: StatusClientOptions) {
    this.target = opts.target.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.models = opts.models;
  }

  /**
   * Fetch /v1/status and bridge to the requested model.
   * Concurrent calls share one in-flight fetch (keyed by target URL).
   * Returns null on fetch failure or timeout.
   */
  async fetchStatus(model: string): Promise<StatusResult | null> {
    const resp = await this.fetchStatusRaw();
    if (!resp) return null;
    return this.bridgeModel(resp, model);
  }

  /**
   * Raw status fetch with shared-promise dedup.
   * Returns null on failure/timeout.
   */
  private fetchStatusRaw(): Promise<StatusResponse | null> {
    const existing = this.inflight.get(this.target);
    if (existing) return existing;
    const p = this.doFetch().finally(() => {
      this.inflight.delete(this.target);
    });
    this.inflight.set(this.target, p);
    return p;
  }

  private async doFetch(): Promise<StatusResponse | null> {
    const url = `${this.target}${STATUS_PATH}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {};
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
      const resp = await fetch(url, { method: "GET", headers, signal: controller.signal });
      if (!resp.ok) {
        log.warn(`status fetch failed: HTTP ${resp.status} from ${url}`);
        return null;
      }
      const parsed = (await resp.json()) as StatusResponse;
      if (!parsed || typeof parsed !== "object" || typeof parsed.models !== "object") {
        log.warn("status fetch returned unexpected shape", { url });
        return null;
      }
      return parsed;
    } catch (e) {
      const err = e as Error;
      if (err.name === "AbortError") {
        log.warn(`status fetch timed out after ${FETCH_TIMEOUT_MS}ms`, { url });
      } else {
        log.warn(`status fetch error: ${err.message}`, { url });
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Bridge a model name to its p50 via:
   * 1. Direct match in status response
   * 2. base_model.name via ModelsClient (refresh if not in cache), then look up base model
   * 3. Overall p50 fallback
   * 4. null
   */
  private async bridgeModel(resp: StatusResponse, model: string): Promise<StatusResult> {
    const overallP50 = resp.overall?.p50_ttft_ms ?? null;

    // 1. Direct match
    const direct = resp.models[model];
    if (direct) {
      return { modelP50: direct.p50_ttft_ms, overallP50, tpsP50: direct.p50_tps ?? null };
    }

    // 2. base_model.name bridging (refresh cache if model unknown)
    let entry = this.models.get(model);
    if (!entry) {
      await this.models.refresh();
      entry = this.models.get(model);
    }
    if (entry) {
      const baseName = entry.info?.base_model?.name;
      if (baseName) {
        const baseMatch = resp.models[baseName];
        if (baseMatch) {
          return { modelP50: baseMatch.p50_ttft_ms, overallP50, tpsP50: baseMatch.p50_tps ?? null };
        }
      }
    }

    // 3. Overall p50 fallback
    if (overallP50 !== null) {
      return { modelP50: overallP50, overallP50, tpsP50: null };
    }

    // 4. No data
    return { modelP50: null, overallP50: null, tpsP50: null };
  }
}
