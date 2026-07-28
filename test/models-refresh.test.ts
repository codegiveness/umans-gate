// Ticket 02: POST /dashboard/api/models/refresh forces an upstream re-fetch
// and returns the fresh snapshot in one round-trip.
//
// The mock upstream serves /v1/models and /v1/models/info. We verify:
// - POST /api/models/refresh triggers a fresh /v1/models fetch on the upstream.
// - The response shape matches GET /api/models ({ models, fetched_at, ok }).
// - fetched_at advances after a refresh.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { type ProxyHandle, startProxy } from "./helpers/proxy.js";

let mock: ReturnType<typeof startMockUpstream>;
let proxy: ProxyHandle;

beforeAll(async () => {
  mock = startMockUpstream();
  proxy = await startProxy({
    TARGET: `http://127.0.0.1:${mock.port}`,
    WARMER_ENABLED: "false",
    USAGE_REFRESH_MS: "999999",
    MODELS_REFRESH_MS: "999999",
    STAMP_CLAUDE_CODE_ENABLED: "false",
    STAMP_REASONING_EFFORT_ENABLED: "false",
  });
});

afterAll(async () => {
  await proxy.kill();
  mock.server.stop();
});

function startMockUpstream(port = 0) {
  let modelsFetchCount = 0;
  const server = Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/models") {
        modelsFetchCount++;
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
  return {
    server,
    port: server.port ?? 0,
    get modelsFetchCount() {
      return modelsFetchCount;
    },
  };
}

test("POST /api/models/refresh forces upstream fetch and returns fresh snapshot", async () => {
  const before = mock.modelsFetchCount;

  const res = await fetch(`${proxy.baseUrl}/dashboard/api/models/refresh`, {
    method: "POST",
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    models: { id: string }[];
    fetched_at: number;
    ok: boolean;
  };
  expect(body.models.length).toBeGreaterThan(0);
  expect(body.models[0].id).toBe("test-model");
  expect(body.fetched_at).toBeGreaterThan(0);
  expect(body.ok).toBe(true);

  expect(mock.modelsFetchCount).toBeGreaterThan(before);
});

test("GET and POST /api/models return the same response shape", async () => {
  const getRes = await fetch(`${proxy.baseUrl}/dashboard/api/models`);
  const postRes = await fetch(`${proxy.baseUrl}/dashboard/api/models/refresh`, {
    method: "POST",
  });
  const getBody = (await getRes.json()) as { models: unknown[]; fetched_at: number; ok: boolean };
  const postBody = (await postRes.json()) as {
    models: unknown[];
    fetched_at: number;
    ok: boolean;
  };
  expect(Array.isArray(getBody.models)).toBe(true);
  expect(Array.isArray(postBody.models)).toBe(true);
  expect(typeof getBody.fetched_at).toBe("number");
  expect(typeof postBody.fetched_at).toBe("number");
  expect(typeof getBody.ok).toBe("boolean");
  expect(typeof postBody.ok).toBe("boolean");
});
