// Re-export shim for domain modules previously inlined here.
// The implementations now live under src/shared/.

export { buildSummary, newSummary, summary } from "./shared/capture-summary.js";
export { classify429 } from "./shared/classify-429.js";
export { HOP, headersToObject, redactHeaders } from "./shared/http-headers.js";
export { decodeText, textDecoder, textEncoder } from "./shared/text-codec.js";
export type { WeightModelSource } from "./shared/weight.js";
export { computeRequestWeight } from "./shared/weight.js";
