// SEC-01: The LLM API key must NOT be forwarded to upstream `/v1/models`
// or `/v1/models/info`. Those endpoints are public catalogs queried
// without authentication.
//
// BEFORE: ModelsClient built an `Authorization: Bearer <apiKey>` header
// for /v1/models and passed apiKey to fetchModelsInfo for /v1/models/info.
//
// AFTER: Neither endpoint receives an Authorization header.
//
// This test starts the full proxy (startProxy) with UMANS_API_KEY set,
// pointing TARGET at a mock upstream that records all received requests.
// ModelsClient polls /v1/models periodically, so after a short wait we
// inspect the captured requests.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { type ProxyHandle, startProxy } from "../helpers/proxy.js";

interface CapturedRequest {
  path: string;
  headers: Record<string, string>;
}

/** Mock upstream that records path + headers for every request. */
function startMockUpstream(port = 0): {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headers[k] = v;
      });
      requests.push({ path: url.pathname, headers });

      if (url.pathname === "/v1/models") {
        return Response.json({
          data: [{ id: "test-model", context_length: 8192, pricing: { input: 1, output: 1 } }],
        });
      }
      if (url.pathname === "/v1/models/info") {
        return Response.json({ data: [] });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, port: server.port ?? 0, requests };
}

let mock: ReturnType<typeof startMockUpstream>;
let proxy: ProxyHandle;

beforeAll(async () => {
  mock = startMockUpstream();
  proxy = await startProxy({
    TARGET: `http://127.0.0.1:${mock.port}`,
    umansApiKey: "sk-test-secret-do-not-forward",
    MODELS_REFRESH_MS: "500",
    WARMER_ENABLED: "false",
    USAGE_REFRESH_MS: "999999",
    STAMP_CLAUDE_CODE_ENABLED: "false",
    STAMP_REASONING_EFFORT_ENABLED: "false",
  });
});

afterAll(async () => {
  await proxy.kill();
  mock.server.stop();
});

/** Wait until at least one /v1/models request has been captured. */
async function waitForModelsRequest(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (mock.requests.some((r) => r.path === "/v1/models")) return;
    await Bun.sleep(100);
  }
  throw new Error(
    `No /v1/models request received within ${timeoutMs}ms. Captured: ${JSON.stringify(mock.requests.map((r) => r.path))}`,
  );
}

test("no Authorization header sent to /v1/models", async () => {
  await waitForModelsRequest();
  const modelsReqs = mock.requests.filter((r) => r.path === "/v1/models");
  expect(modelsReqs.length).toBeGreaterThan(0);
  for (const req of modelsReqs) {
    expect(req.headers.authorization).toBeUndefined();
  }
});

test("no Authorization header sent to /v1/models/info", async () => {
  // /v1/models/info is fetched in parallel with /v1/models during refresh.
  await waitForModelsRequest();
  const infoReqs = mock.requests.filter((r) => r.path === "/v1/models/info");
  expect(infoReqs.length).toBeGreaterThan(0);
  for (const req of infoReqs) {
    expect(req.headers.authorization).toBeUndefined();
  }
});
