// Re-export shim for domain modules previously inlined here.
// The implementations now live under src/shared/.

export { HOP, headersToObject, redactHeaders } from "./shared/http-headers.js";
export { textDecoder, textEncoder, decodeText } from "./shared/text-codec.js";
export { summary, newSummary, buildSummary } from "./shared/capture-summary.js";
export { classify429 } from "./shared/classify-429.js";
export { computeRequestWeight } from "./shared/weight.js";
export type { WeightModelSource } from "./shared/weight.js";
