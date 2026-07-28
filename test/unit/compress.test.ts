import { expect, test } from "bun:test";
import { COMPRESSION_THRESHOLD, compressText, decompressText } from "../../src/compress.js";

const large = "x".repeat(COMPRESSION_THRESHOLD + 1);
const small = "hello";
const unicode = `Hello, 世界! 👋🌏 émoji 日本語 ${"x".repeat(COMPRESSION_THRESHOLD)}`;

test("round-trips a large UTF-8 payload", () => {
  const compressed = compressText(large, true);
  expect(compressed).toBeInstanceOf(Uint8Array);

  const decompressed = decompressText(compressed);
  expect(decompressed).toBe(large);
});

test("returns plain string for payloads below threshold", () => {
  const result = compressText(small, true);
  expect(typeof result).toBe("string");
  expect(result).toBe(small);
});

test("passes through when disabled", () => {
  const result = compressText(large, false);
  expect(typeof result).toBe("string");
  expect(result).toBe(large);
});

test("handles null", () => {
  expect(compressText(null, true)).toBeNull();
  expect(decompressText(null)).toBeNull();
});

test("round-trips unicode including emoji and CJK", () => {
  const compressed = compressText(unicode, true);
  expect(compressed).toBeInstanceOf(Uint8Array);

  const decompressed = decompressText(compressed);
  expect(decompressed).toBe(unicode);
});

test("returns null for corrupted BLOB", () => {
  const corrupted = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0xff, 0xff, 0xff]);
  expect(decompressText(corrupted)).toBeNull();
});
