import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureDB } from "../src/db.js";
import { RewriteIdExperiment } from "../src/experiments/rewrite-ids.js";

const tempDirs: string[] = [];

function makeDb(): CaptureDB {
  const dir = mkdtempSync(join(tmpdir(), "rewrite-test-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "test.db");
  return new CaptureDB({ dbPath, maxCaptures: 100, compressionEnabled: false });
}

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // already cleaned
    }
  }
});

const OPENCODE_HEADERS = {
  "user-agent": "opencode/1.18.2 ai-sdk/provider-utils/4.0.27 runtime/bun/1.3.14",
  "x-session-id": "ses_094245ee8ffeE1vAORqPmsfxAI",
  "x-session-affinity": "ses_094245ee8ffeE1vAORqPmsfxAI",
};

const CLAUDE_CODE_HEADERS = {
  "user-agent": "claude-code/1.0.0",
  "x-session-id": "ses_abc123",
};

test("detects opencode harness from user-agent", () => {
  const db = makeDb();
  const exp = new RewriteIdExperiment(db, { ttlMs: 60000 });
  const { harness, sessionId } = exp.detectAndExtractSession(OPENCODE_HEADERS);
  expect(harness).toBe("opencode");
  expect(sessionId).toBe("ses_094245ee8ffeE1vAORqPmsfxAI");
});

test("detects claude-code harness", () => {
  const db = makeDb();
  const exp = new RewriteIdExperiment(db, { ttlMs: 60000 });
  const { harness } = exp.detectAndExtractSession(CLAUDE_CODE_HEADERS);
  expect(harness).toBe("claude-code");
});

test("isEligible returns true only for opencode with session id", () => {
  const db = makeDb();
  const exp = new RewriteIdExperiment(db, { ttlMs: 60000 });
  expect(exp.isEligible("opencode", "ses_abc")).toBe(true);
  expect(exp.isEligible("claude-code", "ses_abc")).toBe(false);
  expect(exp.isEligible("opencode", null)).toBe(false);
});

test("getOrCreateSession creates new session with salt", () => {
  const db = makeDb();
  const exp = new RewriteIdExperiment(db, { ttlMs: 60000 });
  const state = exp.getOrCreateSession("ses_test1", "opencode", 1000, "err");
  expect(state.salt.length).toBe(32);
  expect(state.saltVersion).toBe(1);
  expect(state.consecutive502s).toBe(1);

  const existing = db.getIdRewriteSession("ses_test1");
  expect(existing).not.toBeNull();
  expect(existing?.salt).toBe(state.salt);
  expect(existing?.saltVersion).toBe(1);
});

test("getOrCreateSession returns existing if not expired", () => {
  const db = makeDb();
  const exp = new RewriteIdExperiment(db, { ttlMs: 60000 });
  const first = exp.getOrCreateSession("ses_test2", "opencode", 1000, "err");
  const second = exp.getOrCreateSession("ses_test2", "opencode", 2000, "err2");
  expect(second.salt).toBe(first.salt);
  expect(second.saltVersion).toBe(first.saltVersion);
  expect(second.consecutive502s).toBe(2);
});

test("escalate rotates salt and increments version", () => {
  const db = makeDb();
  const exp = new RewriteIdExperiment(db, { ttlMs: 60000 });
  const original = exp.getOrCreateSession("ses_test3", "opencode", 1000, "err");
  const escalated = exp.escalate("ses_test3");

  expect(escalated.salt).not.toBe(original.salt);
  expect(escalated.saltVersion).toBe(original.saltVersion + 1);
  expect(escalated.consecutive502s).toBe(original.consecutive502s);
});

test("rewriteBody produces deterministic tool_use_id mappings", () => {
  const db = makeDb();
  const exp = new RewriteIdExperiment(db, { ttlMs: 60000 });
  const sessionId = "ses_test4";
  const state = exp.getOrCreateSession(sessionId, "opencode", 1000, "err");

  const body = JSON.stringify({
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "call_9102b7e01c46449c96d63f41" }] },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_9102b7e01c46449c96d63f41" }],
      },
    ],
  });

  const result1 = exp.rewriteBody(body, OPENCODE_HEADERS, sessionId, state);
  expect(result1.rewritten).toBe(true);
  expect(result1.toolUseIdsRewritten).toBe(1);
  expect(result1.fieldsRewritten).toContain("tool_use_ids");

  const result2 = exp.rewriteBody(body, OPENCODE_HEADERS, sessionId, state);
  expect(result2.body).toBe(result1.body);
});

