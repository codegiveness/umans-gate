// Re-export from the canonical src/ implementation.
// The extraction logic now lives in src/usage-extract.ts; this file exists
// only so existing test imports (test/helpers/usage-extractors.ts) keep working.
export * from "../../src/usage-extract.js";
