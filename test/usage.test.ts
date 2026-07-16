import { Database } from "bun:sqlite";
import { expect, mock, test } from "bun:test";
import {
  accountCaptureUsage,
  accountCapturesUsage,
  getDailyUsage,
  migrateEconomicsSchema,
} from "../src/economics.js";
import { UmansUsageClient } from "../src/usage.js";
import { buildSnapshot, failSafeSnapshot } from "../src/usage/parser.js";

const baseConfig = {
  target: "https://api.code.umans.ai",
  umansApiKey: "sk-test-key",
  usageRefreshMs: 5000,
};

const validRawResponse = {
  user_id: "test-user-123",
  plan: { display_name: "Code Max", slug: "code_max" },
  limits: {
    requests: { limit: 200, hard_cap: 400, burst_pct: 1.0, window_seconds: 18000 },
    concurrency: { limit: 4, hard_cap: 8, burst_pct: 1.0 },
  },
  window: {
    started_at: "2026-07-16T04:51:53.756363+00:00",
    resets_at: "2026-07-16T09:51:53.756363+00:00",
    remaining_minutes: 206,
  },
  usage: {
    requests_in_window: 48,
    weighted_in_window: 24.0,
    remaining_requests: 152,
    weighted_remaining_requests: 76,
    concurrent_sessions: 1,
    weighted_concurrent_sessions: 0.5,
    tokens_in: 1200000,
    tokens_out: 340000,
    tokens_cached: 50000,
    priority: { low: false, boxed_until: null, reason: null },
    service_mode: { current: "interactive", resets_at: null },
  },
};

test("getSnapshot with no fetch returns fail-safe worst-case", () => {
  const client = new UmansUsageClient(baseConfig);
  const snap = client.getSnapshot();
  expect(snap.ok).toBe(false);
  expect(snap.plan).toBe("unknown");
  expect(snap.priorityLow).toBe(true);
  expect(snap.concurrentSessions).toBe(0);
  expect(snap.concurrencySoftLimit).toBe(1);
  expect(snap.concurrencyHardCap).toBe(1);
});

