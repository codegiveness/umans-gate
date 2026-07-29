// Barrel re-export of all config sub-modules.
// External importers continue to use `./config.js` — no import path changes needed.

export {
  OPENAI_CHAT_PATH,
  STAMP_ANTHROPIC_BETA_HEADER,
  STAMP_CACHE_TTL_VALUE,
  STAMP_CONTEXT_MANAGEMENT_VALUE,
  STAMP_REASONING_EFFORT_VALUE,
  STAMP_TEMPERATURE_VALUE,
  STAMP_TOP_K_VALUE,
  UPSTREAM_TARGET,
  VISION_TARGET_PATH,
  WARMER_PATH,
} from "./config/constants.js";
export { DEFAULT_CONFIG } from "./config/defaults.js";
export {
  bool,
  envOrRawBool,
  envOrRawNum,
  loadJsonConfig,
  num,
  resolveUpstreamProtocol,
  str,
} from "./config/env.js";
export {
  ensureConfigFile,
  readConfigFile,
  resetConfig,
  saveConfig,
  saveConfigLocked,
} from "./config/file.js";
export { loadConfig } from "./config/loader.js";
export { resolveConfigDir, resolveConfigPath } from "./config/paths.js";
export { applyReloadToConfig } from "./config/reload.js";
export type { RawConfig, RawConfigInput } from "./config/types.js";
export {
  coerceRawForValidation,
  FIELD_RULES,
  type FieldRule,
  INT_FIELDS,
  isRawConfigInput,
  type ReloadResult,
  type ValidationContext,
  type ValidationResult,
  validateConfig,
  WARNING_RULES,
  type WarningRule,
} from "./config/validation.js";
