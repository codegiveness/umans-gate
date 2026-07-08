// Image block detection + byte scan for LLM request bodies.
// Walks OpenAI image_url parts and Anthropic image blocks, plus a cheap
// regex fast-path that avoids full JSON deserialization when no image is present.

/** Detected image part, normalized across OpenAI and Anthropic shapes. */
export interface ImagePart {
  mediaType: string | null;
  encoding: "base64" | "url";
  data: string;
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

/** OpenAI content[] walker: collects every image_url part. */
export function findOpenAIImageParts(body: unknown): ImagePart[] {
  const out: ImagePart[] = [];
  if (typeof body !== "object" || body === null) return out;
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return out;
  for (const msg of messages) {
    if (typeof msg !== "object" || msg === null) continue;
    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part !== "object" || part === null) continue;
      if ((part as { type?: unknown }).type !== "image_url") continue;
      const imageUrl = (part as { image_url?: { url?: unknown } }).image_url;
      const url = typeof imageUrl?.url === "string" ? imageUrl.url : "";
      if (!url) continue;
      const m = /^data:([^;]+);base64,(.+)$/.exec(url);
      if (m) {
        out.push({ mediaType: m[1], encoding: "base64", data: m[2] });
      } else {
        out.push({ mediaType: inferExtFromUrl(url), encoding: "url", data: url });
      }
    }
  }
  return out;
}

/** Anthropic content[] walker: recurses into messages[].content[] and tool_result.content[]. */
export function findAnthropicImageParts(body: unknown): ImagePart[] {
  const out: ImagePart[] = [];
  if (typeof body !== "object" || body === null) return out;
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return out;

  const walk = (arr: unknown[]) => {
    for (const part of arr) {
      if (typeof part !== "object" || part === null) continue;
      const p = part as { type?: unknown; source?: unknown; content?: unknown };
      if (p.type === "image" && p.source && typeof p.source === "object") {
        const src = p.source as {
          type?: unknown;
          media_type?: unknown;
          data?: unknown;
          url?: unknown;
        };
        if (src.type === "base64") {
          out.push({
            mediaType: typeof src.media_type === "string" ? src.media_type : null,
            encoding: "base64",
            data: typeof src.data === "string" ? src.data : "",
          });
        } else if (src.type === "url") {
          const url = typeof src.url === "string" ? src.url : "";
          out.push({
            mediaType: inferExtFromUrl(url),
            encoding: "url",
            data: url,
          });
        }
      } else if (p.type === "tool_result" && Array.isArray(p.content)) {
        walk(p.content);
      }
    }
  };

  for (const msg of messages) {
    if (typeof msg !== "object" || msg === null) continue;
    const content = (msg as { content?: unknown }).content;
    if (Array.isArray(content)) walk(content);
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
