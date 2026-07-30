import { describe, expect, test } from "bun:test";
import { HOP, headersToObject, redactHeaders } from "../../src/shared/http-headers.js";

describe("redactHeaders", () => {
  test("redacts authorization header", () => {
    const result = redactHeaders({ authorization: "Bearer sk-123" });
    expect(result.authorization).toBe("[REDACTED]");
  });

  test("redacts x-api-key header", () => {
    const result = redactHeaders({ "x-api-key": "abc123" });
    expect(result["x-api-key"]).toBe("[REDACTED]");
  });

  test("redacts api-key header", () => {
    const result = redactHeaders({ "api-key": "abc123" });
    expect(result["api-key"]).toBe("[REDACTED]");
  });

  test("preserves non-sensitive headers", () => {
    const result = redactHeaders({
      "content-type": "application/json",
      "x-request-id": "req-123",
      "x-ratelimit-remaining": "100",
    });
    expect(result["content-type"]).toBe("application/json");
    expect(result["x-request-id"]).toBe("req-123");
    expect(result["x-ratelimit-remaining"]).toBe("100");
  });

  test("redaction is case-insensitive", () => {
    const result = redactHeaders({
      Authorization: "Bearer sk-123",
      "X-API-KEY": "abc123",
      "API-Key": "xyz",
    });
    expect(result.Authorization).toBe("[REDACTED]");
    expect(result["X-API-KEY"]).toBe("[REDACTED]");
    expect(result["API-Key"]).toBe("[REDACTED]");
  });

  test("does not mutate input object", () => {
    const input = { authorization: "Bearer sk-123", "content-type": "text/plain" };
    const result = redactHeaders(input);
    expect(input.authorization).toBe("Bearer sk-123");
    expect(result.authorization).toBe("[REDACTED]");
    expect(result["content-type"]).toBe("text/plain");
  });

  test("handles empty object", () => {
    const result = redactHeaders({});
    expect(result).toEqual({});
  });

  test("handles multiple sensitive headers in one call", () => {
    const result = redactHeaders({
      authorization: "Bearer tok",
      "x-api-key": "key1",
      "api-key": "key2",
      "set-cookie": "session=abc",
      "content-type": "application/json",
    });
    expect(result.authorization).toBe("[REDACTED]");
    expect(result["x-api-key"]).toBe("[REDACTED]");
    expect(result["api-key"]).toBe("[REDACTED]");
    expect(result["set-cookie"]).toBe("session=abc");
    expect(result["content-type"]).toBe("application/json");
  });
});

describe("headersToObject", () => {
  test("converts Headers to plain object with lowercase keys", () => {
    const h = new Headers();
    h.set("Content-Type", "application/json");
    h.set("X-Request-ID", "req-123");
    const result = headersToObject(h);
    expect(result["content-type"]).toBe("application/json");
    expect(result["x-request-id"]).toBe("req-123");
  });

  test("joins duplicate headers with comma", () => {
    const h = new Headers();
    h.append("Set-Cookie", "a=1");
    h.append("Set-Cookie", "b=2");
    const result = headersToObject(h);
    expect(result["set-cookie"]).toBe("a=1, b=2");
  });
});

describe("HOP set", () => {
  test("includes standard hop-by-hop headers", () => {
    expect(HOP.has("connection")).toBe(true);
    expect(HOP.has("keep-alive")).toBe(true);
    expect(HOP.has("transfer-encoding")).toBe(true);
    expect(HOP.has("upgrade")).toBe(true);
    expect(HOP.has("proxy-authenticate")).toBe(true);
    expect(HOP.has("proxy-authorization")).toBe(true);
    expect(HOP.has("te")).toBe(true);
    expect(HOP.has("trailers")).toBe(true);
  });

  test("includes content-length and host", () => {
    expect(HOP.has("content-length")).toBe(true);
    expect(HOP.has("host")).toBe(true);
  });

  test("does not include non-hop headers", () => {
    expect(HOP.has("authorization")).toBe(false);
    expect(HOP.has("content-type")).toBe(false);
    expect(HOP.has("x-api-key")).toBe(false);
  });
});
