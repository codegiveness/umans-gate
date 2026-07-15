// Barrel re-export of all config sub-modules.
// External importers continue to use `./config.js` — no import path changes needed.

export { resolveConfigDir, resolveConfigPath } from "./config/paths.js";
export type { RawConfig, RawConfigInput } from "./config/types.js";
export {
  UPSTREAM_TARGET,
  OPENAI_CHAT_PATH,
  WARMER_PATH,
  VISION_TARGET_PATH,
  STAMP_CACHE_TTL_VALUE,
  STAMP_TOP_K_VALUE,
  STAMP_TEMPERATURE_VALUE,
  STAMP_THINKING_VALUE,
  STAMP_MAX_TOKENS_GLM_VALUE,
  STAMP_MAX_TOKENS_VALUE,
  STAMP_OUTPUT_CONFIG_VALUE,
  STAMP_OUTPUT_CONFIG_GLM_VALUE,
  STAMP_ANTHROPIC_BETA_HEADER,
  STAMP_CONTEXT_MANAGEMENT_VALUE,
  STAMP_REASONING_EFFORT_VALUE,
  STAMP_REASONING_EFFORT_GLM_VALUE,
} from "./config/constants.js";
export { DEFAULT_CONFIG } from "./config/defaults.js";
export {
  type ValidationResult,
  type ReloadResult,
  type FieldRule,
  type WarningRule,
  INT_FIELDS,
  coerceRawForValidation,
  FIELD_RULES,
  WARNING_RULES,
  validateConfig,
} from "./config/validation.js";
export {
  resolveUpstreamProtocol,
  num,
  str,
  bool,
  envOrRawNum,
  envOrRawBool,
  loadJsonConfig,
} from "./config/env.js";
export { loadConfig } from "./config/loader.js";
export { readConfigFile, saveConfig, resetConfig, ensureConfigFile } from "./config/file.js";
export { applyReloadToConfig } from "./config/reload.js";
