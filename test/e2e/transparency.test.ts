// Test: basic proxy transparency — requests pass through without modification
// when STAMP_CACHE_TTL is disabled.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { getEchoPort, startEchoUpstream, stopEchoUpstream } from "../helpers/echo-upstream";
import { type ProxyHandle, startProxy } from "../helpers/proxy";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let proxy: ProxyHandle;
let echoUpstream: ReturnType<typeof import("../helpers/echo-upstream")["startEchoUpstream"]>;

beforeAll(async () => {
  echoUpstream = startEchoUpstream();
  proxy = await startProxy({
    TARGET: `http://127.0.0.1:${getEchoPort(echoUpstream)}`,
    STAMP_CACHE_TTL_ENABLED: "false", // transparent mode
    STAMP_TOP_K_ENABLED: "false", // disable top_k injection for passthrough test
  });
});

afterAll(async () => {
  await proxy.kill();
  stopEchoUpstream(echoUpstream);
});

test("GET request passes through and returns echo", async () => {
  const r = await fetch(`${proxy.baseUrl}/v1/models`);
  expect(r.status).toBe(200);
  const data = (await r.json()) as { method: string; path: string };
  expect(data.method).toBe("GET");
  expect(data.path).toBe("/v1/models");
});

test("POST request body passes through unchanged", async () => {
  const body = JSON.stringify({ hello: "world" });
  const r = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const data = (await r.json()) as { body: string };
  expect(data.body).toBe(body);
});

test("response headers pass through", async () => {
  const r = await fetch(`${proxy.baseUrl}/v1/models`);
  expect(r.headers.get("x-echo")).toBe("yes");
});

test("capture appears in REST API", async () => {
  await fetch(`${proxy.baseUrl}/v1/models`);
  await sleep(150);

  const r = await fetch(`${proxy.baseUrl}/dashboard/api/captures?limit=10`);
  const captures = (await r.json()) as Array<{ path: string }>;
  expect(captures.length).toBeGreaterThan(0);
  expect(captures.some((c) => c.path === "/v1/models")).toBe(true);
});

test("clear endpoint removes all captures", async () => {
  await fetch(`${proxy.baseUrl}/v1/models`);
  await sleep(150);

  await fetch(`${proxy.baseUrl}/dashboard/api/clear`, { method: "POST" });
  await sleep(100);

  const r = await fetch(`${proxy.baseUrl}/dashboard/api/captures?limit=10`);
  const captures = (await r.json()) as unknown[];
  expect(captures.length).toBe(0);
});
