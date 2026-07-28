// E2E test: large request body is stored compressed (BLOB) in SQLite
// and served as a valid JSON string via the dashboard REST API.
//
// This test is RED until compression is integrated in src/db.ts:
//   - db.ts should call compressText() on request_body/response_body before INSERT
//   - viewer.ts should call decompressText() when serving GET /dashboard/api/captures/:id
//   - SQLite typeof(request_body) should be 'blob' for large payloads

import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { type ProxyHandle, startProxy } from "../helpers/proxy";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("compression E2E", () => {
  let upstream: ReturnType<typeof Bun.serve>;
  let proxy: ProxyHandle;

  beforeAll(async () => {
    upstream = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.json().catch(() => ({}));
        return Response.json({
          id: "msg_mock",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Hello from mock upstream" }],
          model: body?.model ?? "umans-glm-5.2",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        });
      },
    });

    proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      VISION_STRATEGY: "never",
      USAGE_REFRESH_MS: "100",
      UMANS_API_KEY: "",
    });
  });

  afterEach(async () => {
    await fetch(`${proxy.baseUrl}/dashboard/api/clear`, { method: "POST" });
    await sleep(100);
  });

  afterAll(async () => {
    await proxy.kill();
    upstream.stop();
  });

  test("large request_body is stored as BLOB and served as valid JSON string", async () => {
    // Build a request body whose content string exceeds 512 bytes.
    const largeContent = "x".repeat(600);
    const requestBody = {
      model: "umans-glm-5.2",
      max_tokens: 50,
      messages: [{ role: "user", content: largeContent }],
    };

    // Send through the proxy.
    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "test-key",
      },
      body: JSON.stringify(requestBody),
    });
    expect(res.status).toBe(200);

    // Wait for the write-behind queue to flush.
    await sleep(300);

    // List captures to find the one for /v1/messages.
    const listRes = await fetch(`${proxy.baseUrl}/dashboard/api/captures?limit=50`);
    expect(listRes.ok).toBe(true);
    const captures = (await listRes.json()) as Array<{ id: number; path: string }>;
    const cap = captures.find((c) => c.path === "/v1/messages");
    expect(cap).toBeDefined();

    // GET the detail — request_body must be a valid JSON string.
    const detailRes = await fetch(`${proxy.baseUrl}/dashboard/api/captures/${cap!.id}`);
    expect(detailRes.ok).toBe(true);
    const detail = (await detailRes.json()) as { request_body: unknown };
    expect(typeof detail.request_body).toBe("string");

    // JSON.parse must succeed — if stored as Uint8Array/BLOB without decompression,
    // JSON.stringify would produce a garbled object, not a parseable JSON string.
    const parsed = JSON.parse(detail.request_body as string);
    expect(parsed.messages[0].content).toBe(largeContent);

    // Verify directly in SQLite that request_body is stored as a BLOB.
    const db = new Database(proxy.dbPath, { readonly: true });
    try {
      const row = db
        .prepare("SELECT typeof(request_body) AS t FROM captures WHERE id = ?")
        .get(cap!.id) as { t: string } | null;
      expect(row).not.toBeNull();
      expect(row!.t).toBe("blob");
    } finally {
      db.close();
    }
  });
});
