// Stamp pipeline — table-driven dispatch for request body mutation steps.
// Extracted from proxy.ts to keep the proxy handler focused on transport
// (capture, streaming, forwarding) while the pipeline is independently
// testable and extensible.
//
// Dependency direction: stamp-pipeline → stamp* / types / config / helpers.
// Never imports proxy.ts (no cycles).

import {
  STAMP_CACHE_TTL_VALUE,
  STAMP_CONTEXT_MANAGEMENT_VALUE,
  STAMP_OUTPUT_CONFIG_VALUE,
  STAMP_TEMPERATURE_VALUE,
  STAMP_THINKING_VALUE,
  STAMP_TOP_K_VALUE,
} from "./config.js";
import { textDecoder } from "./helpers.js";
import { createLogger } from "./logger.js";
import { isGlmModel, resolveEffortForModel } from "./model-policy.js";
import { stampReasoning } from "./stamp-reasoning.js";
import { stampTemperature } from "./stamp-temperature.js";
import { stampThinking } from "./stamp-thinking.js";
import { stampTopK } from "./stamp-topk.js";
import { stampCacheTtl } from "./stamp.js";
import type {
  AnthropicBody,
  CaptureConfig,
  GateConfig,
  OpenAiBody,
  ProtocolConfig,
  StampConfig,
} from "./types.js";

const log = createLogger("stamp-pipeline");

// ─── Pipeline types ───────────────────────────────────────────────────────

/** Resolved config subset available to every stamp step. */
type StampPipelineConfig = StampConfig & CaptureConfig & GateConfig & ProtocolConfig;

/** Everything a stamp step needs to decide applicability and mutate the body. */
export interface StampContext {
  config: StampPipelineConfig;
  isOpenAi: boolean;
  headers: Record<string, string>;
  url: URL;
  method: string;
  modelName: string | undefined;
}

/** A single mutation step in the stamp pipeline. */
export interface StampStep {
  readonly label: string;
  applies(ctx: StampContext): boolean;
  apply(body: unknown, ctx: StampContext): boolean;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Parse a request buffer as JSON using the content-type / first-byte heuristic. */
export function parseJsonBody(
  reqBuf: Uint8Array,
  headers: Record<string, string>,
): { body: unknown; ok: boolean } {
  const ct = headers["content-type"] ?? "";
  if (!ct.includes("json") && reqBuf[0] !== 0x7b) return { body: null, ok: false };
  try {
    return { body: JSON.parse(textDecoder.decode(reqBuf)), ok: true };
  } catch {
    return { body: null, ok: false };
  }
}

// ─── Concrete steps ───────────────────────────────────────────────────────

export const CacheTtlStep: StampStep = {
  label: "ttl",
  applies(ctx) {
    return ctx.config.stampClaudeCode && !ctx.isOpenAi;
  },
  apply(body, ctx) {
    if (body === null || typeof body !== "object") return false;
    const n = stampCacheTtl(body as AnthropicBody, STAMP_CACHE_TTL_VALUE);
    if (n > 0) {
      log.info(`stamped ttl="${STAMP_CACHE_TTL_VALUE}" on ${n} block(s)`, {
        method: ctx.method,
        path: ctx.url.pathname,
      });
      return true;
    }
    return false;
  },
};

export const AnthropicBodyStep: StampStep = {
  label: "anthropic-body",
  applies(ctx) {
    return ctx.config.stampClaudeCode && !ctx.isOpenAi;
  },
  apply(body, ctx) {
    if (body === null || typeof body !== "object") return false;
    const effort = resolveEffortForModel(ctx.modelName, true);
    const outputConfigValue = effort !== undefined ? { effort } : STAMP_OUTPUT_CONFIG_VALUE;
    const changed = stampThinking(body as AnthropicBody, {
      maxTokens: true,
      thinking: STAMP_THINKING_VALUE,
      outputConfig: outputConfigValue,
    });
    if (changed) {
      log.info("stamped anthropic body fields", {
        method: ctx.method,
        path: ctx.url.pathname,
      });
      return true;
    }
    return false;
  },
};

export const ContextManagementStep: StampStep = {
  label: "context-management",
  applies(ctx) {
    return ctx.config.stampClaudeCode && !ctx.isOpenAi;
  },
  apply(body) {
    if (body === null || typeof body !== "object") return false;
    const b = body as AnthropicBody;
    b.context_management = {
      edits: STAMP_CONTEXT_MANAGEMENT_VALUE.edits.map((e) => ({ ...e })),
    };
    log.info("stamped context_management");
    return true;
  },
};

export const OpenAiReasoningStep: StampStep = {
  label: "openai-reasoning",
  applies(ctx) {
    return ctx.isOpenAi && ctx.config.stampReasoningEffort !== null;
  },
  apply(body, ctx) {
    if (body === null || typeof body !== "object") return false;
    const reasoningEffort =
      resolveEffortForModel(ctx.modelName, ctx.config.stampReasoningEffort !== null) ??
      (ctx.config.stampReasoningEffort as "high" | "max");
    const changed = stampReasoning(body as OpenAiBody, { reasoningEffort });
    if (changed) {
      log.info("stamped openai body reasoning_effort", {
        method: ctx.method,
        path: ctx.url.pathname,
      });
      return true;
    }
    return false;
  },
};

export const TopKStep: StampStep = {
  label: "top-k",
  applies(ctx) {
    return ctx.config.stampClaudeCode && isGlmModel(ctx.modelName);
  },
  apply(body, ctx) {
    if (body === null || typeof body !== "object") return false;
    const changed = stampTopK(body, STAMP_TOP_K_VALUE);
    if (changed) {
      log.info(`stamped top_k=${STAMP_TOP_K_VALUE}`, {
        method: ctx.method,
        path: ctx.url.pathname,
      });
      return true;
    }
    return false;
  },
};

export const TemperatureStep: StampStep = {
  label: "temperature",
  applies(ctx) {
    return ctx.config.stampClaudeCode;
  },
  apply(body, ctx) {
    if (body === null || typeof body !== "object") return false;
    const changed = stampTemperature(body, STAMP_TEMPERATURE_VALUE);
    if (changed) {
      log.info(`stamped temperature=${STAMP_TEMPERATURE_VALUE}`, {
        method: ctx.method,
        path: ctx.url.pathname,
      });
      return true;
    }
    return false;
  },
};

// ─── Pipeline ─────────────────────────────────────────────────────────────

/** Ordered stamp steps applied to every request body before forwarding. */
export const STAMP_PIPELINE: StampStep[] = [
  CacheTtlStep,
  AnthropicBodyStep,
  ContextManagementStep,
  OpenAiReasoningStep,
  TopKStep,
  TemperatureStep,
];
