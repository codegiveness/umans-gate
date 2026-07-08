// Regression test for proxy Accept-Encoding handling.
//
// The proxy strips the upstream Content-Encoding response header (because it
// forwards decoded bodies), so it must not advertise compression to upstream.
// Otherwise an upstream may send a compressed body that the client receives
// without a Content-Encoding header.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startProxy } from "./helpers/proxy";

describe("proxy accept-encoding handling", () => {
  let proxy: Awaited<ReturnType<typeof startProxy>>;
  let upstream: ReturnType<typeof Bun.serve>;

  beforeAll(async () => {
    upstream = Bun.serve({
      port: 0,
      async fetch(req) {
        const received: Record<string, string> = {};
        req.headers.forEach((value, key) => {
          received[key] = value;
        });
        return Response.json({ received });
      },
    });

    proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
    });
  });

  afterAll(async () => {
    await proxy.kill();
    upstream.stop();
  });

  function acceptEncoding(headers: Record<string, string>): string | undefined {
    return headers["accept-encoding"] ?? headers["Accept-Encoding"];
  }

  test("forces upstream Accept-Encoding to identity when client omits it", async () => {
    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test-model", messages: [] }),
    });

    expect(res.ok).toBe(true);
    const json = (await res.json()) as { received: Record<string, string> };
    expect(acceptEncoding(json.received)).toBe("identity");
  });

  test("overrides client compression preference upstream to prevent compressed responses", async () => {
    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept-encoding": "gzip, deflate",
      },
      body: JSON.stringify({ model: "test-model", messages: [] }),
    });

    expect(res.ok).toBe(true);
    const json = (await res.json()) as { received: Record<string, string> };
    expect(acceptEncoding(json.received)).toBe("identity");
  });

  test("overrides brotli preference upstream to prevent compressed responses", async () => {
    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept-encoding": "br",
      },
      body: JSON.stringify({ model: "test-model", messages: [] }),
    });

    expect(res.ok).toBe(true);
    const json = (await res.json()) as { received: Record<string, string> };
    expect(acceptEncoding(json.received)).toBe("identity");
  });
});
