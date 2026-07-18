// Image block detection + byte scan for LLM request bodies.
// Walks OpenAI image_url parts and Anthropic image blocks, plus a cheap
// regex fast-path that avoids full JSON deserialization when no image is present.

/** Detected image part, normalized across OpenAI and Anthropic shapes. */
export interface ImagePart {
  mediaType: string | null;
  encoding: "base64" | "url";
  data: string;
  adjacentText?: string;
  isToolResult: boolean;
  positionInBatch: number;
  batchSize: number;
  originalSystemPrompt?: string;
}

/** Tristate capability: true = supports vision, false = does not, "via-handoff" = only via handoff. */
export type VisionTristate = true | false | "via-handoff";

/** Lookup interface for vision-capability queries. Implemented by ModelsClient + ModelInfoClient. */
export interface VisionLookup {
  getVisionSupport(modelName: string): VisionTristate | null;
}

/** Which API shape the body follows. */
export type ApiKind = "openai" | "anthropic";

/** Rewrite strategy from config. */
export type RewriteStrategy = "never" | "catalog" | "always";

const DEFAULT_MAX_CHARS = 1000;

/** Truncate to maxChars; return undefined when maxChars === 0 or input is empty. */
function truncateText(s: string, maxChars: number): string | undefined {
  if (maxChars === 0 || s === "") return undefined;
  return s.slice(0, maxChars);
}

/** Concatenate `text` fields from `{type:"text"}` parts in `arr`. */
function concatTextBlocks(arr: unknown[]): string {
  let out = "";
  for (const part of arr) {
    if (typeof part !== "object" || part === null) continue;
    const p = part as { type?: unknown; text?: unknown };
    if (p.type === "text" && typeof p.text === "string") {
      out += p.text;
    }
  }
  return out;
}

/** Extract a truncated system prompt from an OpenAI messages[] array. */
function extractOpenAISystemPrompt(messages: unknown, maxChars: number): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (const msg of messages) {
    if (typeof msg !== "object" || msg === null) continue;
    const m = msg as { role?: unknown; content?: unknown };
    if (m.role !== "system") continue;
    if (typeof m.content === "string") return truncateText(m.content, maxChars);
    if (Array.isArray(m.content)) return truncateText(concatTextBlocks(m.content), maxChars);
    return undefined;
  }
  return undefined;
}

/** Extract a truncated system prompt from an Anthropic body.system field. */
function extractAnthropicSystemPrompt(system: unknown, maxChars: number): string | undefined {
  if (typeof system === "string") return truncateText(system, maxChars);
  if (Array.isArray(system)) return truncateText(concatTextBlocks(system), maxChars);
  return undefined;
}

/** Count image blocks in an Anthropic content[], recursing into tool_result.content[]. */
function countAnthropicImages(arr: unknown[]): number {
  let count = 0;
  for (const part of arr) {
    if (typeof part !== "object" || part === null) continue;
    const p = part as { type?: unknown; content?: unknown };
    if (p.type === "image") {
      count++;
    } else if (p.type === "tool_result" && Array.isArray(p.content)) {
      count += countAnthropicImages(p.content);
    }
  }
  return count;
}

/**
 * Emit Anthropic image parts via depth-first tree-walk (matching
 * `replaceImageBlocks` cursor order). Top-level images get `adjacentText`
 * from sibling text blocks; tool_result-nested images get `isToolResult=true`
 * and no `adjacentText`.
 */
function emitAnthropicImages(
  arr: unknown[],
  adjacentText: string | undefined,
  batchSize: number,
  originalSystemPrompt: string | undefined,
  isToolResult: boolean,
  cursor: { position: number },
  out: ImagePart[],
): void {
  for (const part of arr) {
    if (typeof part !== "object" || part === null) continue;
    const p = part as { type?: unknown; source?: unknown; content?: unknown };
    if (p.type === "image" && p.source && typeof p.source === "object") {
      cursor.position++;
      const src = p.source as {
        type?: unknown;
        media_type?: unknown;
        data?: unknown;
        url?: unknown;
      };
      const meta = {
        adjacentText: isToolResult ? undefined : adjacentText,
        isToolResult,
        positionInBatch: cursor.position,
        batchSize,
        originalSystemPrompt,
      };
      if (src.type === "base64") {
        out.push({
          mediaType: typeof src.media_type === "string" ? src.media_type : null,
          encoding: "base64",
          data: typeof src.data === "string" ? src.data : "",
          ...meta,
        });
      } else if (src.type === "url") {
        const url = typeof src.url === "string" ? src.url : "";
        out.push({
          mediaType: inferExtFromUrl(url),
          encoding: "url",
          data: url,
          ...meta,
        });
      }
    } else if (p.type === "tool_result" && Array.isArray(p.content)) {
      emitAnthropicImages(
        p.content,
        adjacentText,
        batchSize,
        originalSystemPrompt,
        true,
        cursor,
        out,
      );
    }
  }
}

/**
 * OpenAI content[] walker: two-pass per message. Pass 1 counts `image_url`
 * blocks → `batchSize`. Pass 2 collects text blocks → `adjacentText` (capped
 * at `maxChars`), assigns 1-based `positionInBatch`. `isToolResult` is always
 * `false` (OpenAI has no tool_result nesting). `originalSystemPrompt` is
 * extracted from the first `messages[]` entry with `role === "system"`.
 */
