import { createHash, randomBytes } from "node:crypto";
import type { CaptureDB } from "../db.js";

export type Harness = "opencode" | "claude-code" | "unknown";

export interface RewriteResult {
  rewritten: boolean;
  body: string;
  saltVersion: number;
  fieldsRewritten: string[];
  toolUseIdsRewritten: number;
  sessionId: string | null;
}

export interface RewriteSessionState {
  salt: string;
  saltVersion: number;
  consecutive502s: number;
}

const TOOL_USE_ID_PATTERN = /(?:call_|toolu_)[A-Za-z0-9]{24}/g;
const SESSION_ID_PATTERN = /^ses_[A-Za-z0-9]{16,}$/;

function extractPrefix(id: string): string {
  const match = id.match(/^(call|toolu)_/);
  return match ? match[1] : "call";
}

function generateSalt(): string {
  return randomBytes(16).toString("hex");
}

function deterministicRewrite(
  originalId: string,
  salt: string,
  saltVersion: number,
  prefix: string,
): string {
  const hash = createHash("sha256")
    .update(salt)
    .update(`${saltVersion}`)
    .update(originalId)
    .digest("hex");
  const truncated = hash.slice(0, 24);
  return `${prefix}_${truncated}`;
}

function detectHarness(headers: Record<string, string>): Harness {
  const ua = (headers["user-agent"] ?? "").toLowerCase();
  if (ua.includes("opencode")) return "opencode";
  if (ua.includes("claude-code") || ua.includes("claude code")) return "claude-code";
  return "unknown";
}

function extractSessionId(headers: Record<string, string>): string | null {
  const sid = headers["x-session-id"] ?? headers["x-session-affinity"] ?? null;
  if (sid && SESSION_ID_PATTERN.test(sid)) return sid;
  return null;
}

export interface RewriteOptions {
  ttlMs: number;
}

export class RewriteIdExperiment {
  constructor(
    private db: CaptureDB,
    private opts: RewriteOptions,
  ) {}

  detectAndExtractSession(headers: Record<string, string>): {
    harness: Harness;
    sessionId: string | null;
  } {
    return {
      harness: detectHarness(headers),
      sessionId: extractSessionId(headers),
    };
  }

  isEligible(harness: Harness, sessionId: string | null): boolean {
    return harness === "opencode" && sessionId !== null;
  }

  getOrCreateSession(
    sessionId: string,
    harness: Harness,
    requestSize: number | null,
    errorBody: string | null,
  ): RewriteSessionState {
    const existing = this.db.getIdRewriteSession(sessionId);
    if (existing && existing.expiresAt > Date.now()) {
      this.db.recordIdRewriteSession({
        sessionId,
        harness,
        salt: existing.salt,
        ttlMs: this.opts.ttlMs,
        requestSize,
        errorBody,
      });
      const updated = this.db.getIdRewriteSession(sessionId);
      return {
        salt: existing.salt,
        saltVersion: existing.saltVersion,
        consecutive502s: updated?.consecutive502s ?? existing.consecutive502s,
      };
    }
    if (existing) {
      this.db.clearIdRewriteSession(sessionId);
    }
    const salt = generateSalt();
    this.db.recordIdRewriteSession({
      sessionId,
      harness,
      salt,
      ttlMs: this.opts.ttlMs,
      requestSize,
      errorBody,
    });
    return { salt, saltVersion: 1, consecutive502s: 1 };
  }

  escalate(sessionId: string): RewriteSessionState {
    const existing = this.db.getIdRewriteSession(sessionId);
    if (!existing) {
      const salt = generateSalt();
      this.db.recordIdRewriteSession({
        sessionId,
        harness: "opencode",
        salt,
        ttlMs: this.opts.ttlMs,
        requestSize: null,
        errorBody: null,
      });
      return { salt, saltVersion: 1, consecutive502s: 1 };
    }
    const newSalt = generateSalt();
    this.db.escalateRewriteSalt(sessionId, newSalt);
    const updated = this.db.getIdRewriteSession(sessionId);
    return {
      salt: newSalt,
      saltVersion: updated?.saltVersion ?? existing.saltVersion,
      consecutive502s: updated?.consecutive502s ?? existing.consecutive502s,
    };
  }

  rewriteBody(
    bodyText: string,
    headers: Record<string, string>,
    sessionId: string,
    state: RewriteSessionState,
  ): RewriteResult {
    const fieldsRewritten: string[] = [];
    let toolUseCount = 0;
    let result = bodyText;

    const sidHeader = headers["x-session-id"] ?? headers["x-session-affinity"];
    if (sidHeader && sidHeader === sessionId) {
      fieldsRewritten.push("x-session-id");
    }

    const toolUseIds = new Set<string>();
    const pattern = new RegExp(TOOL_USE_ID_PATTERN);
    for (let match = pattern.exec(bodyText); match !== null; match = pattern.exec(bodyText)) {
      toolUseIds.add(match[0]);
    }

    for (const originalId of toolUseIds) {
      const existing = this.db.getRewriteMapping(
        sessionId,
        originalId,
        "tool_use_id",
        state.saltVersion,
      );
      const rewrittenId =
        existing ??
        deterministicRewrite(originalId, state.salt, state.saltVersion, extractPrefix(originalId));
      if (!existing) {
        this.db.setRewriteMapping({
          sessionId,
          originalId,
          rewrittenId,
          idType: "tool_use_id",
          saltVersion: state.saltVersion,
        });
      }
      result = result.split(originalId).join(rewrittenId);
      toolUseCount++;
    }
    if (toolUseCount > 0) {
      fieldsRewritten.push("tool_use_ids");
    }

    return {
      rewritten: fieldsRewritten.length > 0,
      body: result,
      saltVersion: state.saltVersion,
      fieldsRewritten,
      toolUseIdsRewritten: toolUseCount,
      sessionId,
    };
  }

  rewriteHeaders(
    headers: Record<string, string>,
    sessionId: string,
    state: RewriteSessionState,
  ): { headers: Record<string, string>; newSessionId: string | null } {
    const out = { ...headers };
    let newSessionId: string | null = null;

    const sidKeys = ["x-session-id", "x-session-affinity"];
    for (const key of sidKeys) {
      const val = out[key];
      if (val && val === sessionId) {
        if (!newSessionId) {
          let mapped = this.db.getRewriteMapping(sessionId, val, "session_id", state.saltVersion);
          if (!mapped) {
            mapped = deterministicRewrite(val, state.salt, state.saltVersion, "ses");
            this.db.setRewriteMapping({
              sessionId,
              originalId: val,
              rewrittenId: mapped,
              idType: "session_id",
              saltVersion: state.saltVersion,
            });
          }
          newSessionId = mapped;
        }
        out[key] = newSessionId;
      }
    }

    return { headers: out, newSessionId };
  }

  clearSession(sessionId: string): void {
    this.db.clearIdRewriteSession(sessionId);
  }

  pruneExpired(): number {
    return this.db.pruneExpiredRewriteSessions();
  }

  shouldEscalate(consecutive502s: number): boolean {
    return consecutive502s >= 2 && consecutive502s % 2 === 0;
  }
}
