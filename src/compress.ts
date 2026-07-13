export const COMPRESSION_THRESHOLD = 256;

export function compressText(value: string | null, enabled: boolean): string | Uint8Array | null {
  if (value === null) {
    return null;
  }
  if (!enabled) {
    return value;
  }
  // Fast-path: if char count >= threshold, byte count is guaranteed >= threshold
  // (UTF-8 uses 1-4 bytes per char, so byte count >= char count). Skip the scan.
  if (value.length >= COMPRESSION_THRESHOLD) {
    return Bun.zstdCompressSync(Buffer.from(value, "utf-8"), { level: 3 });
  }
  // Short strings: check byte count for multi-byte content (CJK, emoji).
  if (Buffer.byteLength(value, "utf-8") < COMPRESSION_THRESHOLD) {
    return value;
  }
  return Bun.zstdCompressSync(Buffer.from(value, "utf-8"), { level: 3 });
}

export function decompressText(value: string | Uint8Array | null): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Uint8Array) {
    try {
      return Bun.zstdDecompressSync(value).toString("utf-8");
    } catch {
      return null;
    }
  }
  return null;
}
