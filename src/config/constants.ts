// Hardcoded constants — app is Umans-specific, not user-configurable.

/** Hardcoded constants — app is Umans-specific, not user-configurable. */
export const UPSTREAM_TARGET = "https://api.code.umans.ai";
export const OPENAI_CHAT_PATH = "chat/completions";
export const WARMER_PATH = "/v1/models";
/** Vision target derived from upstream target. */
export const VISION_TARGET_PATH = "/v1/chat/completions";
/** Stamp TTL value used when stamp_claude_code_enabled is true. */
export const STAMP_CACHE_TTL_VALUE = "1h";
/** Top-K value used when stamp_claude_code_enabled is true. */
export const STAMP_TOP_K_VALUE = 20;
/** Temperature value forced when stamp_claude_code_enabled is true. */
export const STAMP_TEMPERATURE_VALUE = 1.0;

/** anthropic-beta header injected on all Anthropic /v1/messages requests. */
export const STAMP_ANTHROPIC_BETA_HEADER =
  "claude-code-20250219,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advisor-tool-2026-03-01,effort-2025-11-24,extended-cache-ttl-2025-04-11";

/** context_management block injected when stamp_claude_code_enabled is true and anthropic-version is 2023-06-01. */
export const STAMP_CONTEXT_MANAGEMENT_VALUE = {
  edits: [{ type: "clear_thinking_20251015", keep: "all" }],
} as const;

export const STAMP_REASONING_EFFORT_VALUE = "high" as const;
