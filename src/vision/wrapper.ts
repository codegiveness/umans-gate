// Deterministic replacement-text wrapper + failure placeholders + format policies.
// Mirrors umans-dash's label format so upstream KV-cache prefixes remain stable.
// All output text is byte-identical for identical inputs — no dynamic metadata.

import type { ApiKind, ImagePart } from "./detect.js";

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

/** Prefix that every {@link failurePlaceholder} result starts with. */
const FAILURE_PLACEHOLDER_PREFIX = "[Image analysis failed:";

/**
 * Returns true when `description` is a failure placeholder produced by
 * {@link failurePlaceholder}. Such values must not be cached: they represent
 * transient vision errors that would poison the cache until TTL expiry.
 */
export function isFailurePlaceholder(description: string): boolean {
  return description.startsWith(FAILURE_PLACEHOLDER_PREFIX);
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

/**
 * Wrap a description with its `[Image N:\n...]` label when the batch contains
 * multiple images. For single-image batches (or when `positions` is absent),
 * the description is returned as-is — the description is already wrapped by
 * `wrapDescription` in `processImage`, so we must NOT double-wrap.
 */
function wrapWithPosition(
  descriptions: string[],
  descIdx: number,
  positions?: Array<{ positionInBatch: number; batchSize: number }>,
): string {
  const desc = descriptions[descIdx];
  const pos = positions?.[descIdx];
  if (pos && pos.batchSize > 1) {
    return `[Image ${pos.positionInBatch}:\n${desc}]`;
  }
  return desc;
}

function replaceInContentArray(
  content: unknown[],
  apiKind: ApiKind,
  descriptions: string[],
  overflow: string[],
  cursor: { descIdx: number; overflowIdx: number },
  positions?: Array<{ positionInBatch: number; batchSize: number }>,
): void {
  for (let i = 0; i < content.length; i++) {
    const part = content[i];
    if (typeof part !== "object" || part === null) continue;
    const p = part as { type?: unknown; content?: unknown };

    if (apiKind === "openai" && p.type === "image_url") {
      if (cursor.descIdx < descriptions.length) {
        content[i] = {
          type: "text",
          text: wrapWithPosition(descriptions, cursor.descIdx, positions),
        };
        cursor.descIdx++;
      }
    } else if (apiKind === "anthropic" && p.type === "image") {
      if (cursor.descIdx < descriptions.length) {
        content[i] = {
          type: "text",
          text: wrapWithPosition(descriptions, cursor.descIdx, positions),
          cache_control: { type: "ephemeral" },
        };
        cursor.descIdx++;
      }
    } else if (apiKind === "anthropic" && p.type === "tool_result" && Array.isArray(p.content)) {
      replaceInContentArray(p.content, apiKind, descriptions, overflow, cursor, positions);
    }
  }
}

/**
 * Replace image blocks in `body` (already cloned) with text blocks carrying
 * the wrapped descriptions. OpenAI image_url parts and Anthropic image blocks
 * are both replaced in-place; overflow placeholders are appended after the
 * last replaced block of the relevant message so the model still sees them
 * in conversation order.
 */
export function replaceImageBlocks(
  body: unknown,
  apiKind: ApiKind,
  descriptions: string[],
  overflow: string[],
  positions?: Array<{ positionInBatch: number; batchSize: number }>,
): void {
  if (typeof body !== "object" || body === null) return;
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return;

  const cursor = { descIdx: 0, overflowIdx: 0 };
  const overflowText = overflow.length > 0 ? overflow.join("\n") : "";

  for (const msg of messages) {
    if (typeof msg !== "object" || msg === null) continue;
    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    replaceInContentArray(content, apiKind, descriptions, overflow, cursor, positions);

    if (
      overflowText &&
      cursor.descIdx >= descriptions.length &&
      cursor.overflowIdx < overflow.length
    ) {
      content.push({ type: "text", text: overflowText });
      cursor.overflowIdx = overflow.length;
    }
  }
}
