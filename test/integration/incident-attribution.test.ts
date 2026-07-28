// Ticket 01 — Incident attribution for upstream 500 errors.
//
// A 500 from the upstream endpoint must produce exactly one incident row
// with responsible_party="upstream", incident_type="upstream_error",
// upstream_status=500, served_status=500. The REST route must return the
// incident joined to its capture (model + path present).

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { CaptureDB } from "../../src/db.js";
import { startProxy } from "../helpers/proxy.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function start500Upstream(): { port: number; close: () => Promise<void> } {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method !== "POST" || new URL(req.url).pathname !== "/v1/messages") {
        return new Response("not found", { status: 404 });
      }
      return new Response(JSON.stringify({ error: "internal_server_error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return {
    port: server.port!,
    close: () =>
      new Promise<void>((res) => {
        server.stop();
        setTimeout(res, 50);
      }),
  };
}

const MSG_BODY = JSON.stringify({
  model: "umans-glm-5.2",
  max_tokens: 10,
  stream: false,
  messages: [{ role: "user", content: "test" }],
});
const MSG_HEADERS = { "content-type": "application/json" };

describe("Incident attribution — upstream 500", () => {
  test("500 upstream produces exactly one upstream_error incident", async () => {
    const upstream = start500Upstream();
    const proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      WARMER_ENABLED: "false",
      USAGE_REFRESH_MS: "999999",
      CONCURRENCY_HARD_CAP: "2",
      CONCURRENCY_SOFT_LIMIT: "2",
      RELEASE_COOLDOWN_MS: "0",
    });
    try {
      const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: MSG_HEADERS,
        body: MSG_BODY,
      });
      expect(res.status).toBe(500);
      await res.text();

      await sleep(300);

      const db = new Database(proxy.dbPath, { readonly: true });
      const incidents = db
        .prepare(
          "SELECT capture_id, responsible_party, incident_type, upstream_status, served_status FROM incidents",
        )
        .all() as Array<{
        capture_id: number;
        responsible_party: string;
        incident_type: string;
        upstream_status: number | null;
        served_status: number;
      }>;
      db.close();

      expect(incidents.length).toBe(1);
      expect(incidents[0].responsible_party).toBe("upstream");
      expect(incidents[0].incident_type).toBe("upstream_error");
      expect(incidents[0].upstream_status).toBe(500);
      expect(incidents[0].served_status).toBe(500);
    } finally {
      await proxy.kill();
      await upstream.close();
    }
  });

  test("REST route returns the incident joined to its capture", async () => {
    const upstream = start500Upstream();
    const proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      WARMER_ENABLED: "false",
      USAGE_REFRESH_MS: "999999",
      CONCURRENCY_HARD_CAP: "2",
      CONCURRENCY_SOFT_LIMIT: "2",
      RELEASE_COOLDOWN_MS: "0",
    });
    try {
      const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: MSG_HEADERS,
        body: MSG_BODY,
      });
      expect(res.status).toBe(500);
      await res.text();

      await sleep(300);

      const incidentsRes = await fetch(`${proxy.baseUrl}/dashboard/api/incidents`);
      expect(incidentsRes.status).toBe(200);
      const incidents = (await incidentsRes.json()) as Array<{
        capture_id: number;
        responsible_party: string;
        incident_type: string;
        upstream_status: number | null;
        served_status: number;
        capture_model: string | null;
        capture_path: string | null;
      }>;
      expect(incidents.length).toBe(1);
      expect(incidents[0].responsible_party).toBe("upstream");
      expect(incidents[0].incident_type).toBe("upstream_error");
      expect(incidents[0].upstream_status).toBe(500);
      expect(incidents[0].served_status).toBe(500);
      expect(incidents[0].capture_model).toBe("umans-glm-5.2");
      expect(incidents[0].capture_path).toBe("/v1/messages");
    } finally {
      await proxy.kill();
      await upstream.close();
    }
  });
});

// Ticket 02 — Gate + rate-limit + client-abort + TTFT insertion sites.
//
// Covers the 5 pre-stream incident insertion sites wired in proxy.ts:
//   - 429 rate-limit (checkRateLimit)
//   - 504 TTFT timeout with suppression cause (queueTtftTimeout)
//   - 499 client-abort (acquirePermit aborted path)

