import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  computeSha256,
  downloadAndReplaceStandaloneBinary,
  parseSha256Sums,
} from "../src/updater.js";

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

const PLATFORM_ASSET = "umans-gate-linux-x64";

function makeRelease(binaryDigest: string, sumsDigest: string) {
  return {
    tag_name: "v2.0.0",
    assets: [
      {
        name: PLATFORM_ASSET,
        browser_download_url: `https://example.com/${PLATFORM_ASSET}`,
        size: 4,
      },
      {
        name: "SHA256SUMS",
        browser_download_url: "https://example.com/SHA256SUMS",
        size: sumsDigest.length + PLATFORM_ASSET.length + 2,
      },
    ],
  };
}

describe("downloadAndReplaceStandaloneBinary checksum verification", () => {
  let originalFetch: typeof fetch;
  let originalExecPath: string;
  let originalExit: typeof process.exit;
  let exitCode: number | null = null;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalExecPath = process.execPath;
    originalExit = process.exit;
    exitCode = null;
    process.execPath = "/tmp/umans-gate-test-binary";
    process.exit = ((code?: number | string | null | undefined) => {
      exitCode = typeof code === "number" ? code : 0;
      throw new Error(`process.exit(${exitCode})`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.execPath = originalExecPath;
    process.exit = originalExit;
  });

  function mockFetch(binaryDigest: string, sumsDigest: string) {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("api.github.com")) {
        return Response.json(makeRelease(binaryDigest, sumsDigest));
      }
      if (url.endsWith("/SHA256SUMS")) {
        const body = `${sumsDigest}  ${PLATFORM_ASSET}\n`;
        return new Response(body, { status: 200 });
      }
      if (url.endsWith(`/${PLATFORM_ASSET}`)) {
        return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
  }

  test("aborts when binary checksum does not match SHA256SUMS", async () => {
    const binaryDigest = computeSha256(new TextEncoder().encode("mismatch"));
    const actualDigest = computeSha256(new Uint8Array([1, 2, 3, 4]));
    expect(binaryDigest).not.toBe(actualDigest);

    mockFetch(binaryDigest, binaryDigest);
    await expect(downloadAndReplaceStandaloneBinary("2.0.0")).rejects.toThrow("process.exit(1)");
    expect(exitCode).toBe(1);
  });

  test("proceeds when binary checksum matches SHA256SUMS", async () => {
    const actualDigest = computeSha256(new Uint8Array([1, 2, 3, 4]));
    mockFetch(actualDigest, actualDigest);
    await expect(downloadAndReplaceStandaloneBinary("2.0.0")).resolves.toBeUndefined();
    expect(exitCode).toBeNull();
  });
});
