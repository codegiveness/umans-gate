// Integration test: verifies the proxy appends ?beta=true to the upstream URL
// and injects the anthropic-beta header when stamp_claude_code is enabled.
//
// Run: bun test test/stamp-beta-header.test.ts

import { afterAll, beforeAll, expect, test } from "bun:test";
import { STAMP_ANTHROPIC_BETA_HEADER } from "../src/config.js";
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

test("upstream request URL includes ?beta=true when stampClaudeCode is enabled", async () => {
  raw.getLastRequest();
  await fetch(`${proxy.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "umans-glm-5.2",
      max_tokens: 50,
      messages: [{ role: "user", content: "Hello" }],
    }),
  }).catch(() => {});
  await sleep(150);

  const r = raw.getLastRequest();
  expect(r).not.toBeNull();
  const requestLine = r!.head.split("\r\n")[0];
  expect(requestLine).toContain("beta=true");
});

test("upstream request includes anthropic-beta header with full feature list", async () => {
  raw.getLastRequest();
  await fetch(`${proxy.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "umans-glm-5.2",
      max_tokens: 50,
      messages: [{ role: "user", content: "Hello" }],
    }),
  }).catch(() => {});
  await sleep(150);

  const r = raw.getLastRequest();
  expect(r).not.toBeNull();
  const headerLine = r!.head
    .split("\r\n")
    .find((l) => l.toLowerCase().startsWith("anthropic-beta:"));
  expect(headerLine).toBeDefined();
  expect(headerLine!).toBe(`anthropic-beta: ${STAMP_ANTHROPIC_BETA_HEADER}`);
});

test("?beta=true is not duplicated when client already sends it", async () => {
  raw.getLastRequest();
  await fetch(`${proxy.baseUrl}/v1/messages?beta=true`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "umans-glm-5.2",
      max_tokens: 50,
      messages: [{ role: "user", content: "Hello" }],
    }),
  }).catch(() => {});
  await sleep(150);

  const r = raw.getLastRequest();
  expect(r).not.toBeNull();
  const requestLine = r!.head.split("\r\n")[0];
  const betaCount = (requestLine.match(/beta=true/g) ?? []).length;
  expect(betaCount).toBe(1);
});

test("OpenAI requests do not get ?beta=true or anthropic-beta header", async () => {
  raw.getLastRequest();
  await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "umans-flash",
      messages: [{ role: "user", content: "Hello" }],
    }),
  }).catch(() => {});
  await sleep(150);

  const r = raw.getLastRequest();
  expect(r).not.toBeNull();
  const requestLine = r!.head.split("\r\n")[0];
  expect(requestLine).not.toContain("beta=true");
  const headerLine = r!.head
    .split("\r\n")
    .find((l) => l.toLowerCase().startsWith("anthropic-beta:"));
  expect(headerLine).toBeUndefined();
});

test("GET /v1/models does not get ?beta=true or anthropic-beta header", async () => {
  raw.getLastRequest();
  await fetch(`${proxy.baseUrl}/v1/models`, {
    method: "GET",
    headers: { "content-type": "application/json" },
  }).catch(() => {});
  await sleep(150);

  const r = raw.getLastRequest();
  expect(r).not.toBeNull();
  const requestLine = r!.head.split("\r\n")[0];
  expect(requestLine).not.toContain("beta=true");
  const headerLine = r!.head
    .split("\r\n")
    .find((l) => l.toLowerCase().startsWith("anthropic-beta:"));
  expect(headerLine).toBeUndefined();
});

test("client-sent anthropic-beta header is overwritten by the stamp value", async () => {
  raw.getLastRequest();
  await fetch(`${proxy.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-beta": "some-other-feature-2025-01-01",
    },
    body: JSON.stringify({
      model: "umans-glm-5.2",
      max_tokens: 50,
      messages: [{ role: "user", content: "Hello" }],
    }),
  }).catch(() => {});
  await sleep(150);

  const r = raw.getLastRequest();
  expect(r).not.toBeNull();
  const headerLine = r!.head
    .split("\r\n")
    .find((l) => l.toLowerCase().startsWith("anthropic-beta:"));
  expect(headerLine).toBeDefined();
  expect(headerLine!).toBe(`anthropic-beta: ${STAMP_ANTHROPIC_BETA_HEADER}`);
  expect(r!.head).not.toContain("some-other-feature-2025-01-01");
});

test("anthropic-beta header appears before anthropic-version in header order", async () => {
  raw.getLastRequest();
  await fetch(`${proxy.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "umans-glm-5.2",
      max_tokens: 50,
      messages: [{ role: "user", content: "Hello" }],
    }),
  }).catch(() => {});
  await sleep(150);

  const r = raw.getLastRequest();
  expect(r).not.toBeNull();
  const lines = r!.head.split("\r\n");
  const betaIdx = lines.findIndex((l) => l.toLowerCase().startsWith("anthropic-beta:"));
  const versionIdx = lines.findIndex((l) => l.toLowerCase().startsWith("anthropic-version:"));
  expect(betaIdx).toBeGreaterThan(0);
  expect(versionIdx).toBeGreaterThan(0);
  expect(betaIdx).toBeLessThan(versionIdx);
});

test("stamp disabled: /v1/messages does not get anthropic-beta or anthropic-version headers forced", async () => {
  const rawOff = await startRawUpstream();
  const proxyOff = await startProxy({
    TARGET: `http://127.0.0.1:${rawOff.port}`,
    STAMP_CLAUDE_CODE_ENABLED: "false",
  });
  try {
    rawOff.getLastRequest();
    await fetch(`${proxyOff.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-01-01",
      },
      body: JSON.stringify({
        model: "umans-glm-5.2",
        max_tokens: 50,
        messages: [{ role: "user", content: "Hello" }],
      }),
    }).catch(() => {});
    await sleep(150);

    const r = rawOff.getLastRequest();
    expect(r).not.toBeNull();
    const requestLine = r!.head.split("\r\n")[0];
    expect(requestLine).not.toContain("beta=true");
    const betaHeader = r!.head
      .split("\r\n")
      .find((l) => l.toLowerCase().startsWith("anthropic-beta:"));
    expect(betaHeader).toBeUndefined();
    const versionHeader = r!.head
      .split("\r\n")
      .find((l) => l.toLowerCase().startsWith("anthropic-version:"));
    expect(versionHeader).toBeDefined();
    expect(versionHeader!).toBe("anthropic-version: 2023-01-01");
  } finally {
    await proxyOff.kill();
    await rawOff.close();
  }
});
