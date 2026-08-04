// Unit tests: ModelsClient derives concurrency weight from /v1/models output pricing tiers.
//   output <  0.9 → 0.25 (cheapest)
//   output <  2.0 → 0.5  (cheap)
//   otherwise     → 1.0

import { expect, test } from "bun:test";
import { ModelsClient } from "../../src/models.js";

function startMockUpstream(
  models: Array<{ id: string; pricing: { input: number; output: number } }>,
): { server: ReturnType<typeof Bun.serve>; port: number } {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/models") {
        return Response.json({ data: models });
      }
      if (url.pathname === "/v1/models/info") {
        return Response.json({ data: [] });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, port: server.port ?? 0 };
}

test("getWeight uses three pricing tiers for output price", async () => {
  const upstream = startMockUpstream([
    { id: "umans-deepseek-v4-flash-0731", pricing: { input: 0.14, output: 0.28 } },
    { id: "umans-flash", pricing: { input: 0.15, output: 1 } },
    { id: "umans-coder", pricing: { input: 0.95, output: 4 } },
  ]);
  try {
    const client = new ModelsClient({
      target: `http://localhost:${upstream.port}`,
      refreshMs: 60000,
    });
    await client.refresh();
    expect(client.getWeight("umans-deepseek-v4-flash-0731")).toBe(0.25);
    expect(client.getWeight("umans-flash")).toBe(0.5);
    expect(client.getWeight("umans-coder")).toBe(1);
  } finally {
    upstream.server.stop(true);
  }
});