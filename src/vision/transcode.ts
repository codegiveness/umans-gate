// Image transcode: decode → resize → JPEG re-encode via Bun.Image.
// Returns bytes + SHA-256 hash + output dimensions for cache keying.

/** Options for {@link transcodeImage}. */
export interface TranscodeOptions {
  /** Longest side after resize; aspect ratio is preserved (fit: "inside"). */
  maxDimension: number;
  /** JPEG quality 1–100 (used only when format is "jpeg"). */
  quality: number;
  /** Output format: "jpeg" (lossy) or "png" (lossless). Default "jpeg". */
  format?: "jpeg" | "png";
}

/** Result of a successful transcode. */
export interface TranscodeResult {
  bytes: Uint8Array;
  /** SHA-256 hex of the encoded JPEG bytes (not the source). */
  hash: string;
  width: number;
  height: number;
  format: string;
}

/** Error codes callers can branch on for fail-open behaviour. */
export type TranscodeErrorCode = "unsupported" | "decode_failed" | "encode_failed" | "too_large";

/**
 * Typed error thrown by {@link transcodeImage}. Callers should catch this
 * and treat the image as un-transcodable (fail-open) rather than crashing.
 */
export class TranscodeError extends Error {
  readonly code: TranscodeErrorCode;
  constructor(
    code: TranscodeErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "TranscodeError";
    this.code = code;
  }
}

/**
 * Map a `Bun.Image` rejection's `error.code` to a {@link TranscodeErrorCode}.
 * Returns `null` for codes we don't classify (caller rethrows).
 */
function classifyBunImageError(err: unknown): TranscodeErrorCode | null {
  if (typeof err !== "object" || err === null) return null;
  const code = (err as { code?: unknown }).code;
  switch (code) {
    case "ERR_IMAGE_FORMAT_UNSUPPORTED":
    case "ERR_IMAGE_UNKNOWN_FORMAT":
      return "unsupported";
    case "ERR_IMAGE_DECODE_FAILED":
      return "decode_failed";
    case "ERR_IMAGE_ENCODE_FAILED":
      return "encode_failed";
    case "ERR_IMAGE_TOO_MANY_PIXELS":
      return "too_large";
    default:
      return null;
  }
}

/**
 * Decode image bytes, resize to fit within `maxDimension` (preserving aspect
 * ratio), and re-encode as progressive JPEG quality `quality`. Returns the
 * encoded bytes, their SHA-256 hash, and the output dimensions.
 *
 * Errors from `Bun.Image` terminals are converted to {@link TranscodeError}
 * so the caller can fail-open without a `try/catch` wrapping every call.
 */
export async function transcodeImage(
  imageBytes: Uint8Array,
  opts: TranscodeOptions = { maxDimension: 1024, quality: 85 },
): Promise<TranscodeResult> {
  const img = new Bun.Image(imageBytes, { maxPixels: 50_000_000 });
  try {
    await img.metadata();
  } catch (err) {
    const code = classifyBunImageError(err);
    if (code) {
      throw new TranscodeError(code, `image decode failed: ${code}`, err);
    }
    throw err;
  }

  img.resize(opts.maxDimension, opts.maxDimension, { fit: "inside", filter: "lanczos3" });

  const format = opts.format ?? "jpeg";
  let encoded: Uint8Array;
  try {
    if (format === "png") {
      encoded = await img.png().bytes();
    } else {
      encoded = await img.jpeg({ quality: opts.quality, progressive: true }).bytes();
    }
  } catch (err) {
    const code = classifyBunImageError(err);
    if (code) {
      throw new TranscodeError(code, `image encode failed: ${code}`, err);
    }
    throw err;
  }

  const hash = new Bun.CryptoHasher("sha256").update(encoded).digest("hex");
  return { bytes: encoded, hash, width: img.width, height: img.height, format };
}