test("rewriteHeaders replaces x-session-id and x-session-affinity", () => {
  const db = makeDb();
  const exp = new RewriteIdExperiment(db, { ttlMs: 60000 });
  const sessionId = "ses_test5";
  const headersWithSid = {
    "user-agent": "opencode/1.18.2",
    "x-session-id": sessionId,
    "x-session-affinity": sessionId,
  };
  const state = exp.getOrCreateSession(sessionId, "opencode", 1000, "err");

  const { headers, newSessionId } = exp.rewriteHeaders(headersWithSid, sessionId, state);
  expect(newSessionId).not.toBeNull();
  const newSid = newSessionId as string;
  expect(newSid).not.toBe(sessionId);
  expect(headers["x-session-id"]).toBe(newSid);
  expect(headers["x-session-affinity"]).toBe(newSid);
});

test("mappings persist across resume (same salt → same rewritten ids)", () => {
  const db = makeDb();
  const exp = new RewriteIdExperiment(db, { ttlMs: 60000 });
  const sessionId = "ses_test6";
  const originalId = "call_9102b7e01c46449c96d63f41";

  const state1 = exp.getOrCreateSession(sessionId, "opencode", 1000, "err");
  const body = JSON.stringify({ tool_use_id: originalId });
  const result1 = exp.rewriteBody(body, OPENCODE_HEADERS, sessionId, state1);

  const state2 = db.getIdRewriteSession(sessionId)!;
  const result2 = exp.rewriteBody(body, OPENCODE_HEADERS, sessionId, {
    salt: state2.salt,
    saltVersion: state2.saltVersion,
    consecutive502s: state2.consecutive502s,
  });

  expect(result2.body).toBe(result1.body);
});

test("escalation changes rewritten ids", () => {
  const db = makeDb();
  const exp = new RewriteIdExperiment(db, { ttlMs: 60000 });
  const sessionId = "ses_test7";
  const originalId = "call_9102b7e01c46449c96d63f41";

  const state1 = exp.getOrCreateSession(sessionId, "opencode", 1000, "err");
  const body = JSON.stringify({ tool_use_id: originalId });
  const result1 = exp.rewriteBody(body, OPENCODE_HEADERS, sessionId, state1);

  const state2 = exp.escalate(sessionId);
  const result2 = exp.rewriteBody(body, OPENCODE_HEADERS, sessionId, state2);

  expect(result2.body).not.toBe(result1.body);
  expect(result2.saltVersion).toBe(state1.saltVersion + 1);
});

test("shouldEscalate returns true on even consecutive 502s >= 2", () => {
  const db = makeDb();
  const exp = new RewriteIdExperiment(db, { ttlMs: 60000 });
  expect(exp.shouldEscalate(0)).toBe(false);
  expect(exp.shouldEscalate(1)).toBe(false);
  expect(exp.shouldEscalate(2)).toBe(true);
  expect(exp.shouldEscalate(3)).toBe(false);
  expect(exp.shouldEscalate(4)).toBe(true);
});

test("pruneExpired removes expired sessions", async () => {
  const db = makeDb();
  const exp = new RewriteIdExperiment(db, { ttlMs: 1 });
  exp.getOrCreateSession("ses_expired", "opencode", 1000, "err");
  await new Promise((r) => setTimeout(r, 10));

  const pruned = exp.pruneExpired();
  expect(pruned).toBe(1);

  const session = db.getIdRewriteSession("ses_expired");
  expect(session).toBeNull();
});

test("clearSession removes session and mappings", () => {
  const db = makeDb();
  const exp = new RewriteIdExperiment(db, { ttlMs: 60000 });
  const sessionId = "ses_test8";
  const state = exp.getOrCreateSession(sessionId, "opencode", 1000, "err");
  exp.rewriteBody(
    JSON.stringify({ id: "call_abc123def456ghi789jkl012" }),
    OPENCODE_HEADERS,
    sessionId,
    state,
  );

  exp.clearSession(sessionId);
  expect(db.getIdRewriteSession(sessionId)).toBeNull();
});

test("escalation fires on 2nd consecutive 502 and rotates salt", () => {
  const db = makeDb();
  const exp = new RewriteIdExperiment(db, { ttlMs: 60000 });
  const sessionId = "ses_escalation";

  const state1 = exp.getOrCreateSession(sessionId, "opencode", 1000, "err1");
  expect(state1.consecutive502s).toBe(1);
  expect(exp.shouldEscalate(state1.consecutive502s)).toBe(false);

  const state2 = exp.getOrCreateSession(sessionId, "opencode", 2000, "err2");
  expect(state2.consecutive502s).toBe(2);
  expect(exp.shouldEscalate(state2.consecutive502s)).toBe(true);

  const escalated = exp.escalate(sessionId);
  expect(escalated.salt).not.toBe(state1.salt);
  expect(escalated.saltVersion).toBe(state1.saltVersion + 1);

  const dbState = db.getIdRewriteSession(sessionId);
  expect(dbState?.consecutive502s).toBe(2);
  expect(dbState?.saltVersion).toBe(2);
});

