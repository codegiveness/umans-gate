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

/** Per-model entry in the /v1/status response (nested live shape). */
export interface StatusModelEntry {
  latency?: { ttft_ms?: { p50?: number | null } };
  output_tokens_per_second?: { p50?: number | null };
}

/**
 * Shape of the /v1/status response (matches the live upstream API).
 *
 * ADR-0026 described a flat `{ p50_ttft_ms, p50_tps }` shape, but the live
 * `/v1/status` endpoint returns nested `latency.ttft_ms.p50` and
 * `output_tokens_per_second.p50`. This interface reflects the real shape.
 * `overall` may be `null` per ADR-0026.
 */
export interface StatusResponse {
  models: Record<string, StatusModelEntry>;
  overall?: { latency?: { ttft_ms?: { p50?: number | null } } } | null;
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
   * 2. Sibling bridging: find another info entry with the same base_model.name
   *    that IS in the status response (e.g. umans-coder → umans-kimi-k2.7,
   *    both base "kimi-k2.7-code"; umans-qwen3.6-35b-a3b → umans-flash,
   *    both base "Qwen3.6-35B-A3b"). Refresh info cache if model unknown.
   * 3. Overall p50 fallback
   * 4. null
   */
  private async bridgeModel(resp: StatusResponse, model: string): Promise<StatusResult> {
    const overallP50 = resp.overall?.latency?.ttft_ms?.p50 ?? null;

    // 1. Direct match
    const direct = resp.models[model];
    if (direct) {
      return {
        modelP50: direct.latency?.ttft_ms?.p50 ?? null,
        overallP50,
        tpsP50: direct.output_tokens_per_second?.p50 ?? null,
      };
    }

    // 2. Sibling bridging via shared base_model.name (refresh cache if unknown)
    let entry = this.models.get(model);
    if (!entry) {
      await this.models.refresh();
      entry = this.models.get(model);
    }
    const baseName = entry?.info?.base_model?.name;
    if (baseName) {
      for (const [siblingId, sibling] of Object.entries(resp.models)) {
        if (siblingId === model) continue;
        const siblingEntry = this.models.get(siblingId);
        if (siblingEntry?.info?.base_model?.name === baseName) {
          return {
            modelP50: sibling.latency?.ttft_ms?.p50 ?? null,
            overallP50,
            tpsP50: sibling.output_tokens_per_second?.p50 ?? null,
          };
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
