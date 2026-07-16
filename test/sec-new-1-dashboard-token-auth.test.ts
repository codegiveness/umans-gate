// SEC-NEW-1: Dashboard token authentication tests.
//
// When DASHBOARD_TOKEN is set, all /dashboard/api/* routes, /health, and /metrics
// require `Authorization: Bearer <token>`. The WebSocket requires ?token=<token>.
// When DASHBOARD_TOKEN is not set, all endpoints are open (backward compatible).
//
// CWE-306 (Missing Authentication for Critical Function).

import { afterAll, beforeAll, expect, test } from "bun:test";
import { startCombinedMock } from "./helpers/combined-mock.ts";
import { type ProxyHandle, startProxy } from "./helpers/proxy.js";

const TOKEN = "test-dashboard-token-abc123";

let proxy: ProxyHandle;
let mock: ReturnType<typeof startCombinedMock>;

beforeAll(async () => {
  mock = startCombinedMock({ limit: 1, hardCap: 1, delayMs: 10 });
  const mockUrl = `http://127.0.0.1:${mock.port}`;
  proxy = await startProxy({
    TARGET: mockUrl,
    umansApiKey: "sk-token-test",
    dashboardToken: TOKEN,
    WARMER_ENABLED: "false",
    USAGE_REFRESH_MS: "999999",
  });
});

afterAll(async () => {
  await proxy.kill();
  mock.close();
});

test("GET /health without token returns 401 when DASHBOARD_TOKEN is set", async () => {
  const res = await fetch(`${proxy.baseUrl}/health`);
  expect(res.status).toBe(401);
});

