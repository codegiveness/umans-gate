// Characterization test: lock the route matching priority of src/viewer.ts
// before/during the table-driven refactor.
//
// Asserts:
// (a) GET /dashboard/api/captures/:id matches the DETAIL_RE route (not the list route)
//     and returns JSON for that specific capture.
// (b) GET /dashboard/some-page returns the SPA index.html fallback (200, text/html).
// (c) GET /dashboard/api/unknown returns 404 (API paths are NOT eligible for SPA fallback).

import { afterAll, beforeAll, expect, test } from "bun:test";
import { getEchoPort, startEchoUpstream, stopEchoUpstream } from "./helpers/echo-upstream";
import { type ProxyHandle, startProxy } from "./helpers/proxy";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let proxy: ProxyHandle;

beforeAll(async () => {
  startEchoUpstream();
  proxy = await startProxy({
    TARGET: `http://127.0.0.1:${getEchoPort()}`,
    STAMP_CACHE_TTL_ENABLED: "false",
  });
});

afterAll(async () => {
  await proxy.kill();
  stopEchoUpstream();
});

test("GET /dashboard/api/captures/:id matches detail route, not list route", async () => {
  // Generate a capture by proxying a request through
  await fetch(`${proxy.baseUrl}/v1/models`);
  await sleep(150);

  // Get the list to find a capture id
  const listRes = await fetch(`${proxy.baseUrl}/dashboard/api/captures?limit=10`);
  const list = (await listRes.json()) as Array<{ id: number; path: string }>;
  expect(list.length).toBeGreaterThan(0);
  const captureId = list[0].id;

  // Fetch the detail route — must return the single capture object, not an array
  const detailRes = await fetch(`${proxy.baseUrl}/dashboard/api/captures/${captureId}`);
  expect(detailRes.status).toBe(200);
  expect(detailRes.headers.get("content-type")).toContain("application/json");
  const detail = (await detailRes.json()) as { id: number; path: string };
  expect(detail.id).toBe(captureId);
  expect(detail.path).toBe("/v1/models");
  // Detail route returns an object with .id, not an array
  expect(Array.isArray(detail)).toBe(false);
});

test("GET /dashboard/some-page returns SPA index.html fallback (200, text/html)", async () => {
  const res = await fetch(`${proxy.baseUrl}/dashboard/some-page`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  const body = await res.text();
  expect(body.length).toBeGreaterThan(0);
});

test("GET /dashboard/ and SPA fallback serve index.html with no-cache headers", async () => {
  const rootRes = await fetch(`${proxy.baseUrl}/dashboard/`);
  expect(rootRes.status).toBe(200);
  expect(rootRes.headers.get("content-type")).toContain("text/html");
  expect(rootRes.headers.get("cache-control")).toBe("no-cache, no-store, must-revalidate");

  const fallbackRes = await fetch(`${proxy.baseUrl}/dashboard/unknown-route`);
  expect(fallbackRes.status).toBe(200);
  expect(fallbackRes.headers.get("content-type")).toContain("text/html");
  expect(fallbackRes.headers.get("cache-control")).toBe("no-cache, no-store, must-revalidate");
});

test("GET /dashboard/api/unknown returns 404, not SPA fallback", async () => {
  const res = await fetch(`${proxy.baseUrl}/dashboard/api/unknown`);
  // API paths (startsWith "api/") are NOT eligible for SPA fallback — must be 404
  expect(res.status).toBe(404);
});

test("path traversal via literal .. is blocked", async () => {
  const res = await fetch(`${proxy.baseUrl}/dashboard/../../etc/passwd`);
  // URL parser normalizes .. so this never reaches the viewer router;
  // it falls through to the proxy path and returns 404 or similar — not 200.
  expect(res.status).toBe(404);
  const body = await res.text();
  expect(body).not.toContain("root:");
});

test("path traversal via encoded %2e%2e is blocked", async () => {
  const res = await fetch(`${proxy.baseUrl}/dashboard/%2e%2e/%2e%2e/etc/passwd`);
  expect(res.status).toBe(404);
  const body = await res.text();
  expect(body).not.toContain("root:");
});

test("path traversal via mixed ..%2f encoding is blocked", async () => {
  const res = await fetch(`${proxy.baseUrl}/dashboard/..%2f..%2f/etc/passwd`);
  expect(res.status).toBe(404);
  const body = await res.text();
  expect(body).not.toContain("root:");
});

test("path traversal via double encoding %252e is blocked", async () => {
  const res = await fetch(`${proxy.baseUrl}/dashboard/%252e%252e/%252e%252e/etc/passwd`);
  // %252e decodes to literal %2e (not .), so the path stays inside the
  // dashboard directory. No sensitive file is served regardless of status.
  const body = await res.text();
  expect(body).not.toContain("root:");
  expect(body).not.toContain("/bin/sh");
});
