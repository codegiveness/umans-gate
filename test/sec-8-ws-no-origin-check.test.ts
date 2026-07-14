// Regression test for SEC-8: WebSocket upgrade rejects cross-origin connections.
//
// BEFORE: No Origin check on WebSocket upgrade. A malicious website could
// open a WS to ws://localhost:port/dashboard/ws and receive all live capture
// broadcasts (LLM prompts/responses) in real time.
//
// AFTER: The request dispatcher checks the Origin header on WS upgrades.
// Foreign origins receive 403.
//
// CWE-346 (Origin Validation Error).

import { afterAll, beforeAll, expect, test } from "bun:test";
import { startCombinedMock } from "./helpers/combined-mock.ts";
import { type ProxyHandle, startProxy } from "./helpers/proxy.js";

let proxy: ProxyHandle;
let mock: ReturnType<typeof startCombinedMock>;

beforeAll(async () => {
  mock = startCombinedMock({ limit: 1, hardCap: 1, delayMs: 10 });
  const mockUrl = `http://127.0.0.1:${mock.port}`;
  proxy = await startProxy({
    TARGET: mockUrl,
    umansApiKey: "sk-sec8-ws-origin",
    WARMER_ENABLED: "false",
    USAGE_REFRESH_MS: "999999",
  });
});

afterAll(async () => {
  await proxy.kill();
  mock.close();
});

test("SEC-8a: WebSocket upgrade with foreign Origin returns 403", async () => {
  // Send a raw HTTP upgrade request with a foreign Origin.
  // Bun's fetch doesn't support WS upgrades directly, so we use a raw
  // TCP connection to send the upgrade headers.
  const { connect } = await import("node:net");

  const result = await new Promise<string>((resolve) => {
    const socket = connect(proxy.port, "127.0.0.1", () => {
      const upgradeReq = [
        "GET /dashboard/ws HTTP/1.1",
        `Host: 127.0.0.1:${proxy.port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
        "Origin: https://evil.attacker.com",
        "",
        "",
      ].join("\r\n");
      socket.write(upgradeReq);
    });

    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString();
      if (data.includes("\r\n\r\n")) {
        socket.destroy();
        resolve(data);
      }
    });
    socket.on("error", () => resolve("error"));
    setTimeout(() => {
      socket.destroy();
      resolve(data || "timeout");
    }, 3000);
  });

  // The server should reject the upgrade with 403, not 101.
  expect(result).toContain("403");
});

test("SEC-8b: WebSocket upgrade with local Origin succeeds (101)", async () => {
  const wsUrl = `ws://127.0.0.1:${proxy.port}/dashboard/ws`;
  const ws = new WebSocket(wsUrl);

  const opened = await new Promise<boolean>((resolve) => {
    ws.addEventListener("open", () => resolve(true), { once: true });
    ws.addEventListener("error", () => resolve(false), { once: true });
    setTimeout(() => resolve(false), 3000);
  });
  expect(opened).toBe(true);

  // Trigger a capture to verify broadcasts still work for local connections.
  const received = new Promise<boolean>((resolve) => {
    ws.addEventListener("message", () => resolve(true), { once: true });
    setTimeout(() => resolve(false), 3000);
  });

  await fetch(`${proxy.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": "toy-client",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 16,
      messages: [{ role: "user", content: "ws-origin-test" }],
    }),
  });

  const gotMessage = await received;
  expect(gotMessage).toBe(true);
  ws.close();
});