export function findOpenAIImageParts(body: unknown, maxChars = DEFAULT_MAX_CHARS): ImagePart[] {
  const out: ImagePart[] = [];
  if (typeof body !== "object" || body === null) return out;
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return out;
  const originalSystemPrompt = extractOpenAISystemPrompt(messages, maxChars);

  for (const msg of messages) {
    if (typeof msg !== "object" || msg === null) continue;
    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;

    // Pass 1: count image_url blocks → batchSize.
    let batchSize = 0;
    for (const part of content) {
      if (typeof part !== "object" || part === null) continue;
      if ((part as { type?: unknown }).type === "image_url") batchSize++;
    }
    if (batchSize === 0) continue;

    // Pass 2: collect adjacentText and emit in array order.
    const adjacentText = truncateText(concatTextBlocks(content), maxChars);
    let positionInBatch = 0;
    for (const part of content) {
      if (typeof part !== "object" || part === null) continue;
      if ((part as { type?: unknown }).type !== "image_url") continue;
      const imageUrl = (part as { image_url?: { url?: unknown } }).image_url;
      const url = typeof imageUrl?.url === "string" ? imageUrl.url : "";
      if (!url) continue;
      positionInBatch++;
      const m = /^data:([^;]+);base64,(.+)$/.exec(url);
      if (m) {
        out.push({
          mediaType: m[1],
          encoding: "base64",
          data: m[2],
          adjacentText,
          isToolResult: false,
          positionInBatch,
          batchSize,
          originalSystemPrompt,
        });
      } else {
        out.push({
          mediaType: inferExtFromUrl(url),
          encoding: "url",
          data: url,
          adjacentText,
          isToolResult: false,
          positionInBatch,
          batchSize,
          originalSystemPrompt,
        });
      }
    }
  }
  return out;
}

/**
 * Anthropic content[] walker: two-pass per message. Pass 1 counts image
 * blocks (recursing into `tool_result.content[]`) → `batchSize`. Pass 2
 * performs a depth-first tree-walk matching `replaceImageBlocks` cursor
 * order, assigning 1-based `positionInBatch`. Top-level images get
 * `adjacentText` from sibling text blocks; `tool_result`-nested images get
 * `isToolResult = true` and no `adjacentText`. `originalSystemPrompt` is
 * extracted from `body.system`.
 */
export function findAnthropicImageParts(body: unknown, maxChars = DEFAULT_MAX_CHARS): ImagePart[] {
  const out: ImagePart[] = [];
  if (typeof body !== "object" || body === null) return out;
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return out;

  const originalSystemPrompt = extractAnthropicSystemPrompt(
    (body as { system?: unknown }).system,
    maxChars,
  );

  for (const msg of messages) {
    if (typeof msg !== "object" || msg === null) continue;
    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;

    // Pass 1: count image blocks including tool_result-nested → batchSize.
    const batchSize = countAnthropicImages(content);
    if (batchSize === 0) continue;

    // Pass 2: depth-first tree-walk, matching replaceImageBlocks cursor order.
    const adjacentText = truncateText(concatTextBlocks(content), maxChars);
    const cursor = { position: 0 };
    emitAnthropicImages(content, adjacentText, batchSize, originalSystemPrompt, false, cursor, out);
  }
  return out;
}

/**
 * Cheap signal: does the stringified body contain an image block?
 * Mirrors a memchr scan for `"type":"image_url"` or `"type":"image"` without
 * fully deserialising. The Rust equivalent would use `memchr::memmem::find`.
 */
export function cheapImageSignal(bodyStr: string): boolean {
  return (
    /"type"\s*:\s*"image_url"/.test(bodyStr) || /"type"\s*:\s*"image"\s*,\s*"source"/.test(bodyStr)
  );
}

/** Infer a media type from a URL's extension; null if unknown. */
export function inferExtFromUrl(url: string): string | null {
  const m = /\.(png|jpe?g|webp|gif|bmp|tiff?|heic|heif|svg)$/i.exec(url);
  if (!m) return null;
  const ext = m[1].toLowerCase();
  if (ext === "jpg") return "image/jpeg";
  if (ext === "tif" || ext === "tiff") return "image/tiff";
  return `image/${ext}`;
}

/**
 * Tristate capability resolution. Decides whether the proxy should rewrite
 * an image-bearing request into a vision handoff.
 *
 * - `never` → never rewrite
 * - `always` → always rewrite
 * - `catalog` → consult the model's vision capability:
 *   - supports_vision: false → rewrite (model can't see images)
 *   - supports_vision: "via-handoff" → rewrite OpenAI only (server handles Anthropic)
 *   - supports_vision: true → pass through, UNLESS forceInterceptCapable is set
 *   - unknown (null) → pass through (fail-safe: don't intercept if uncertain)
 */
export function shouldRewrite(
  strategy: RewriteStrategy,
  supports: VisionTristate | null,
  apiKind: ApiKind,
  forceInterceptCapable = false,
): boolean {
  if (strategy === "never") return false;
  if (strategy === "always") return true;
  // catalog
  if (supports === null) return false;
  if (supports === false) return true;
  if (supports === "via-handoff") return apiKind === "openai";
  // supports === true
  return forceInterceptCapable;
}