/** Upstream that stalls forever — never sends the first byte. */
function startStallForeverUpstream(): { port: number; close: () => Promise<void> } {
  const server = Bun.serve({
    port: 0,
    async fetch() {
      return new Response(new ReadableStream({ start() {} }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  return {
    port: server.port!,
    close: () =>
      new Promise<void>((res) => {
        server.stop();
        setTimeout(res, 50);
      }),
  };
}

describe("Incident attribution — 429 rate limit", () => {
  test("rate-limited request produces exactly one rate_limited incident", async () => {
    const upstream = start500Upstream();
    const proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      WARMER_ENABLED: "false",
      USAGE_REFRESH_MS: "999999",
      CONCURRENCY_HARD_CAP: "2",
      CONCURRENCY_SOFT_LIMIT: "2",
      RELEASE_COOLDOWN_MS: "0",
      RATE_LIMIT_REQUESTS: "1",
    });
    try {
      // First request consumes the 1-request budget (returns 500 from upstream).
      const res1 = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: MSG_HEADERS,
        body: MSG_BODY,
      });
      await res1.text();
      // Second request hits the rate limiter and is rejected with 429.
      const res2 = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: MSG_HEADERS,
        body: MSG_BODY,
      });
      expect(res2.status).toBe(429);
      await res2.text();

      await sleep(300);

      const db = new Database(proxy.dbPath, { readonly: true });
      const rateLimited = db
        .prepare(
          "SELECT capture_id, responsible_party, incident_type, upstream_status, served_status FROM incidents WHERE incident_type = 'rate_limited'",
        )
        .all() as Array<{
        capture_id: number;
        responsible_party: string;
        incident_type: string;
        upstream_status: number | null;
        served_status: number;
      }>;
      db.close();

      expect(rateLimited.length).toBe(1);
      expect(rateLimited[0].responsible_party).toBe("proxy");
      expect(rateLimited[0].incident_type).toBe("rate_limited");
      expect(rateLimited[0].upstream_status).toBe(null);
      expect(rateLimited[0].served_status).toBe(429);
    } finally {
      await proxy.kill();
      await upstream.close();
    }
  });
});

describe("Incident attribution — 504 TTFT timeout (retry suppressed: cap_reached)", () => {
  test("TTFT timeout with retries disabled produces ttft_timeout incident", async () => {
    const upstream = startStallForeverUpstream();
    const proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      WARMER_ENABLED: "false",
      USAGE_REFRESH_MS: "999999",
      CONCURRENCY_HARD_CAP: "2",
      CONCURRENCY_SOFT_LIMIT: "2",
      RELEASE_COOLDOWN_MS: "0",
      UPSTREAM_TIMEOUT_MS: "10000",
      EXPERIMENT_TTFT_WATCHDOG: "true",
      TTFT_TIMEOUT_MS: "500",
      TTFT_RETRY_MAX_ATTEMPTS: "0",
      TTFT_RETRY_COOLDOWN_MS: "0",
    });
    try {
      const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: MSG_HEADERS,
        body: MSG_BODY,
      });
      expect(res.status).toBe(504);
      await res.text();

      await sleep(300);

      const db = new Database(proxy.dbPath, { readonly: true });
      const incidents = db
        .prepare(
          "SELECT capture_id, responsible_party, incident_type, upstream_status, served_status, reason FROM incidents",
        )
        .all() as Array<{
        capture_id: number;
        responsible_party: string;
        incident_type: string;
        upstream_status: number | null;
        served_status: number;
        reason: string | null;
      }>;
      db.close();

      expect(incidents.length).toBe(1);
      expect(incidents[0].responsible_party).toBe("proxy");
      expect(incidents[0].incident_type).toBe("ttft_timeout");
      expect(incidents[0].upstream_status).toBe(null);
      expect(incidents[0].served_status).toBe(504);
      expect(incidents[0].reason).toContain("all retries exhausted");
    } finally {
      await proxy.kill();
      await upstream.close();
    }
  });
});

