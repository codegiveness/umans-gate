// Regression test: when a client disconnects mid-stream (after upstream
// returned 200 and started streaming), the proxy must log a
// client_aborted incident. Before the fix, onAbort only flushed the
// capture and released the permit — no incident row was written because
// maybeRecordUpstreamIncident no-ops on status < 400.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { startProxy } from "../helpers/proxy.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** SSE upstream that sends one chunk then stalls forever — never closes. */
function startStallingSseUpstream(): { port: number; close: () => Promise<void> } {
  const server = Bun.serve({
    port: 0,
    async fetch() {
      return new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode("data: chunk1\n\n"));
            // Never send more — keeps the stream open until the client aborts.
            await sleep(60000);
            controller.close();
          },
        }),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
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

const MSG_BODY = JSON.stringify({
  model: "umans-glm-5.2",
  max_tokens: 100,
  stream: true,
  messages: [{ role: "user", content: "Hello" }],
});
const MSG_HEADERS = { "content-type": "application/json" };

describe("Mid-stream client abort incident", () => {
  test("client disconnect mid-stream produces client_aborted incident", async () => {
    const upstream = startStallingSseUpstream();
    const proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      WARMER_ENABLED: "false",
      USAGE_REFRESH_MS: "999999",
      CONCURRENCY_HARD_CAP: "2",
      CONCURRENCY_SOFT_LIMIT: "2",
      RELEASE_COOLDOWN_MS: "0",
    });
    try {
      const controller = new AbortController();
      const fetchPromise = fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: MSG_HEADERS,
        body: MSG_BODY,
        signal: controller.signal,
      });

      // Wait for the first SSE chunk to arrive — proves the stream started
      // (upstream returned 200 and is actively streaming).
      await sleep(200);

      // Abort the client mid-stream.
      controller.abort();
      // Don't await fetchPromise — headers already arrived (200), so abort
      // cancels the body stream without rejecting the fetch promise.
      // Swallow any latent rejection on proxy shutdown.
      void fetchPromise.catch(() => {});

      // Give the proxy time to flush the capture + write the incident.
      await sleep(300);

      const db = new Database(proxy.dbPath, { readonly: true });
      const aborted = db
        .prepare(
          "SELECT capture_id, responsible_party, incident_type, upstream_status, served_status, reason FROM incidents WHERE incident_type = 'client_aborted'",
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

      expect(aborted.length).toBe(1);
      expect(aborted[0].responsible_party).toBe("client");
      expect(aborted[0].incident_type).toBe("client_aborted");
      // Upstream had already returned 200 and was streaming.
      expect(aborted[0].upstream_status).toBe(200);
      // Client got cut off — served 499.
      expect(aborted[0].served_status).toBe(499);
    } finally {
      await proxy.kill();
      await upstream.close();
    }
  });
});