test("escalation produces different rewritten IDs across salt versions", () => {
  const db = makeDb();
  const exp = new RewriteIdExperiment(db, { ttlMs: 60000 });
  const sessionId = "ses_escalation2";
  const toolId = "call_9102b7e01c46449c96d63f41";
  const body = JSON.stringify({ tool_use_id: toolId });

  const state1 = exp.getOrCreateSession(sessionId, "opencode", 1000, "err");
  const result1 = exp.rewriteBody(body, {}, sessionId, state1);

  exp.getOrCreateSession(sessionId, "opencode", 2000, "err2");
  const state2 = exp.escalate(sessionId);
  const result2 = exp.rewriteBody(body, {}, sessionId, state2);

  expect(result1.body).not.toBe(result2.body);
  expect(result1.saltVersion).toBe(1);
  expect(result2.saltVersion).toBe(2);
});

test("rewrites toolu_ prefix (Anthropic format)", () => {
  const db = makeDb();
  const exp = new RewriteIdExperiment(db, { ttlMs: 60000 });
  const sessionId = "ses_toolu";
  const toolId = "toolu_9102b7e01c46449c96d63f41";
  const body = JSON.stringify({ id: toolId });

  const state = exp.getOrCreateSession(sessionId, "opencode", 1000, "err");
  const result = exp.rewriteBody(body, {}, sessionId, state);

  expect(result.rewritten).toBe(true);
  expect(result.toolUseIdsRewritten).toBe(1);
  expect(result.body).not.toContain(toolId);
  expect(result.body).toContain("toolu_");
});

test("audit row does not break ring buffer eviction", () => {
  const dir = mkdtempSync(join(tmpdir(), "rewrite-ringbuf-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "test.db");
  const db = new CaptureDB({ dbPath, maxCaptures: 3, compressionEnabled: false });

  const capId1 = db.startCapture({
    $method: "POST",
    $path: "/v1/messages",
    $url: "http://up",
    $rh: "{}",
    $rb: "{}",
    $rs: 2,
    $st: Date.now(),
    $state: "enqueued",
    $inp: "http1.1",
    $outp: "http1.1",
  });

  db.recordIdRewriteAudit({
    captureId: capId1,
    sessionId: "ses_ringbuf",
    saltVersion: 1,
    fieldsRewritten: ["tool_use_ids"],
    toolUseIdsRewritten: 1,
  });

  for (let i = 0; i < 5; i++) {
    db.startCapture({
      $method: "POST",
      $path: "/v1/messages",
      $url: "http://up",
      $rh: "{}",
      $rb: "{}",
      $rs: 2,
      $st: Date.now(),
      $state: "enqueued",
      $inp: "http1.1",
      $outp: "http1.1",
    });
  }

  const count = db.rawDb.prepare("SELECT COUNT(*) as c FROM captures").get() as { c: number };
  expect(count.c).toBeLessThanOrEqual(3);
});

test("rewritten tool_use_ids have single underscore (no double underscore)", () => {
  const db = makeDb();
  const exp = new RewriteIdExperiment(db, { ttlMs: 60000 });
  const sessionId = "ses_single_underscore";
  const callId = "call_9102b7e01c46449c96d63f41";
  const tooluId = "toolu_9102b7e01c46449c96d63f41";
  const body = JSON.stringify({ a: callId, b: tooluId });

  const state = exp.getOrCreateSession(sessionId, "opencode", 1000, "err");
  const result = exp.rewriteBody(body, {}, sessionId, state);

  expect(result.rewritten).toBe(true);
  expect(result.body).not.toContain("call__");
  expect(result.body).not.toContain("toolu__");
  expect(result.body).toMatch(/call_[a-f0-9]{24}/);
  expect(result.body).toMatch(/toolu_[a-f0-9]{24}/);
});

test("expired session creates fresh salt matching DB", async () => {
  const db = makeDb();
  const exp = new RewriteIdExperiment(db, { ttlMs: 50 });
  const sessionId = "ses_expiry";

  const state1 = exp.getOrCreateSession(sessionId, "opencode", 1000, "err1");
  expect(state1.consecutive502s).toBe(1);
  expect(state1.saltVersion).toBe(1);

  await new Promise((r) => setTimeout(r, 60));

  const state2 = exp.getOrCreateSession(sessionId, "opencode", 2000, "err2");
  expect(state2.consecutive502s).toBe(1);
  expect(state2.saltVersion).toBe(1);
  expect(state2.salt).not.toBe(state1.salt);

  const dbState = db.getIdRewriteSession(sessionId);
  expect(dbState?.salt).toBe(state2.salt);
  expect(dbState?.consecutive502s).toBe(1);
  expect(dbState?.saltVersion).toBe(1);
});