describe("Incident attribution — 499 client abort (acquirePermit)", () => {
  test("client disconnect while enqueued produces client_aborted incident", async () => {
    // Stall upstream so requests never complete; concurrency soft limit of 1
    // so the second request enqueues. We then abort the second request's
    // client signal, which surfaces as a 499 from acquirePermit's GateError
    // catch (err.code === "aborted").
    const upstream = startStallForeverUpstream();
    const proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      WARMER_ENABLED: "false",
      USAGE_REFRESH_MS: "999999",
      CONCURRENCY_HARD_CAP: "1",
      CONCURRENCY_SOFT_LIMIT: "1",
      RELEASE_COOLDOWN_MS: "0",
      UPSTREAM_TIMEOUT_MS: "10000",
    });
    try {
      // First request holds the single concurrency slot forever. Fire and
      // forget — we never await it; proxy.kill() in finally reaps it.
      // Catch so the connection-reset on proxy shutdown doesn't surface as
      // an unhandled rejection.
      void fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: MSG_HEADERS,
        body: MSG_BODY,
      }).catch(() => {
        // proxy.kill() in finally may reset this socket — expected.
      });
      // Give the first request time to acquire the permit.
      await sleep(150);
      // Second request enqueues; abort the client immediately.
      const ac2 = new AbortController();
      const fetch2Promise = fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: MSG_HEADERS,
        body: MSG_BODY,
        signal: ac2.signal,
      });
      await sleep(50);
      ac2.abort();
      let res2Status = 0;
      try {
        const res2 = await fetch2Promise;
        res2Status = res2.status;
        await res2.text();
      } catch {
        // AbortError on the client side is expected.
      }
      // The proxy returns 499 to the client (Bun surfaces it as a thrown
      // AbortError, but the capture row records 499). Either way the
      // incident row must be client_aborted.
      expect([0, 499]).toContain(res2Status);

      await sleep(300);

      const db = new Database(proxy.dbPath, { readonly: true });
      const aborted = db
        .prepare(
          "SELECT capture_id, responsible_party, incident_type, upstream_status, served_status FROM incidents WHERE incident_type = 'client_aborted'",
        )
        .all() as Array<{
        capture_id: number;
        responsible_party: string;
        incident_type: string;
        upstream_status: number | null;
        served_status: number;
      }>;
      db.close();

      expect(aborted.length).toBe(1);
      expect(aborted[0].responsible_party).toBe("client");
      expect(aborted[0].incident_type).toBe("client_aborted");
      expect(aborted[0].upstream_status).toBe(null);
      expect(aborted[0].served_status).toBe(499);
    } finally {
      await proxy.kill();
      await upstream.close();
    }
  });
});

// Ticket 03 — Retention purge.
//
// sweepIncidents() must delete incident rows whose created_at falls before
// the cutoff, and leave in-window rows intact. The retention default is 30
// days when no config field is supplied (ticket 04 wires the config).

