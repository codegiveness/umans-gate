// Test: WebSocket broadcast — connecting to /dashboard/ws and receiving
// "new" and "update" messages when a request flows through the proxy.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { getEchoPort, startEchoUpstream, stopEchoUpstream } from "../helpers/echo-upstream";
import { type ProxyHandle, startProxy } from "../helpers/proxy";

const _sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let proxy: ProxyHandle;
let echoUpstream: ReturnType<typeof import("../helpers/echo-upstream")["startEchoUpstream"]>;

beforeAll(async () => {
  echoUpstream = startEchoUpstream();
  proxy = await startProxy({
    TARGET: `http://127.0.0.1:${getEchoPort(echoUpstream)}`,
    STAMP_CACHE_TTL_ENABLED: "false",
  });
});

afterAll(async () => {
  await proxy.kill();
  stopEchoUpstream(echoUpstream);
});

test("WebSocket receives new + update messages", async () => {
  const events: Array<{ type: string; state?: string; status?: number | null }> = [];

  const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/dashboard/ws`);

  const messagePromise = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("WebSocket test timeout"));
    }, 5000);

    ws.addEventListener("open", async () => {
      // Trigger a request through the proxy
      await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ test: true }),
      });
      // Give the proxy a moment to broadcast the update after flush
      setTimeout(() => {
        clearTimeout(timeout);
        resolve();
      }, 800);
    });

    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      events.push(
        msg.type === "new" || msg.type === "update"
          ? { type: msg.type, state: msg.capture?.state, status: msg.capture?.response_status }
          : msg,
      );
    });

    ws.addEventListener("error", (e) => {
      clearTimeout(timeout);
      reject(new Error(`WebSocket error: ${e}`));
    });
  });

  await messagePromise;
  ws.close();

  const types = events.map((e) => e.type);
  expect(types).toContain("new");
  expect(types).toContain("update");
});

test("WebSocket receives clear message", async () => {
  const events: string[] = [];

  const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/dashboard/ws`);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("clear test timeout")), 5000);

    ws.addEventListener("open", async () => {
      await fetch(`${proxy.baseUrl}/dashboard/api/clear`, { method: "POST" });
      setTimeout(() => {
        clearTimeout(timeout);
        resolve();
      }, 300);
    });

    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      events.push(msg.type);
    });

    ws.addEventListener("error", (e) => {
      clearTimeout(timeout);
      reject(new Error(`WebSocket error: ${e}`));
    });
  });

  ws.close();
  expect(events).toContain("clear");
});
