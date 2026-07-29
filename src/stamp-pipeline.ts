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
  STAMP_TEMPERATURE_VALUE,
  STAMP_TOP_K_VALUE,
} from "./config.js";
import { stripOmoReminder } from "./experiments/strip-omo-reminder.js";
import { textDecoder } from "./helpers.js";
import { createLogger } from "./logger.js";
import type { ParsedModelInfo } from "./model-info-parser.js";
import { restampBreakpoints } from "./restamp-breakpoints.js";
import { stampCacheTtl } from "./stamp.js";
import { resolvePerModelRule, resolveStampPolicy } from "./stamp-catalog.js";
import { stampReasoning } from "./stamp-reasoning.js";
import { stampTemperature } from "./stamp-temperature.js";
import { isThinkingDisabled, isThinkingEnabled, stampThinking } from "./stamp-thinking.js";
import { stampTopK } from "./stamp-topk.js";
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
  /** Parsed model catalog — used by steps to resolve per-model StampPolicy. */
  catalog: Map<string, ParsedModelInfo>;
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

/**
 * Restamp cache_control breakpoints to Layout B (system[0] + last user message)
 * before any other stamping. Runs first so `CacheTtlStep` stamps `ttl` on the
 * restamped breakpoints. Part of the Claude Code stamp bundle — gated on
 * `stampClaudeCode && !isOpenAi`. See ADR 0002.
 */
export const RestampBreakpointsStep: StampStep = {
  label: "restamp-breakpoints",
  applies(ctx) {
    return ctx.config.stampClaudeCode && !ctx.isOpenAi;
  },
  apply(body, ctx) {
    if (body === null || typeof body !== "object") return false;
    const cleaned = restampBreakpoints(body as AnthropicBody);
    if (cleaned === body) return false;
    // Copy changed fields back to the original body in place (same contract
    // as the other in-place steps). restampBreakpoints is pure.
    const b = body as AnthropicBody;
    if (cleaned.system !== b.system) b.system = cleaned.system;
    if (cleaned.messages !== b.messages) b.messages = cleaned.messages;
    log.info("restamped breakpoints to Layout B (system + last user)", {
      method: ctx.method,
      path: ctx.url.pathname,
    });
    return true;
  },
};
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
    const b = body as AnthropicBody;
    let changed = false;
    const policy = resolveStampPolicy(ctx.modelName, ctx.catalog);
    if (
      stampThinking(b, {
        maxTokens: true,
        thinking: true,
        outputConfig: { effort: policy.effort },
        policy,
      })
    ) {
      changed = true;
    }
    if ("reasoning_effort" in b) {
      delete b.reasoning_effort;
      changed = true;
    }
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
  apply(body, _ctx) {
    if (body === null || typeof body !== "object") return false;
    const b = body as AnthropicBody;
    if (!isThinkingEnabled(b.thinking)) return false;
    b.context_management = {
      edits: STAMP_CONTEXT_MANAGEMENT_VALUE.edits.map((e) => ({ ...e })),
    };
    log.info("stamped context_management");
    return true;
  },
};

/**
 * Per-model rule step (ADR-0020). Applies config-driven per-model overrides
 * for thinking shape (Anthropic) and thinking-strip/extra_body/veto (OpenAI).
 * Independent of stampClaudeCode and stampReasoningEffort — fires whenever
 * a matching rule exists.
 *
 * Position: after AnthropicBody (so rules can override its thinkingShape),
 * before ContextManagement (so a rule-forced thinking enables context mgmt),
 * before OpenAiReasoning (so veto flag is visible).
 */
export const PerModelRuleStep: StampStep = {
  label: "per-model-rule",
  applies(ctx) {
    if (ctx.config.stampModelRules.length === 0) return false;
    return resolvePerModelRule(ctx.modelName, ctx.config.stampModelRules) !== null;
  },
  apply(body, ctx) {
    if (body === null || typeof body !== "object") return false;
    const rule = resolvePerModelRule(ctx.modelName, ctx.config.stampModelRules);
    if (!rule) return false;
    let changed = false;

    const shape = ctx.isOpenAi ? rule.openaiThinkingShape : rule.anthropicThinkingShape;
    if (shape) {
      const existing = (body as Record<string, unknown>).thinking;
      if (ctx.isOpenAi && (existing == null || isThinkingDisabled(existing))) {
        (body as Record<string, unknown>).thinking = { type: "disabled" };
      } else {
        (body as Record<string, unknown>).thinking = { ...shape };
      }
      changed = true;
    }

    if (rule.openaiExtraBody) {
      const existing = (body as Record<string, unknown>).extra_body;
      const merged = {
        ...(typeof existing === "object" && existing !== null ? existing : {}),
        ...rule.openaiExtraBody,
      };
      (body as Record<string, unknown>).extra_body = merged;
      changed = true;
    }

    if (changed) {
      log.info("applied per-model rule", {
        method: ctx.method,
        path: ctx.url.pathname,
        pattern: rule.pattern,
      });
      return true;
    }
    return false;
  },
};