describe("Incident retention purge", () => {
  test("sweepIncidents deletes out-of-window rows and keeps in-window rows", async () => {
    const upstream = start500Upstream();
    const proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      WARMER_ENABLED: "false",
      USAGE_REFRESH_MS: "999999",
      CONCURRENCY_HARD_CAP: "2",
      CONCURRENCY_SOFT_LIMIT: "2",
      RELEASE_COOLDOWN_MS: "0",
    });
    try {
      // Produce a real in-window incident via a 500 upstream response.
      const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: MSG_HEADERS,
        body: MSG_BODY,
      });
      expect(res.status).toBe(500);
      await res.text();
      await sleep(300);

      const dbPath = proxy.dbPath;
      const db = new Database(dbPath);
      // Sanity: one incident exists from the 500 above.
      const beforeCount = db.prepare("SELECT COUNT(*) AS n FROM incidents").get() as { n: number };
      expect(beforeCount.n).toBe(1);

      const inWindowCaptureId = (
        db.prepare("SELECT capture_id FROM incidents LIMIT 1").get() as { capture_id: number }
      ).capture_id;

      // Insert a synthetic out-of-window incident (31 days old).
      const oldCaptureId = inWindowCaptureId + 1_000_000;
      const oldCreatedAt = Date.now() - 31 * 86_400_000;
      db.prepare(
        `INSERT INTO incidents (capture_id, responsible_party, incident_type, upstream_status, served_status, reason, created_at)
         VALUES ($cid, 'upstream', 'upstream_error', 503, 503, 'synthetic old', $ts)`,
      ).run({ $cid: oldCaptureId, $ts: oldCreatedAt });

      const cutoff = Date.now() - 5 * 86_400_000;
      const captureDb = new CaptureDB({ dbPath, maxCaptures: 200, incidentRetentionDays: 365 });
      const deleted = captureDb.sweepIncidents(cutoff);
      expect(deleted).toBe(1);

      const remaining = db
        .prepare(
          "SELECT capture_id, responsible_party, incident_type FROM incidents ORDER BY capture_id",
        )
        .all() as Array<{
        capture_id: number;
        responsible_party: string;
        incident_type: string;
      }>;
      expect(remaining.length).toBe(1);
      expect(remaining[0].capture_id).toBe(inWindowCaptureId);
      expect(remaining[0].responsible_party).toBe("upstream");
      expect(remaining[0].incident_type).toBe("upstream_error");

      // Re-insert the old row and run the sweep again with a window that
      // keeps it: cutoff far in the past. Nothing should be deleted.
      db.prepare(
        `INSERT INTO incidents (capture_id, responsible_party, incident_type, upstream_status, served_status, reason, created_at)
         VALUES ($cid, 'upstream', 'upstream_error', 503, 503, 'synthetic old', $ts)`,
      ).run({ $cid: oldCaptureId, $ts: oldCreatedAt });
      const keepAllResult = captureDb.sweepIncidents(0);
      expect(keepAllResult).toBe(0);
      captureDb.close();

      const finalRows = db.prepare("SELECT COUNT(*) AS n FROM incidents").get() as { n: number };
      expect(finalRows.n).toBe(2);
      db.close();
    } finally {
      await proxy.kill();
      await upstream.close();
    }
  });
});

function startStructuredErrorUpstream(): { port: number; close: () => Promise<void> } {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method !== "POST" || new URL(req.url).pathname !== "/v1/messages") {
        return new Response("not found", { status: 404 });
      }
      return new Response(
        JSON.stringify({
          error: {
            type: "api_error",
            message: "The service is temporarily overloaded. Please retry.",
          },
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    },
  });
  return {
    port: server.port!,
    close: () =>
      new Promise<void>((res) => {
        server.stop();
        setTimeout(res, 50);
      }),
  };
}

describe("Incident reason — structured upstream error body", () => {
  test("500 with {error:{type,message}} produces reason 'type: message'", async () => {
    const upstream = startStructuredErrorUpstream();
    const proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      WARMER_ENABLED: "false",
      USAGE_REFRESH_MS: "999999",
      CONCURRENCY_HARD_CAP: "2",
      CONCURRENCY_SOFT_LIMIT: "2",
      RELEASE_COOLDOWN_MS: "0",
    });
    try {
      const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: MSG_HEADERS,
        body: MSG_BODY,
      });
      expect(res.status).toBe(500);
      await res.text();

      await sleep(300);

      const db = new Database(proxy.dbPath, { readonly: true });
      const incidents = db
        .prepare(
          "SELECT capture_id, responsible_party, incident_type, upstream_status, served_status, reason FROM incidents",
        )
        .all() as Array<{
        capture_id: number;
        responsible_party: string;
        incident_type: string;
        upstream_status: number | null;
        served_status: number;
        reason: string | null;
      }>;
      db.close();

      expect(incidents.length).toBe(1);
      expect(incidents[0].responsible_party).toBe("upstream");
      expect(incidents[0].incident_type).toBe("upstream_error");
      expect(incidents[0].upstream_status).toBe(500);
      expect(incidents[0].served_status).toBe(500);
      expect(incidents[0].reason).toBe(
        "api_error: The service is temporarily overloaded. Please retry.",
      );
    } finally {
      await proxy.kill();
      await upstream.close();
    }
  });
});
