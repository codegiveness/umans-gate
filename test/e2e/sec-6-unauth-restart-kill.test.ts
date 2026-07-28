// Documented behavior for SEC-6: Local restart endpoint via POST /dashboard/api/restart.
//
// The restart endpoint is accessible without auth on 127.0.0.1. This is
// inherent to a local dev tool. The CSRF fix (SEC-4) prevents remote
// exploitation via cross-origin POSTs. Local process access remains by design.
//
// CWE-306 (Missing Authentication).
// Severity: Low (local-only DoS; remote vector closed by SEC-4 CSRF fix).

import { expect, test } from "bun:test";
import { startProxy } from "../helpers/proxy.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("SEC-6: POST /dashboard/api/restart kills the server without auth", async () => {
  const proxy = await startProxy({
    umansApiKey: "sk-sec6-restart",
    WARMER_ENABLED: "false",
    USAGE_REFRESH_MS: "999999",
  });

  try {
    // Health check confirms the server is up.
    const before = await fetch(`${proxy.baseUrl}/health`);
    expect(before.ok).toBe(true);

    // Unauthenticated restart request.
    const res = await fetch(`${proxy.baseUrl}/dashboard/api/restart`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // The handler uses setTimeout(restart, 100), then process.exit(0).
    // Wait for the process to actually die.
    let exited = false;
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(`${proxy.baseUrl}/health`);
        await sleep(100);
      } catch {
        exited = true;
        break;
      }
    }
    expect(exited).toBe(true);
  } finally {
    // Ensure cleanup even if the test assertion path skips the kill.
    try {
      proxy.proc.kill(9);
    } catch {
      // already dead
    }
    await sleep(200);
  }
});
