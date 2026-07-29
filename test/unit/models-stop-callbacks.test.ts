import { expect, test } from "bun:test";
import { ModelsClient } from "../../src/models.js";

function startMockUpstream(): { server: ReturnType<typeof Bun.serve>; port: number } {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
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
  return { server, port: server.port ?? 0 };
}

test("onChange callback does not fire after stop() on in-flight refresh", async () => {
  const upstream = startMockUpstream();
  try {
    const client = new ModelsClient({
      target: `http://localhost:${upstream.port}`,
      refreshMs: 60000,
    });
    let callCount = 0;
    client.onChange(() => {
      callCount++;
    });

    await client.refresh();
    expect(callCount).toBe(1);

    client.stop();

    await client.refresh();
    expect(callCount).toBe(1);
  } finally {
    upstream.server.stop(true);
  }
});
