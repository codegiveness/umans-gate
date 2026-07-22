// Integration test for ticket 07: WS broadcast on usage-sample / usage-event writes.
// Spawns the real proxy + a mock /v1/usage upstream, opens a WS client on
// /dashboard/ws, then drives the upstream through a sample change and a
// tuple transition. Asserts the proxy broadcasts `usage-sample` and
// `usage-event` messages so the dashboard can refresh the relevant view
// without a manual reload.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type CombinedMockHandle, startCombinedMock } from "./helpers/combined-mock";
import { type ProxyHandle, startProxy } from "./helpers/proxy";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface WsMsg {
  type: string;
  [k: string]: unknown;
}

/** Open a WS client on /dashboard/ws, collect messages into an array. */
function openWs(url: string, onMsg: (m: WsMsg) => void): WebSocket {
  const ws = new WebSocket(url);
  ws.onmessage = (e: MessageEvent<string>) => {
    try {
      onMsg(JSON.parse(e.data) as WsMsg);
    } catch {
      // ignore non-JSON frames
    }
  };
  return ws;
}

/** Wait for at least one message matching predicate, with timeout. */
async function waitForMsg(
  ws: WebSocket,
  predicate: (m: WsMsg) => boolean,
  timeoutMs = 5000,
): Promise<WsMsg> {
  const start = Date.now();
  return new Promise<WsMsg>((resolve, reject) => {
    const timer = setInterval(() => {
      if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error("timeout waiting for WS message"));
      }
    }, 50);
    const orig = ws.onmessage;
    ws.onmessage = (e: MessageEvent<string>) => {
      try {
        const msg = JSON.parse(e.data) as WsMsg;
        if (predicate(msg)) {
          clearInterval(timer);
          ws.onmessage = orig;
          resolve(msg);
        } else {
          // forward to the original handler so the recorder keeps running
          orig?.call(ws, e);
        }
      } catch {
        // ignore
      }
    };
  });
}

describe("Integration: usage WS broadcast (ticket 07)", () => {
  let upstream: CombinedMockHandle;
  let proxy: ProxyHandle;
  let ws: WebSocket;
  const messages: WsMsg[] = [];

  beforeAll(async () => {
    upstream = startCombinedMock({ limit: 8, hardCap: 16, planName: "Code Pro" });
    proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      umansApiKey: "test-key",
      dashboardToken: "test-token",
      STAMP_CACHE_TTL_ENABLED: "false",
      WARMER_ENABLED: "false",
    });
    // Connect WS before driving any state changes so we capture the very
    // first broadcast after the next poll.
    const wsUrl = `ws://127.0.0.1:${proxy.port}/dashboard/ws?token=test-token`;
    ws = openWs(wsUrl, (m) => {
      messages.push(m);
    });
    // Wait for WS open.
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("ws open timeout")), 5000);
      ws.onopen = () => {
        clearTimeout(t);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(t);
        reject(new Error("ws error"));
      };
    });
    // Let a few polls fire on the default normal state (seeds detector).
    await sleep(800);
  }, 15_000);

  afterAll(async () => {
    try {
      ws.close();
    } catch {
      // ignore
    }
    await proxy.kill();
    await upstream.close();
    await sleep(100);
  });

  test("usage-sample broadcast fires when a new sample is written", async () => {
    // The default mock returns an identical /v1/usage body on every poll, so
    // the writer coalesces and does not broadcast. Mutate tokens so the next
    // poll produces a different ambient body → must trigger a write and a
    // `usage-sample` WS message.
    upstream.setTokens({ tokensIn: 1234, tokensOut: 567, tokensCached: 89 });
    const msg = await waitForMsg(ws, (m) => m.type === "usage-sample", 5000);
    expect(msg.type).toBe("usage-sample");
    // Minimal shape — must carry dayUtc so the dashboard knows which day
    // to refresh. tupleKind is not required for samples.
    expect(typeof msg.dayUtc).toBe("string");
    expect((msg.dayUtc as string).length).toBe(10); // YYYY-MM-DD
  });

  test("usage-event broadcast fires when a tuple transition occurs", async () => {
    // Trigger a priority-low onset.
    upstream.setPriority({
      low: true,
      boxedUntil: Date.now() + 60_000,
      reason: "hard_cap_hit",
    });
    const msg = await waitForMsg(ws, (m) => m.type === "usage-event", 5000);
    expect(msg.type).toBe("usage-event");
    // Minimal shape — must carry dayUtc + tupleKind so the dashboard knows
    // which view to refresh.
    expect(typeof msg.dayUtc).toBe("string");
    expect(msg.tupleKind === "priority" || msg.tupleKind === "service_mode").toBe(true);
  });

  test("broadcasts do NOT include the full sample/event payload (dirty-only)", () => {
    // Filter to usage broadcasts received during this run.
    const usageMsgs = messages.filter((m) => m.type === "usage-sample" || m.type === "usage-event");
    expect(usageMsgs.length).toBeGreaterThan(0);
    // A dirty notification should not carry full ambient payload (tokens_in,
    // priority_low, etc.). It may carry type, dayUtc, and (for events) tupleKind.
    for (const m of usageMsgs) {
      const keys = Object.keys(m).sort();
      if (m.type === "usage-sample") {
        // Allowed: type, dayUtc. (Fetched_at may optionally be present as a
        // freshness hint, but no ambient state.)
        for (const k of keys) {
          expect(["type", "dayUtc", "fetchedAt"]).toContain(k);
        }
      } else {
        // usage-event: type, dayUtc, tupleKind (+ optionally transition, fetchedAt).
        for (const k of keys) {
          expect(["type", "dayUtc", "tupleKind", "transition", "fetchedAt"]).toContain(k);
        }
      }
    }
  });

  test("type:gate broadcast carries priorityBudgetSummary when upstream returns priority_budget", async () => {
    upstream.setPriorityBudget([
      {
        category: "frontier",
        label: "Frontier",
        models: ["umans-glm-5.2"],
        used_pct: 87,
        over_budget_today: false,
        mode: "normal",
        resets_at: null,
      },
      {
        category: "sonnet",
        label: "Sonnet",
        models: ["umans-sonnet"],
        used_pct: 42,
        over_budget_today: false,
        mode: "normal",
        resets_at: null,
      },
    ]);
    const msg = await waitForMsg(
      ws,
      (m) =>
        m.type === "gate" &&
        (m.stats as Record<string, unknown>)?.priorityBudgetSummary !== undefined,
      5000,
    );
    const stats = msg.stats as Record<string, unknown>;
    const summary = stats.priorityBudgetSummary as Record<string, unknown> | null;
    expect(summary).not.toBeNull();
    expect(summary?.category).toBe("frontier");
    expect(summary?.usedPct).toBe(87);
  });

  test("type:gate broadcast carries priorityBudgetSummary: null when upstream omits priority_budget", async () => {
    upstream.setPriorityBudget(null);
    const msg = await waitForMsg(
      ws,
      (m) =>
        m.type === "gate" && (m.stats as Record<string, unknown>)?.priorityBudgetSummary === null,
      5000,
    );
    const stats = msg.stats as Record<string, unknown>;
    expect(stats.priorityBudgetSummary).toBeNull();
  });
});
