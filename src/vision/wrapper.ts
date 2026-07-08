// Deterministic replacement-text wrapper + failure placeholders + format policies.
// Mirrors umans-dash's label format so upstream KV-cache prefixes remain stable.
// All output text is byte-identical for identical inputs — no dynamic metadata.

import type { ImagePart } from "./detect.js";

/** Reason a vision analysis failed. Constrained to safe, non-leaky tokens. */
export type FailureReason = "timeout" | "http_status" | "parse" | "empty" | "generic" | "aborted";

/** What to do with a given image format. */
export type FormatPolicy = "pass" | "transcode" | "reject";

/**
 * Deterministic wrapper. Mirrors umans-dash's label format.
 *
 * The label is byte-identical for identical `desc` inputs — it never includes
 * timestamps, request IDs, image position, or any runtime metadata. The
 * active-model caveat is fixed text so upstream KV-cache prefixes stay stable.
 */
export function wrapDescription(desc: string): string {
  return `[Image content — analyzed by vision module, shown as text because the active model cannot see images:]\n${desc}`;
}

/**
 * Failure placeholder. Always starts with `[Image analysis failed:` and ends
 * with a fixed model-caveat suffix. `detail` is interpolated only for the
 * safe-reason tokens (`timeout`, `http_status`, `generic`) — it must be a
 * sanitized scalar, never an upstream body or stack frame.
 */
export function failurePlaceholder(reason: FailureReason, detail: string): string {
  const reasonText: Record<FailureReason, string> = {
    timeout: `vision model timed out after ${detail}`,
    http_status: `vision model returned HTTP ${detail}`,
    parse: "vision model returned an unparseable response",
    empty: "vision model returned an empty description",
    generic: detail,
    aborted: "client disconnected before vision model responded",
  };
  return `[Image analysis failed: ${reasonText[reason]}. The active model cannot see this image.]`;
}

/**
 * Format policy: pass-through natively supported formats, transcode
 * bitmaps/heic/svg, reject anything else. Extension is lower-cased; mediaType
 * is accepted but the extension wins (mirrors PoC at L668-675).
 */
export function formatPolicy(ext: string, _mediaType: string): FormatPolicy {
  const supported = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
  const transcodable = new Set(["bmp", "tiff", "tif", "heic", "heif", "svg"]);
  const e = ext.toLowerCase();
  if (supported.has(e)) return "pass";
  if (transcodable.has(e)) return "transcode";
  return "reject";
}

/**
 * Apply the max-images overflow policy.
 *
 * Image parts beyond `maxImages` are dropped from the `kept` set and each is
 * replaced with a deterministic placeholder in `overflow`. The placeholder
 * tells the model not to describe or reference the omitted image, preventing
 * hallucination about content the model never received.
 */
export function applyMaxImagesPolicy(
  parts: ImagePart[],
  maxImages: number,
): { kept: ImagePart[]; overflow: string[] } {
  const kept = parts.slice(0, maxImages);
  const overflow = parts
    .slice(maxImages)
    .map(
      (_, i) =>
        `[Image omitted: not delivered to model — do not describe or reference it. (overflow ${i + 1})]`,
    );
  return { kept, overflow };
}
