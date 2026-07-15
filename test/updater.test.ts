import { expect, test } from "bun:test";
import { computeSha256, parseSha256Sums } from "../src/updater.js";

test("parseSha256Sums returns the digest for a matching asset name", () => {
  const sums = [
    "abc123def4567890abcdef1234567890abcdef1234567890abcdef1234567890  umans-gate-linux-x64",
    "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210  umans-gate-darwin-arm64",
  ].join("\n");

  const digest = parseSha256Sums(sums, "umans-gate-darwin-arm64");
  expect(digest).toBe("fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210");
});

test("parseSha256Sums returns null when the asset name is absent", () => {
  const sums = [
    "abc123def4567890abcdef1234567890abcdef1234567890abcdef1234567890  umans-gate-linux-x64",
  ].join("\n");

  const digest = parseSha256Sums(sums, "umans-gate-darwin-arm64");
  expect(digest).toBeNull();
});

test("parseSha256Sums returns null for a malformed checksum file", () => {
  const malformed = "this is not a valid sha256sums line\nno hex here";
  const digest = parseSha256Sums(malformed, "umans-gate-linux-x64");
  expect(digest).toBeNull();
});

test("parseSha256Sums handles leading asterisk (binary mode) in filename", () => {
  const sums =
    "abc123def4567890abcdef1234567890abcdef1234567890abcdef1234567890 *umans-gate-linux-x64";
  const digest = parseSha256Sums(sums, "umans-gate-linux-x64");
  expect(digest).toBe("abc123def4567890abcdef1234567890abcdef1234567890abcdef1234567890");
});

test("computeSha256 produces the correct digest for a known input", () => {
  // SHA-256 of "hello" = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
  const data = new TextEncoder().encode("hello");
  expect(computeSha256(data)).toBe(
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  );
});

test("computeSha256 returns consistent digest for ArrayBuffer input", () => {
  const data = new TextEncoder().encode("hello").buffer;
  expect(computeSha256(data)).toBe(
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  );
});