test("GET /health with correct token returns 200", async () => {
  const res = await fetch(`${proxy.baseUrl}/health`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  expect(res.status).toBe(200);
});

test("GET /health with wrong token returns 401", async () => {
  const res = await fetch(`${proxy.baseUrl}/health`, {
    headers: { Authorization: "Bearer wrong-token" },
  });
  expect(res.status).toBe(401);
});

test("GET /metrics without token returns 401 when DASHBOARD_TOKEN is set", async () => {
  const res = await fetch(`${proxy.baseUrl}/metrics`);
  expect(res.status).toBe(401);
});

test("GET /metrics with correct token returns 200", async () => {
  const res = await fetch(`${proxy.baseUrl}/metrics`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  expect(res.status).toBe(200);
});

test("GET /dashboard/api/config without token returns 401", async () => {
  const res = await fetch(`${proxy.baseUrl}/dashboard/api/config`);
  expect(res.status).toBe(401);
});

test("GET /dashboard/api/config with correct token returns 200", async () => {
  const res = await fetch(`${proxy.baseUrl}/dashboard/api/config`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  expect(res.status).toBe(200);
  const data = (await res.json()) as Record<string, unknown>;
  expect(data.has_dashboard_token).toBe(true);
  expect(data.dashboard_token).toBeUndefined();
});

test("GET /dashboard/api/config with wrong token returns 401", async () => {
  const res = await fetch(`${proxy.baseUrl}/dashboard/api/config`, {
    headers: { Authorization: "Bearer nope" },
  });
  expect(res.status).toBe(401);
});

test("GET /dashboard/api/captures without token returns 401", async () => {
  const res = await fetch(`${proxy.baseUrl}/dashboard/api/captures`);
  expect(res.status).toBe(401);
});

test("GET /dashboard/api/captures with correct token returns 200", async () => {
  const res = await fetch(`${proxy.baseUrl}/dashboard/api/captures`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  expect(res.status).toBe(200);
});

test("GET /dashboard/api/gate without token returns 401", async () => {
  const res = await fetch(`${proxy.baseUrl}/dashboard/api/gate`);
  expect(res.status).toBe(401);
});

test("GET /dashboard/api/gate with correct token returns 200", async () => {
  const res = await fetch(`${proxy.baseUrl}/dashboard/api/gate`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  expect(res.status).toBe(200);
});

test("POST /dashboard/api/restart without token returns 401", async () => {
  const res = await fetch(`${proxy.baseUrl}/dashboard/api/restart`, { method: "POST" });
  expect(res.status).toBe(401);
});

test("static dashboard assets (HTML) are served without token", async () => {
  const res = await fetch(`${proxy.baseUrl}/dashboard/`);
  expect(res.status).toBe(200);
});

test("GET /dashboard/api/config does not leak dashboard_token in response", async () => {
  const res = await fetch(`${proxy.baseUrl}/dashboard/api/config`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).not.toContain(TOKEN);
  const data = JSON.parse(text) as Record<string, unknown>;
  expect(data.dashboard_token).toBeUndefined();
  expect(data.has_dashboard_token).toBe(true);
});

test("GET /dashboard/api/config does not leak umans_api_key in response", async () => {
  const res = await fetch(`${proxy.baseUrl}/dashboard/api/config`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const data = (await res.json()) as Record<string, unknown>;
  expect(data.umans_api_key).toBeUndefined();
  expect(data.has_api_key).toBe(true);
});

test("WebSocket connection without token is rejected", async () => {
  const wsUrl = `ws://127.0.0.1:${proxy.port}/dashboard/ws`;
  const ws = new WebSocket(wsUrl);
  const result = await new Promise<{ ok: boolean; code: number }>((resolve) => {
    ws.onopen = () => {
      ws.close();
      resolve({ ok: true, code: 0 });
    };
    ws.onerror = () => {
      resolve({ ok: false, code: -1 });
    };
    ws.onclose = (ev) => {
      resolve({ ok: false, code: ev.code });
    };
    setTimeout(() => {
      ws.close();
      resolve({ ok: false, code: -2 });
    }, 2000);
  });
  expect(result.ok).toBe(false);
});

test("WebSocket connection with correct token succeeds", async () => {
  const wsUrl = `ws://127.0.0.1:${proxy.port}/dashboard/ws?token=${encodeURIComponent(TOKEN)}`;
  const ws = new WebSocket(wsUrl);
  let opened = false;
  const result = await new Promise<boolean>((resolve) => {
    ws.onopen = () => {
      opened = true;
      ws.close();
      resolve(true);
    };
    ws.onerror = (e) => {
      console.error("WS error:", e);
      resolve(false);
    };
    ws.onclose = (ev) => {
      console.log("WS close: code=", ev.code, "reason=", ev.reason, "opened=", opened);
      resolve(opened);
    };
    setTimeout(() => {
      if (!opened) {
        console.log("WS timeout, readyState=", ws.readyState);
        ws.close();
      }
      resolve(opened);
    }, 5000);
  });
  expect(result).toBe(true);
});

test("WebSocket connection with wrong token is rejected", async () => {
  const wsUrl = `ws://127.0.0.1:${proxy.port}/dashboard/ws?token=wrong`;
  const ws = new WebSocket(wsUrl);
  const result = await new Promise<boolean>((resolve) => {
    ws.onopen = () => {
      ws.close();
      resolve(true);
    };
    ws.onerror = () => resolve(false);
    ws.onclose = () => resolve(false);
    setTimeout(() => {
      ws.close();
      resolve(false);
    }, 2000);
  });
  expect(result).toBe(false);
});

// --- Brute-force protection (AuthFailureLimiter) ---

test("repeated wrong tokens eventually trigger 429 lockout on /health", async () => {
  let got429 = false;
  for (let i = 0; i < 25; i++) {
    const res = await fetch(`${proxy.baseUrl}/health`, {
      headers: { Authorization: "Bearer brute-force-attempt" },
    });
    if (res.status === 429) {
      got429 = true;
      break;
    }
    expect(res.status).toBe(401);
  }
  expect(got429).toBe(true);
});

test("correct token returns 429 when locked out (limiter short-circuits)", async () => {
  const res = await fetch(`${proxy.baseUrl}/health`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  expect(res.status).toBe(429);
});
