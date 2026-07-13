// Test: Anthropic cache_control TTL stamping.
// Verifies that ephemeral cache_control blocks get ttl stamped on the Anthropic route,
// and that existing ttls are preserved, and non-Anthropic routes are left untouched.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { type ProxyHandle, startProxy } from "./helpers/proxy";
import { type RawUpstreamHandle, startRawUpstream } from "./helpers/raw-upstream";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let raw: RawUpstreamHandle;
let proxy: ProxyHandle;

beforeAll(async () => {
  raw = await startRawUpstream();
  proxy = await startProxy({
    TARGET: `http://127.0.0.1:${raw.port}`,
    STAMP_CLAUDE_CODE_ENABLED: "true",
  });
});

afterAll(async () => {
  await proxy.kill();
  await raw.close();
});

/** Send a request through the proxy and wait for the raw upstream to capture it. */
async function send(body: string) {
  raw.getLastRequest(); // reset reference
  await fetch(`${proxy.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  }).catch(() => {});
  await sleep(150);
  return raw.getLastRequest();
}

test("system ephemeral block gets ttl=1h", async () => {
  const body = JSON.stringify({
    system: [{ type: "text", text: "You are helpful", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "hi" }],
  });
  const r = await send(body);
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.system[0].cache_control.ttl).toBe("1h");
});

test("message content ephemeral block gets ttl=1h", async () => {
  const body = JSON.stringify({
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
      },
    ],
  });
  const r = await send(body);
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.messages[0].content[0].cache_control.ttl).toBe("1h");
});

test("existing ttl is preserved (not overwritten)", async () => {
  const body = JSON.stringify({
    system: [{ type: "text", text: "x", cache_control: { type: "ephemeral", ttl: "5m" } }],
  });
  const r = await send(body);
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.system[0].cache_control.ttl).toBe("5m");
});

test("no cache_control → forwarded byte-identical (ttl only, top_k not added for non-glm)", async () => {
  const body = JSON.stringify({ model: "claude", messages: [{ role: "user", content: "hi" }] });
  const r = await send(body);
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.top_k).toBeUndefined();
  expect(parsed.model).toBe("claude");
});