test("successful refresh populates snapshot with ok=true", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(
    async () => new Response(JSON.stringify(validRawResponse), { status: 200 }),
  ) as unknown as typeof fetch;
  try {
    const client = new UmansUsageClient(baseConfig);
    await client.refresh();
    const snap = client.getSnapshot();
    expect(snap.ok).toBe(true);
    expect(snap.plan).toBe("Code Max");
    expect(snap.concurrencySoftLimit).toBe(4);
    expect(snap.concurrencyHardCap).toBe(8);
    expect(snap.requestsInWindow).toBe(48);
    expect(snap.requestsRemaining).toBe(152);
    expect(snap.priorityLow).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetch failure with no LKG returns worst-case with ok=false", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async () => {
    throw new Error("network error");
  }) as unknown as typeof fetch;
  try {
    const client = new UmansUsageClient(baseConfig);
    await client.refresh();
    const snap = client.getSnapshot();
    expect(snap.ok).toBe(false);
    expect(snap.priorityLow).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetch failure with LKG keeps last snapshot but marks ok=false", async () => {
  const callCount = { v: 0 };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async () => {
    callCount.v++;
    if (callCount.v === 1) {
      return new Response(JSON.stringify(validRawResponse), { status: 200 });
    }
    throw new Error("network error");
  }) as unknown as typeof fetch;
  try {
    const client = new UmansUsageClient(baseConfig);
    await client.refresh();
    expect(client.getSnapshot().ok).toBe(true);
    await client.refresh();
    const snap = client.getSnapshot();
    expect(snap.ok).toBe(false);
    expect(snap.plan).toBe("Code Max");
    expect(snap.concurrencySoftLimit).toBe(4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HTTP 401 triggers fail-safe path", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(
    async () => new Response("Unauthorized", { status: 401 }),
  ) as unknown as typeof fetch;
  try {
    const client = new UmansUsageClient(baseConfig);
    await client.refresh();
    const snap = client.getSnapshot();
    expect(snap.ok).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("start without API key is a no-op", () => {
  const client = new UmansUsageClient({ ...baseConfig, umansApiKey: null });
  client.start();
  // No timer set, no crash
  client.stop();
});

test("onChange callback fires on snapshot change", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(
    async () => new Response(JSON.stringify(validRawResponse), { status: 200 }),
  ) as unknown as typeof fetch;
  try {
    const client = new UmansUsageClient(baseConfig);
    let calls = 0;
    client.onChange(() => {
      calls++;
    });
    await client.refresh();
    expect(calls).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Code Pro plan detected correctly", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(
    async () =>
      new Response(JSON.stringify({ ...validRawResponse, plan: { display_name: "Code Pro" } }), {
        status: 200,
      }),
  ) as unknown as typeof fetch;
  try {
    const client = new UmansUsageClient(baseConfig);
    await client.refresh();
    const snap = client.getSnapshot();
    expect(snap.plan).toBe("Code Pro");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Code Max (Founding Seat) variant is classified as Code Max", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(
    async () =>
      new Response(
        JSON.stringify({ ...validRawResponse, plan: { display_name: "Code Max (Founding Seat)" } }),
        { status: 200 },
      ),
  ) as unknown as typeof fetch;
  try {
    const client = new UmansUsageClient(baseConfig);
    await client.refresh();
    const snap = client.getSnapshot();
    expect(snap.plan).toBe("Code Max");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Code Pro (Annual) variant is classified as Code Pro", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(
    async () =>
      new Response(
        JSON.stringify({ ...validRawResponse, plan: { display_name: "Code Pro (Annual)" } }),
        { status: 200 },
      ),
  ) as unknown as typeof fetch;
  try {
    const client = new UmansUsageClient(baseConfig);
    await client.refresh();
    const snap = client.getSnapshot();
    expect(snap.plan).toBe("Code Pro");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("buildSnapshot parses service_mode correctly", () => {
  const raw = {
    ...validRawResponse,
    usage: {
      ...validRawResponse.usage,
      service_mode: { current: "degraded", resets_at: "2026-07-16T12:00:00Z" },
    },
  };
  const snap = buildSnapshot(raw, true, 8, 4);
  expect(snap.serviceMode.current).toBe("degraded");
  expect(snap.serviceMode.resetsAt).toBe(Date.parse("2026-07-16T12:00:00Z"));
});

test("buildSnapshot defaults service_mode when absent", () => {
  const { service_mode: _, ...usageWithoutServiceMode } = validRawResponse.usage;
  const raw = { ...validRawResponse, usage: usageWithoutServiceMode };
  const snap = buildSnapshot(raw, true, 8, 4);
  expect(snap.serviceMode.current).toBe("normal");
  expect(snap.serviceMode.resetsAt).toBeNull();
});

test("failSafeSnapshot sets service_mode to normal", () => {
  const snap = failSafeSnapshot();
  expect(snap.serviceMode.current).toBe("normal");
  expect(snap.serviceMode.resetsAt).toBeNull();
});

test("buildSnapshot converts ISO date strings to epoch ms", () => {
  const isoBoxed = "2026-07-16T15:05:04.659189+00:00";
  const isoDemoted = "2026-07-16T16:00:00Z";
  const raw = {
    ...validRawResponse,
    usage: {
      ...validRawResponse.usage,
      priority: {
        low: true,
        boxed_until: isoBoxed,
        reason: "rate limit",
        units_demoted: true,
        demoted_until: isoDemoted,
      },
    },
  };
  const snap = buildSnapshot(raw, true, 8, 4);
  expect(snap.boxedUntil).toBe(Date.parse(isoBoxed));
  expect(snap.demotedUntil).toBe(Date.parse(isoDemoted));
});

test("buildSnapshot captures enriched fields", () => {
  const snap = buildSnapshot(validRawResponse, true, 8, 4);
  expect(snap.userId).toBe("test-user-123");
  expect(snap.planSlug).toBe("code_max");
  expect(snap.tokensIn).toBe(1200000);
  expect(snap.tokensOut).toBe(340000);
  expect(snap.tokensCached).toBe(50000);
  expect(snap.weightedRequestsInWindow).toBe(24.0);
  expect(snap.windowRemainingMinutes).toBe(206);
  expect(snap.windowStartedAt).toBe(Date.parse("2026-07-16T04:51:53.756363+00:00"));
  expect(snap.windowResetsAt).toBe(Date.parse("2026-07-16T09:51:53.756363+00:00"));
});

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS captures (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      model            TEXT,
      input_tokens     INTEGER,
      output_tokens    INTEGER,
      cache_read_tokens      INTEGER,
      cache_creation_tokens  INTEGER,
      thinking_tokens        INTEGER,
      usage_missing          INTEGER DEFAULT 0,
      started_at             INTEGER,
      usage_accounted        INTEGER DEFAULT 0
    );
  `);
  migrateEconomicsSchema(db);
  return db;
}

function insertCapture(
  db: Database,
  params: {
    model: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_tokens?: number | null;
    cache_creation_tokens?: number | null;
    thinking_tokens?: number | null;
    usage_missing?: number;
    started_at?: number | null;
  },
): number {
  const result = db
    .prepare(
      `INSERT INTO captures (model, input_tokens, output_tokens, cache_read_tokens,
         cache_creation_tokens, thinking_tokens, usage_missing, started_at)
       VALUES ($model, $input, $output, $cache_read, $cache_creation, $thinking, $usage_missing, $started_at)`,
    )
    .run({
      $model: params.model,
      $input: params.input_tokens,
      $output: params.output_tokens,
      $cache_read: params.cache_read_tokens ?? null,
      $cache_creation: params.cache_creation_tokens ?? null,
      $thinking: params.thinking_tokens ?? null,
      $usage_missing: params.usage_missing ?? 0,
      $started_at: params.started_at ?? Date.now(),
    });
  return Number(result.lastInsertRowid);
}

function snapshotDailyUsage(db: Database) {
  return getDailyUsage(db, 100).map((r) => ({
    model: r.model,
    requests: r.requests,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    cost_total: Math.round(r.cost_total * 1e9) / 1e9,
  }));
}

test("accountCapturesUsage with empty array is a no-op", () => {
  const db = createTestDb();
  accountCapturesUsage(db, []);
  expect(getDailyUsage(db)).toHaveLength(0);
  db.close();
});

test("accountCapturesUsage produces same result as per-capture accountCaptureUsage", () => {
  const captures = [
    { model: "umans-glm-5.2", input_tokens: 1000, output_tokens: 500 },
    { model: "umans-glm-5.2", input_tokens: 2000, output_tokens: 300 },
    { model: "umans-flash", input_tokens: 500, output_tokens: 100 },
    { model: "umans-coder", input_tokens: 800, output_tokens: 200, cache_read_tokens: 400 },
  ];

  const dbPerCapture = createTestDb();
  const ids1: number[] = [];
  for (const c of captures) {
    ids1.push(insertCapture(dbPerCapture, c));
  }
  dbPerCapture.transaction(() => {
    for (const id of ids1) {
      accountCaptureUsage(dbPerCapture, id);
    }
  })();
  const resultPerCapture = snapshotDailyUsage(dbPerCapture);
  dbPerCapture.close();

  const dbBatch = createTestDb();
  const ids2: number[] = [];
  for (const c of captures) {
    ids2.push(insertCapture(dbBatch, c));
  }
  dbBatch.transaction(() => {
    accountCapturesUsage(dbBatch, ids2);
  })();
  const resultBatch = snapshotDailyUsage(dbBatch);
  dbBatch.close();

  expect(resultBatch).toEqual(resultPerCapture);
});

test("accountCapturesUsage is idempotent", () => {
  const db = createTestDb();
  const ids: number[] = [];
  ids.push(insertCapture(db, { model: "umans-glm-5.2", input_tokens: 1000, output_tokens: 500 }));
  ids.push(insertCapture(db, { model: "umans-flash", input_tokens: 200, output_tokens: 100 }));

  db.transaction(() => {
    accountCapturesUsage(db, ids);
  })();

  const afterFirst = snapshotDailyUsage(db);

  db.transaction(() => {
    accountCapturesUsage(db, ids);
  })();

  const afterSecond = snapshotDailyUsage(db);
  expect(afterSecond).toEqual(afterFirst);
  db.close();
});

test("accountCapturesUsage skips captures with missing usage but marks them accounted", () => {
  const db = createTestDb();
  const id1 = insertCapture(db, {
    model: "umans-glm-5.2",
    input_tokens: 1000,
    output_tokens: 500,
    usage_missing: 0,
  });
  const id2 = insertCapture(db, {
    model: "umans-flash",
    input_tokens: 200,
    output_tokens: 100,
    usage_missing: 1,
  });

  db.transaction(() => {
    accountCapturesUsage(db, [id1, id2]);
  })();

  const usage = getDailyUsage(db);
  expect(usage).toHaveLength(1);
  expect(usage[0].model).toBe("umans-glm-5.2");
  const accounted = db
    .prepare("SELECT usage_accounted FROM captures WHERE id IN (?, ?) ORDER BY id")
    .all(id1, id2) as Array<{ usage_accounted: number }>;
  expect(accounted.every((r) => r.usage_accounted === 1)).toBe(true);
  db.close();
});
