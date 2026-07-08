// Text encoder/decoder utilities.

const textDecoder = new TextDecoder("utf-8", { fatal: true });
const textEncoder = new TextEncoder();

/** Decode bytes to text, falling back to base64 prefix for invalid UTF-8. */
export function decodeText(buf: Uint8Array): string {
  try {
    return textDecoder.decode(buf);
  } catch {
    return `__B64__${Buffer.from(buf).toString("base64")}`;
  }
}

export { textDecoder, textEncoder };