export const OpenAiReasoningStep: StampStep = {
  label: "openai-reasoning",
  applies(ctx) {
    return ctx.isOpenAi && ctx.config.stampReasoningEffort !== null;
  },
  apply(body, ctx) {
    if (body === null || typeof body !== "object") return false;
    const policy = resolveStampPolicy(ctx.modelName, ctx.catalog);
    const rule = resolvePerModelRule(ctx.modelName, ctx.config.stampModelRules);
    const changed = stampReasoning(body as OpenAiBody, {
      reasoningEffort: ctx.config.stampReasoningEffort,
      policy,
      vetoReasoningEffort: rule?.openaiVetoReasoningEffort === true,
    });
    if (changed) {
      log.info(`stamped reasoning_effort=${ctx.config.stampReasoningEffort}`, {
        method: ctx.method,
        path: ctx.url.pathname,
      });
      return true;
    }
    return false;
  },
};

export const OpenAiStreamUsageStep: StampStep = {
  label: "openai-stream-usage",
  applies(ctx) {
    return ctx.isOpenAi && ctx.config.stampReasoningEffort !== null;
  },
  apply(body, ctx) {
    if (body === null || typeof body !== "object") return false;
    const b = body as OpenAiBody;
    if (b.stream !== true) return false;
    if (b.stream_options?.include_usage === true) return false;
    b.stream_options = { include_usage: true };
    log.info("stamped stream_options.include_usage", {
      method: ctx.method,
      path: ctx.url.pathname,
    });
    return true;
  },
};

export const TopKStep: StampStep = {
  label: "top-k",
  applies(ctx) {
    if (ctx.isOpenAi) {
      if (ctx.config.stampReasoningEffort == null) return false;
    } else {
      if (!ctx.config.stampClaudeCode) return false;
    }
    const policy = resolveStampPolicy(ctx.modelName, ctx.catalog);
    return policy.top_k !== null;
  },
  apply(body, ctx) {
    if (body === null || typeof body !== "object") return false;
    const b = body as AnthropicBody;
    if (ctx.isOpenAi) {
      if (b.reasoning_effort === undefined) return false;
    } else {
      if (!isThinkingEnabled(b.thinking)) return false;
    }
    const policy = resolveStampPolicy(ctx.modelName, ctx.catalog);
    const changed = stampTopK(body, STAMP_TOP_K_VALUE, policy);
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
    return ctx.config.stampClaudeCode && !ctx.isOpenAi;
  },
  apply(body, ctx) {
    if (body === null || typeof body !== "object") return false;
    const b = body as AnthropicBody;
    if (!isThinkingEnabled(b.thinking)) return false;
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

// ─── Post-stamp experiment steps ─────────────────────────────────────────

/**
 * Strip oh-my-openagent's [Category+Skill Reminder] injection from
 * messages[0].content on Anthropic requests. Runs AFTER all stamp steps so
 * the cleaned body is what gets captured and forwarded upstream. Gated on
 * config.experimentStripOmoReminder — user must explicitly opt in.
 */
export const StripOmoReminderStep: StampStep = {
  label: "strip-omo-reminder",
  applies(ctx) {
    return ctx.config.experimentStripOmoReminder && !ctx.isOpenAi;
  },
  apply(body, ctx) {
    if (body === null || typeof body !== "object") return false;
    const cleaned = stripOmoReminder(body as AnthropicBody);
    if (cleaned === body) return false;
    // Mutate the original body in place so the caller sees the cleaned
    // shape when it re-serializes. stripOmoReminder is pure (returns a new
    // object); we copy the changed fields back to keep the pipeline contract
    // consistent with the other in-place steps.
    const b = body as AnthropicBody;
    if (cleaned.messages !== b.messages) b.messages = cleaned.messages;
    log.info("stripped oh-my-openagent [Category+Skill Reminder] block", {
      method: ctx.method,
      path: ctx.url.pathname,
    });
    return true;
  },
};

// ─── Pipeline ─────────────────────────────────────────────────────────────

/** Ordered stamp steps applied to every request body before forwarding. */
export const STAMP_PIPELINE: StampStep[] = [
  RestampBreakpointsStep,
  CacheTtlStep,
  AnthropicBodyStep,
  PerModelRuleStep,
  ContextManagementStep,
  OpenAiReasoningStep,
  OpenAiStreamUsageStep,
  TopKStep,
  TemperatureStep,
  StripOmoReminderStep,
];
