// Ticket 01 — Incident attribution for upstream 500 errors.
//
// A 500 from the upstream endpoint must produce exactly one incident row
// with responsible_party="upstream", incident_type="upstream_error",
// upstream_status=500, served_status=500. The REST route must return the
// incident joined to its capture (model + path present).

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { startProxy } from "./helpers/proxy.js";

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
  model: "claude-sonnet-4-5",
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
      expect(incidents[0].capture_model).toBe("claude-sonnet-4-5");
      expect(incidents[0].capture_path).toBe("/v1/messages");
    } finally {
      await proxy.kill();
      await upstream.close();
    }
  });
});
