// Proxy handler — captures request/response, stamps TTL, forwards upstream.
// Tee's response stream so the client gets data immediately while capture
// accumulates in the background.

import type { CaptureDB } from "./db.js";
import {
  HOP,
  classify429,
  computeRequestWeight,
  decodeText,
  headersToObject,
  newSummary,
  redactHeaders,
  textDecoder,
  textEncoder,
} from "./helpers.js";
import type { GateError } from "./limiter/index.js";
import type { ConcurrencyGate } from "./limiter/index.js";
import { createLogger } from "./logger.js";

import { STAMP_ANTHROPIC_BETA_HEADER } from "./config.js";
import type { Harness, RewriteIdExperiment } from "./experiments/rewrite-ids.js";
import type { TtftWatchdogState } from "./experiments/ttft-watchdog-state.js";
import { extractModelName } from "./models/name.js";
import type { WriteQueue } from "./queue.js";
import type { SlidingWindowRateLimiter } from "./rate.js";
import {
  CacheTtlStep,
  STAMP_PIPELINE,
  type StampContext,
  parseJsonBody,
} from "./stamp-pipeline.js";
import type {
  CaptureConfig,
  ExperimentConfig,
  GateConfig,
  GateStats,
  ProtocolConfig,
  RequestMeta,
  ResponseMeta,
  StampConfig,
} from "./types.js";
import type { UsageMetrics } from "./usage-extract.js";

const log = createLogger("proxy");
import type { ModelsClient } from "./models.js";
import { extractUsage } from "./usage-extract.js";
import type { VisionHandoff } from "./vision/handoff.js";
import type { WsBroadcaster } from "./ws.js";

// ─── Stamp pipeline (table-driven dispatch) ────────────────────────────────

/**
 * Re-stamp cache_control TTL on the post-vision body.
 * Only CacheTtlStep runs here — thinking/maxTokens/outputConfig/reasoning
 * are NOT re-applied after vision injection.
 */
function stampPostVision(
  body: unknown,
  ctx: StampContext,
  reqBuf: Uint8Array,
): { reqBuf: Uint8Array; changed: boolean } {
  if (!CacheTtlStep.applies(ctx) || body === null || typeof body !== "object") {
    return { reqBuf, changed: false };
  }
  const changed = CacheTtlStep.apply(body, ctx);
  if (!changed) return { reqBuf, changed: false };
  return { reqBuf: textEncoder.encode(JSON.stringify(body)), changed: true };
}

/** Create the proxy request handler. */
export type RateLimiterRef = { current: SlidingWindowRateLimiter | null };

export function createProxyHandler(
  db: CaptureDB,
  ws: WsBroadcaster,
  queue: WriteQueue,
  config: StampConfig & CaptureConfig & GateConfig & ProtocolConfig & ExperimentConfig,
  gate: ConcurrencyGate,
  rateRef: RateLimiterRef,
  vision: VisionHandoff | null,
  models: ModelsClient,
  onTraffic?: () => void,
  rewriteExperiment?: RewriteIdExperiment | null,
  ttftState?: TtftWatchdogState | null,
  getGateStats?: () => GateStats,
) {
  async function attemptRewriteRetry(
    sessionId: string,
    harness: Harness,
    originalReqBuf: Uint8Array,
    originalHeaders: Record<string, string>,
    targetUrl: string,
    req: Request,
    cfg: ProtocolConfig & ExperimentConfig,
    experiment: RewriteIdExperiment,
    captureDb: CaptureDB,
    captureId: number,
    ttftController?: AbortController | null,
    forceEscalate?: boolean,
  ): Promise<Response | null> {
    const bodyText = decodeText(originalReqBuf);
    let state = experiment.getOrCreateSession(
      sessionId,
      harness,
      originalReqBuf.byteLength,
      bodyText.slice(0, 500),
    );

    if (forceEscalate || experiment.shouldEscalate(state.consecutive502s)) {
      state = experiment.escalate(sessionId);
      log.info("escalating ID rewrite salt", {
        captureId,
        sessionId,
        newVersion: state.saltVersion,
        consecutive502s: state.consecutive502s,
        forced: forceEscalate === true,
      });
    }

    const rewriteResult = experiment.rewriteBody(bodyText, originalHeaders, sessionId, state);
    const headerResult = experiment.rewriteHeaders(originalHeaders, sessionId, state);

    if (!rewriteResult.rewritten) {
      return null;
    }

    const retryReqBuf = textEncoder.encode(rewriteResult.body);
    const retryHeaders = { ...headerResult.headers };
    retryHeaders["content-length"] = String(retryReqBuf.byteLength);
    retryHeaders["accept-encoding"] = "identity";

    try {
      const upstreamSignal = ttftController
        ? AbortSignal.any([
            req.signal,
            ttftController.signal,
            AbortSignal.timeout(cfg.upstreamTimeoutMs),
          ])
        : AbortSignal.any([req.signal, AbortSignal.timeout(cfg.upstreamTimeoutMs)]);
      const retryResponse = await fetch(targetUrl, {
        method: req.method,
        headers: retryHeaders,
        body: retryReqBuf as BodyInit,
        protocol: cfg.upstreamProtocol as unknown as never,
        signal: upstreamSignal,
      });

      captureDb.recordIdRewriteAudit({
        captureId,
        sessionId,
        saltVersion: state.saltVersion,
        fieldsRewritten: rewriteResult.fieldsRewritten,
        toolUseIdsRewritten: rewriteResult.toolUseIdsRewritten,
      });

      if (retryResponse.status < 400) {
        log.info("ID rewrite retry succeeded", {
          captureId,
          sessionId,
          saltVersion: state.saltVersion,
          status: retryResponse.status,
        });
        experiment.clearSession(sessionId);
      } else if (retryResponse.status === 502 || retryResponse.status === 529) {
        log.warn("ID rewrite retry still got 502/529", {
          captureId,
          sessionId,
          saltVersion: state.saltVersion,
          status: retryResponse.status,
        });
      }

      return retryResponse;
    } catch (err) {
      log.warn("ID rewrite retry fetch failed", {
        captureId,
        sessionId,
        error: (err as Error).message,
      });
      return null;
    }
  }

  async function handleProxy(req: Request, url: URL): Promise<Response> {
    const startedAt = Date.now();
    const path = url.pathname + url.search;
    const targetUrl = config.target + path;

    const reqHeadersRaw = headersToObject(req.headers);
    const isOpenAi = url.pathname.includes(config.openaiPath);
    const isAnthropicMessages = !isOpenAi && url.pathname === "/v1/messages";

    // Claude Code stamp: ensure ?beta=true on /v1/messages requests.
    const stampBeta = config.stampClaudeCode && isAnthropicMessages;
    const targetUrlObj = new URL(targetUrl);
    const finalTargetUrl =
      stampBeta && targetUrlObj.searchParams.get("beta") !== "true"
        ? `${targetUrl}${targetUrl.includes("?") ? "&" : "?"}beta=true`
        : targetUrl;

    // --- Request body capture ---
    let reqBuf: Uint8Array | null = null;
    if (req.method !== "GET" && req.method !== "HEAD") {
      reqBuf = new Uint8Array(await req.arrayBuffer());
    }

    // Early exit if client already disconnected after sending the body.
    if (req.signal.aborted) {
      return new Response(null, { status: 499 });
    }

    // --- Stamp pipeline (TTL, AnthropicBody, OpenAiReasoning, TopK) ---
    // Non-critical: stamping is optimization, not correctness. If it fails,
    // forward the original body unchanged.
    let body: unknown = null;
    if (reqBuf && reqBuf.byteLength > 0) {
      try {
        const parsed = parseJsonBody(reqBuf, reqHeadersRaw);
        body = parsed.body;
      } catch (err) {
        log.warn("stamp pipeline failed, forwarding original body", {
          error: (err as Error).message,
          path: url.pathname,
        });
      }
    }

    const reqModelName = body ? (extractModelName(body) ?? null) : null;

    if (body && typeof body === "object" && body !== null) {
      try {
        const stampCtx: StampContext = {
          config,
          isOpenAi,
          headers: reqHeadersRaw,
          url,
          method: req.method,
          modelName: reqModelName ?? undefined,
        };
        let stampChanged = false;
        for (const step of STAMP_PIPELINE) {
          if (!step.applies(stampCtx)) continue;
          if (step.apply(body, stampCtx)) stampChanged = true;
        }
        if (stampChanged) {
          reqBuf = textEncoder.encode(JSON.stringify(body));
        }
      } catch (err) {
        log.warn("stamp pipeline failed, forwarding original body", {
          error: (err as Error).message,
          path: url.pathname,
        });
      }
    }

    // --- Forwarded request headers: strip hop-by-hop + host ---
    const fwdHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(reqHeadersRaw)) {
      if (HOP.has(k)) continue;
      fwdHeaders[k] = v;
    }

    // The proxy strips Content-Encoding from the upstream response and forwards
    // decoded bodies, so it must not advertise compression. Force identity on
    // every upstream request to stay responsible for the encoding contract.
    fwdHeaders["accept-encoding"] = "identity";

    if (stampBeta) {
      fwdHeaders["anthropic-beta"] = STAMP_ANTHROPIC_BETA_HEADER;
      fwdHeaders["anthropic-version"] = "2023-06-01";
    }

    // --- Insert capture row (early, so vision calls can link to it) ---
    let reqBodyText = reqBuf ? decodeText(reqBuf) : "";
    const reqMeta: RequestMeta = {
      method: req.method,
      path,
      request_size: reqBuf ? reqBuf.byteLength : 0,
      started_at: startedAt,
    };
    const capId = db.startCapture({
      $method: req.method,
      $path: path,
      $url: finalTargetUrl,
      $rh: JSON.stringify(redactHeaders(fwdHeaders)),
      $rb: reqBodyText,
      $rs: reqBuf ? reqBuf.byteLength : 0,
      $st: startedAt,
      $state: "enqueued",
      $inp: config.incomingProtocol,
      $outp: config.upstreamProtocol,
    });
    ws.broadcast({
      type: "new",
      capture: newSummary(capId, reqMeta, config, "enqueued", reqModelName),
    });

    // --- Vision handoff (image → text description) ---
    // Non-critical: vision is an optional feature. If it fails, forward
    // the original body unchanged.
    if (reqBuf && reqBuf.byteLength > 0 && vision) {
      try {
        if (!body) {
          try {
            const ct = reqHeadersRaw["content-type"] ?? "";
            if (ct.includes("json") || reqBuf[0] === 0x7b) {
              body = JSON.parse(textDecoder.decode(reqBuf));
            }
          } catch {
            body = null;
          }
        }
        if (body) {
          const apiKind = isOpenAi ? "openai" : "anthropic";
          const modelName = reqModelName ?? undefined;
          const result = config.backgroundVision
            ? await vision.processBodyCacheOnly(body, apiKind, modelName, capId, req.signal)
            : await vision.processBody(body, apiKind, modelName, capId, req.signal);
          if (result.changed) {
            reqBuf = textEncoder.encode(JSON.stringify(result.body));
            const postVisionCtx: StampContext = {
              config,
              isOpenAi,
              headers: reqHeadersRaw,
              url,
              method: req.method,
              modelName: extractModelName(result.body),
            };
            const stamped = stampPostVision(result.body, postVisionCtx, reqBuf);
            if (stamped.changed) {
              reqBuf = stamped.reqBuf;
              log.info(`post-handoff stamped (claude_code=${config.stampClaudeCode})`, {
                method: req.method,
                path: url.pathname,
              });
            }
            reqBodyText = decodeText(reqBuf);
            db.updateRequestBody(capId, reqBodyText, reqBuf.byteLength);
            reqMeta.request_size = reqBuf.byteLength;
            ws.broadcast({
              type: "update",
              capture: newSummary(capId, reqMeta, config, "enqueued", reqModelName),
            });
            log.info(
              `vision handoff: ${result.stats.handoffCount} images, ${result.stats.cacheHits} hits, ${result.stats.visionCalls} calls, active=${vision.visionActive} queued=${vision.visionQueued}`,
              {
                captureId: capId,
                method: req.method,
                path: url.pathname,
              },
            );
          }
        }
      } catch (err) {
        log.warn("vision handoff failed, forwarding original body", {
          error: (err as Error).message,
          captureId: capId,
        });
      }
    }

    const reqSize = reqBuf ? reqBuf.byteLength : 0;
    reqMeta.request_size = reqSize;

    // --- Weighted rate limit check (pro tier only; rate is null when unlimited) ---
    const modelName = reqModelName ?? undefined;
    const weight = computeRequestWeight(modelName, models);
    const rate = rateRef.current;
    if (rate) {
      const rc = rate.check(weight);
      if (!rc.allowed) {
        queue.queueUpdate(capId, reqMeta, {
          $status: 429,
          $rh: JSON.stringify({ error: "rate_limit_exceeded" }),
          $rb: JSON.stringify({ error: "rate_limit_exceeded", retry_after: rc.retryAfterSeconds }),
          $rs: 0,
          $ct: "application/json",
          $sse: 0,
          $dur: Date.now() - startedAt,
          $fin: Date.now(),
          $status_source: "gate",
          $gate_reason: `Rate limit exceeded — retry after ${rc.retryAfterSeconds}s`,
        });
        return new Response(
          JSON.stringify({
            error: "rate_limit_exceeded",
            retry_after: rc.retryAfterSeconds,
          }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after": String(rc.retryAfterSeconds),
            },
          },
        );
      }
    }

    // --- Concurrency gate: acquire a permit (blocks if at cap) ---
    let permit: { release: () => void } | null = null;
    try {
      permit = await gate.acquire({
        weight,
        signal: req.signal,
        onAcquire: () => {
          db.setState(capId, "streaming");
          ws.broadcast({ type: "state", captureId: capId, state: "streaming" });
        },
      });
      // Fire after acquire so gate-rejected requests don't suppress the warmer.
      onTraffic?.();
    } catch (e) {
      const err = e as GateError;
      const aborted = err.code === "aborted";
      const status = aborted
        ? 499
        : err.code === "circuit_open" || err.code === "queue_full" || err.code === "timeout"
          ? 503
          : 502;
      queue.queueUpdate(capId, reqMeta, {
        $status: status,
        $rh: JSON.stringify({ error: err.code }),
        $rb: aborted ? "" : err.message,
        $rs: 0,
        $ct: "application/json",
        $sse: 0,
        $dur: Date.now() - startedAt,
        $fin: Date.now(),
        $status_source: "gate",
        $gate_reason: aborted
          ? "Client disconnected while enqueued"
          : err.code === "circuit_open"
            ? "Circuit breaker open — upstream concurrency 429s exceeded threshold"
            : err.code === "queue_full"
              ? "Concurrency queue full — too many requests waiting for a slot"
              : err.code === "timeout"
                ? "Queue timeout — request waited too long for a concurrency slot"
                : err.code === "invalid_weight"
                  ? "Invalid weight — model weight must be positive"
                  : err.message,
      });
      if (aborted) return new Response(null, { status: 499 });
      return new Response(JSON.stringify({ error: err.code, message: err.message }), {
        status,
        headers: { "content-type": "application/json" },
      });
    }

    let permitReleased = false;
    let streamingStarted = false;
    const releasePermit = (): void => {
      if (permit && !permitReleased) {
        permitReleased = true;
        permit.release();
      }
    };

    try {
      // --- Forward upstream (with TTFT-watchdog gated retry on same key) ---
      // The fetch + manual first-chunk race runs in a loop. Attempt 1 is the
      // original fetch. On TTFT timeout, decideRetry() is called; if all gates
      // pass, a fresh ttftController + fresh absolute timeout are constructed
      // and the same body/headers/key are re-fetched. Rate limiter is NOT
      // charged on retry; permit is reused (single-release preserved).
      const ttftArmed = !!(config.experimentTtftWatchdog && ttftState?.shouldArmWatchdog());
      let attempt = 1;
      let retryAttempt = 0; // 0 = no retry; 1 = same-key retry; 2 = rewrite escalation.
      let ttftFired = false; // true if the watchdog fired on any attempt.
      let pendingRewriteEscalation = false; // next loop iter calls attemptRewriteRetry.

      /** Cooldown sleep that aborts early if the client disconnects. */
      const ttftCooldown = async (): Promise<void> => {
        if (config.ttftRetryCooldownMs <= 0) return;
        if (req.signal.aborted) return;
        let handler: (() => void) | null = null;
        try {
          await Promise.race([
            Bun.sleep(config.ttftRetryCooldownMs),
            new Promise<void>((_, reject) => {
              handler = () => reject(new Error("client_aborted"));
              req.signal.addEventListener("abort", handler, { once: true });
            }),
          ]).catch(() => {
            // Client aborted during cooldown — the next fetch will detect it.
          });
        } finally {
          if (handler) req.signal.removeEventListener("abort", handler);
        }
      };

      /** Check whether attempt 3 (rewrite-id escalation) is eligible. */
      const isRewriteEligible = (): boolean => {
        if (!config.experimentRewriteIds) return false;
        if (!rewriteExperiment) return false;
        if (!reqBuf || reqBuf.byteLength === 0) return false;
        if (config.ttftRetryMaxAttempts < 3) return false;
        const { harness, sessionId } = rewriteExperiment.detectAndExtractSession(reqHeadersRaw);
        return rewriteExperiment.isEligible(harness, sessionId) && sessionId !== null;
      };

      /** Extract the session ID for the rewrite escalation path.
       *  Pre-condition: isRewriteEligible() returned true. */
      const getRewriteSession = (): { sessionId: string; harness: Harness } | null => {
        if (!rewriteExperiment || !reqBuf || reqBuf.byteLength === 0) return null;
        const { harness, sessionId } = rewriteExperiment.detectAndExtractSession(reqHeadersRaw);
        if (!rewriteExperiment.isEligible(harness, sessionId) || !sessionId) return null;
        return { sessionId, harness };
      };

      /** Decide whether to retry on TTFT timeout. Returns the reason:
       *  - "retry" → proceed with same-key retry (or rewrite escalation).
       *  - "client_aborted" → 499, no retry.
       *  - "breaker_open" | "gate_saturated" | "auto_disabled" | "cap_reached" → 504.
       */
      const decideRetry = ():
        | "retry"
        | "client_aborted"
        | "breaker_open"
        | "gate_saturated"
        | "auto_disabled"
        | "cap_reached" => {
        if (req.signal.aborted) return "client_aborted";
        const stats = getGateStats?.();
        if (stats && stats.breaker !== "closed") return "breaker_open";
        if (stats) {
          const satLimit = (stats.softLimit * config.ttftRetryGateSaturationPct) / 100;
          if (stats.active >= satLimit) return "gate_saturated";
        }
        if (ttftState?.isDisabled()) return "auto_disabled";
        if (attempt >= config.ttftRetryMaxAttempts) return "cap_reached";
        // Attempt 3 requires rewrite-id eligibility. If the next attempt would
        // be attempt 3 (attempt === 2) but the request isn't rewrite-eligible,
        // there's no third path — treat as cap reached.
        if (attempt === 2 && !isRewriteEligible()) return "cap_reached";
        return "retry";
      };

      /** Apply the three TTFT-watchdog response headers to a headers map. */
      const applyTtftHeaders = (h: Record<string, string>): void => {
        if (!config.experimentTtftWatchdog) return;
        h["x-proxy-retry-attempt"] = String(retryAttempt);
        if (ttftFired) h["x-proxy-ttft-exceeded"] = "1";
        const stats = getGateStats?.();
        if (stats) h["x-proxy-breaker-state"] = stats.breaker;
      };

      /** Build + queue the capture update for a TTFT-timeout 504/499. */
      const queueTtftTimeout = (status: number, gateReason: string, errName: string): void => {
        queue.queueUpdate(capId, reqMeta, {
          $status: status,
          $rh: JSON.stringify({ error: errName }),
          $rb: status === 499 ? "" : `Gateway Timeout: ${errName}`,
          $rs: 0,
          $ct: "text/plain",
          $sse: 0,
          $dur: Date.now() - startedAt,
          $fin: Date.now(),
          $status_source: "gate",
          $gate_reason: gateReason,
        });
      };

      /**
       * Handle a TTFT-timeout event (watchdog fired). Shared by the fetch-error
       * catch path and the first-chunk-read catch path to avoid duplicated
       * retry-decision logic.
       *
       * Returns either `{ continue: true }` (retry) or `{ response: Response }`
       * (terminal — 499 or 504). The caller must `continue` or `return` the
       * response accordingly.
       */
      const handleTtftTimeout = (): { continue: true } | { response: Response } => {
        ttftFired = true;
        log.info("ttft_watchdog_fired", { captureId: capId, attempt });
        const decision = decideRetry();
        if (decision === "retry") {
          if (attempt === 2 && isRewriteEligible()) {
            attempt++;
            retryAttempt = 2;
            pendingRewriteEscalation = true;
            log.info("ttft_retry_attempt", {
              captureId: capId,
              attempt,
              reason: "rewrite_escalation",
            });
            return { continue: true };
          }
          attempt++;
          retryAttempt = 1;
          log.info("ttft_retry_attempt", {
            captureId: capId,
            attempt,
            reason: "same_key",
          });
          return { continue: true };
        }
        const suppressReason =
          decision === "breaker_open"
            ? "breaker_open"
            : decision === "gate_saturated"
              ? "gate_saturated"
              : decision === "auto_disabled"
                ? "auto_disabled"
                : "cap_reached";
        log.info("ttft_retry_suppressed", {
          captureId: capId,
          attempt,
          reason: suppressReason,
        });
        if (retryAttempt > 0) ttftState?.recordRetryOutcome(false);
        queueTtftTimeout(
          504,
          "TTFT watchdog exceeded — no first byte within threshold",
          "ttft_watchdog_exceeded",
        );
        const errHeaders: Record<string, string> = { "content-type": "text/plain" };
        applyTtftHeaders(errHeaders);
        return {
          response: new Response("Gateway Timeout: TTFT exceeded", {
            status: 504,
            headers: errHeaders,
          }),
        };
      };

      // Hoisted out of the loop so the streaming path below can read the
      // final response + headers set on the successful attempt.
      let upstream: Response = new Response(null, { status: 502 });
      let bodyToPipe: ReadableStream<Uint8Array> | null = null;
      let upstreamOutHeaders: Record<string, string> = {};
      let upstreamResHeadersJson = "[]";
      let upstreamContentType = "";
      let upstreamIsSSE = false;
      // Deferred breaker updates — set when fetch returns, applied only after
      // first-chunk read succeeds (TTFT-aborted attempts must NOT touch breaker).
      let pendingRecord429: "concurrency" | "rate_limit" | "gateway" | null = null;
      let pendingRecordSuccess = false;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const ttftController = ttftArmed ? new AbortController() : null;
        let ttftTimer: ReturnType<typeof setTimeout> | null = null;
        // Reset deferred breaker updates for this iteration.
        pendingRecord429 = null;
        pendingRecordSuccess = false;
        if (ttftArmed && ttftController) {
          ttftTimer = setTimeout(() => ttftController.abort(), config.ttftTimeoutMs);
        }

        // --- Attempt 3 path: rewrite-id escalation via attemptRewriteRetry ---
        // When the previous attempt was a same-key retry (attempt 2) that also
        // TTFT-timed-out, and the request is rewrite-eligible, we delegate the
        // fetch to attemptRewriteRetry with forceEscalate + ttftController.
        // The helper does its own fetch; on return we do the manual first-chunk
        // read on the returned Response (same as attempts 1 and 2).
        if (pendingRewriteEscalation) {
          pendingRewriteEscalation = false;
          const rewriteSession = getRewriteSession();
          if (!rewriteSession || !reqBuf || !rewriteExperiment) {
            // Should have been caught by decideRetry() — defensive guard.
            if (retryAttempt > 0) ttftState?.recordRetryOutcome(false);
            queueTtftTimeout(
              504,
              "TTFT watchdog exceeded — no first byte within threshold",
              "ttft_watchdog_exceeded",
            );
            const errHeaders: Record<string, string> = { "content-type": "text/plain" };
            applyTtftHeaders(errHeaders);
            return new Response("Gateway Timeout: TTFT exceeded", {
              status: 504,
              headers: errHeaders,
            });
          }
          let rewriteResponse: Response | null = null;
          try {
            rewriteResponse = await attemptRewriteRetry(
              rewriteSession.sessionId,
              rewriteSession.harness,
              reqBuf,
              fwdHeaders,
              finalTargetUrl,
              req,
              config,
              rewriteExperiment,
              db,
              capId,
              ttftController,
              true,
            );
          } catch (e) {
            log.warn("attemptRewriteRetry threw", {
              captureId: capId,
              error: (e as Error).message,
            });
            rewriteResponse = null;
          }
          if (rewriteResponse === null) {
            // attemptRewriteRetry's fetch failed. Distinguish client abort
            // from TTFT/absolute timeout — client abort returns 499 and
            // does NOT count toward auto-disable.
            if (ttftTimer) {
              clearTimeout(ttftTimer);
              ttftTimer = null;
            }
            if (req.signal.aborted) {
              // Client disconnected during rewrite-escalation fetch.
              queueTtftTimeout(
                499,
                "Client disconnected during rewrite-escalation fetch",
                "client_disconnected",
              );
              return new Response(null, { status: 499 });
            }
            if (ttftController?.signal.aborted) ttftFired = true;
            ttftState?.recordRetryOutcome(false);
            queueTtftTimeout(
              504,
              "TTFT watchdog exceeded — no first byte within threshold (rewrite escalation failed)",
              "ttft_watchdog_exceeded",
            );
            const errHeaders: Record<string, string> = { "content-type": "text/plain" };
            applyTtftHeaders(errHeaders);
            return new Response("Gateway Timeout: TTFT exceeded", {
              status: 504,
              headers: errHeaders,
            });
          }
          // Fetch resolved — skip the 502/529 rewrite-id path (already rewrote)
          // and proceed to the manual first-chunk read below using the same
          // ttftController (still armed if the timer hasn't fired).
          upstream = rewriteResponse;
          // Jump past the 502/529 block by setting a flag the code below
          // checks. We use the existing `upstream` variable; the next section
          // is the 429 classification + 502/529 rewrite path — both skipped
          // for the rewrite-escalation response.
          // Fall through to the first-chunk read path.
        } else {
          let fetchErr: Error | null = null;
          try {
            const upstreamSignal = ttftController
              ? AbortSignal.any([
                  req.signal,
                  ttftController.signal,
                  AbortSignal.timeout(config.upstreamTimeoutMs),
                ])
              : AbortSignal.any([req.signal, AbortSignal.timeout(config.upstreamTimeoutMs)]);
            upstream = await fetch(finalTargetUrl, {
              method: req.method,
              headers: fwdHeaders,
              body: reqBuf && reqBuf.byteLength > 0 ? (reqBuf as BodyInit) : undefined,
              protocol: config.upstreamProtocol as unknown as never,
              signal: upstreamSignal,
            });
          } catch (e) {
            fetchErr = e as Error;
          }

          // If the fetch itself aborted (before any response arrived), inspect
          // the cause and possibly retry.
          if (fetchErr) {
            const err = fetchErr;
            if (ttftTimer) {
              clearTimeout(ttftTimer);
              ttftTimer = null;
            }
            const clientAborted = err.name === "AbortError" && req.signal.aborted;
            const ttftExceeded = !!ttftController?.signal.aborted;
            const upstreamTimedOut =
              err.name === "TimeoutError" ||
              (err.name === "AbortError" && !req.signal.aborted && !ttftExceeded);

            if (clientAborted) {
              queueTtftTimeout(
                499,
                "Client disconnected during upstream request",
                "client_disconnected",
              );
              return new Response(null, { status: 499 });
            }
            if (ttftExceeded && ttftArmed) {
              const result = handleTtftTimeout();
              if ("continue" in result) {
                await ttftCooldown();
                continue;
              }
              return result.response;
            }
            // Non-TTFT fetch error (absolute timeout, network, etc.) — no retry.
            const status = upstreamTimedOut ? 504 : 502;
            queueTtftTimeout(
              status,
              upstreamTimedOut
                ? `Upstream inactivity timeout (${config.upstreamTimeoutMs}ms)`
                : `Upstream unreachable — ${err.message}`,
              upstreamTimedOut ? "upstream_timeout" : String(err),
            );
            const errHeaders: Record<string, string> = {
              "content-type": "text/plain",
            };
            applyTtftHeaders(errHeaders);
            const body = upstreamTimedOut
              ? `Gateway Timeout: ${err.message}`
              : `Bad Gateway: ${err.message}`;
            return new Response(body, { status, headers: errHeaders });
          }

          // --- Classify 429: only concurrency-429s trip the breaker ---
          // Deferred until after the first-chunk read succeeds — TTFT-aborted
          // attempts must NOT touch the breaker (spec invariant). When the
          // TTFT watchdog fires during the first-chunk read, the code takes
          // the catch path and continues the retry loop, so these calls are
          // never reached for aborted attempts.
          if (upstream.status === 429) {
            pendingRecord429 = classify429(upstream);
          } else if (upstream.status < 400) {
            pendingRecordSuccess = true;
          }

          // --- Experiment: ID rewriting on 502/529 overloaded_error ---
          if (
            config.experimentRewriteIds &&
            rewriteExperiment &&
            (upstream.status === 502 || upstream.status === 529) &&
            reqBuf &&
            reqBuf.byteLength > 0
          ) {
            const errBody = await upstream.text();
            const isOverloaded = errBody.includes("overloaded_error");
            if (isOverloaded) {
              const { harness, sessionId } =
                rewriteExperiment.detectAndExtractSession(reqHeadersRaw);
              if (rewriteExperiment.isEligible(harness, sessionId) && sessionId) {
                log.info("502 overloaded_error detected, attempting ID rewrite retry", {
                  captureId: capId,
                  sessionId,
                  harness,
                });
                const retryResult = await attemptRewriteRetry(
                  sessionId,
                  harness,
                  reqBuf,
                  fwdHeaders,
                  finalTargetUrl,
                  req,
                  config,
                  rewriteExperiment,
                  db,
                  capId,
                );
                if (retryResult) {
                  upstream = retryResult;
                } else {
                  upstream = new Response(errBody, {
                    status: upstream.status,
                    headers: upstream.headers,
                  });
                }
              } else {
                upstream = new Response(errBody, {
                  status: upstream.status,
                  headers: upstream.headers,
                });
              }
            } else {
              upstream = new Response(errBody, {
                status: upstream.status,
                headers: upstream.headers,
              });
            }
          }
        } // end else (non-rewrite-escalation fetch path)

        const resHeadersRaw = headersToObject(upstream.headers);
        const resHeadersJson = JSON.stringify(resHeadersRaw);
        const contentType = upstream.headers.get("content-type") ?? "";
        const isSSE = contentType.includes("text/event-stream");

        // Forwarded response headers: strip content-encoding/length + hop-by-hop.
        const outHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(resHeadersRaw)) {
          if (HOP.has(k) || k === "content-encoding") continue;
          outHeaders[k] = v;
        }

        // --- TTFT watchdog: manual first-chunk read + wrapped stream ---
        // When the feature is on and the response is streaming, race the first
        // chunk read against the watchdog timer. On success, wrap the reader in
        // a new ReadableStream that re-enqueues the first chunk in start() so
        // the existing TransformStream capture path runs unchanged.
        bodyToPipe = upstream.body;
        if (ttftController && upstream.body && isSSE) {
          const reader = upstream.body.getReader();
          try {
            const readResult = await reader.read();
            if (ttftTimer) {
              clearTimeout(ttftTimer);
              ttftTimer = null;
            }
            if (readResult.done) {
              // Empty body — degenerate 200. Build an empty wrapped stream so the
              // existing TransformStream + flush + releasePermit path runs.
              bodyToPipe = new ReadableStream<Uint8Array>({
                start(c) {
                  c.close();
                },
              });
            } else {
              const firstChunk = readResult.value;
              bodyToPipe = new ReadableStream<Uint8Array>({
                start(c) {
                  c.enqueue(firstChunk);
                },
                async pull(c) {
                  const r = await reader.read();
                  if (r.done) {
                    c.close();
                  } else {
                    c.enqueue(r.value);
                  }
                },
                cancel(reason) {
                  reader.cancel(reason);
                },
              });
            }
          } catch (e) {
            if (ttftTimer) {
              clearTimeout(ttftTimer);
              ttftTimer = null;
            }
            const err = e as Error;
            const clientAborted = err.name === "AbortError" && req.signal.aborted;
            const ttftExceeded = ttftController.signal.aborted;
            const upstreamTimedOut =
              err.name === "TimeoutError" ||
              (err.name === "AbortError" && !req.signal.aborted && !ttftExceeded);

            if (clientAborted) {
              queueTtftTimeout(499, "Client disconnected during TTFT race", "client_disconnected");
              return new Response(null, { status: 499 });
            }
            if (ttftExceeded && ttftArmed) {
              const result = handleTtftTimeout();
              if ("continue" in result) {
                await ttftCooldown();
                continue;
              }
              return result.response;
            }
            // Absolute timeout or other error during first-chunk read — no retry.
            const status = ttftExceeded || upstreamTimedOut ? 504 : 502;
            queueTtftTimeout(
              status,
              ttftExceeded
                ? "TTFT watchdog exceeded — no first byte within threshold"
                : upstreamTimedOut
                  ? "Upstream inactivity timeout"
                  : `Upstream error — ${err.message}`,
              ttftExceeded
                ? "ttft_watchdog_exceeded"
                : upstreamTimedOut
                  ? "upstream_timeout"
                  : String(err),
            );
            const errHeaders: Record<string, string> = { "content-type": "text/plain" };
            applyTtftHeaders(errHeaders);
            const body = ttftExceeded
              ? "Gateway Timeout: TTFT exceeded"
              : upstreamTimedOut
                ? `Gateway Timeout: ${err.message}`
                : `Bad Gateway: ${err.message}`;
            return new Response(body, { status, headers: errHeaders });
          }
        } else if (ttftTimer) {
          // Feature on but response is non-streaming or has no body — disarm
          // the watchdog; the absolute timeout still guards the request.
          clearTimeout(ttftTimer);
          ttftTimer = null;
        }

        // First chunk arrived in time (or feature off / non-streaming) — break
        // out of the retry loop and proceed to the streaming response path.
        // Apply deferred breaker updates now that the attempt has definitively
        // succeeded (not TTFT-aborted). Spec: "TTFT-aborted attempts call
        // neither record429 nor recordSuccess."
        if (pendingRecord429) {
          gate.record429(pendingRecord429);
        }
        if (pendingRecordSuccess) {
          gate.recordSuccess();
        }
        // Only record TTFT-state outcomes for SSE responses — non-streaming
        // is out of scope per spec, and the watchdog was never raced.
        if (ttftArmed && isSSE) {
          if (retryAttempt > 0) {
            ttftState?.recordRetryOutcome(true);
          } else {
            ttftState?.recordSuccess();
          }
        }
        upstreamOutHeaders = outHeaders;
        upstreamResHeadersJson = resHeadersJson;
        upstreamContentType = contentType;
        upstreamIsSSE = isSSE;
        break;
      }

      // Apply TTFT-watchdog response headers to the final streaming response.
      applyTtftHeaders(upstreamOutHeaders);
      const outHeaders = upstreamOutHeaders;
      const resHeadersJson = upstreamResHeadersJson;
      const contentType = upstreamContentType;
      const isSSE = upstreamIsSSE;

      const doneRes = (): Omit<ResponseMeta, "$rb" | "$rs"> => ({
        $status: upstream.status,
        $rh: resHeadersJson,
        $ct: contentType,
        $sse: isSSE ? 1 : 0,
        $dur: Date.now() - startedAt,
        $fin: Date.now(),
        $status_source: "upstream",
        $gate_reason: null,
      });

      if (!upstream.body) {
        queue.queueUpdate(capId, reqMeta, { ...doneRes(), $rb: "", $rs: 0 });
        return new Response(null, { status: upstream.status, headers: outHeaders });
      }

      // bodyToPipe is either upstream.body or a wrapped stream built from its reader.
      // The early `!upstream.body` return above guarantees it is non-null here.
      const sourceStream: ReadableStream<Uint8Array> = bodyToPipe ?? upstream.body;

      // Stream response to client while incrementally decoding for capture.
      // Decodes each chunk with stream:true to handle multi-byte sequences
      // spanning chunk boundaries, avoiding the combine() double-copy.
      // `captureBodyMaxBytes` caps in-memory buffer growth (0 = unlimited);
      // the stream to the client is never truncated.
      const cap = config.captureBodyMaxBytes;
      const parts: string[] = [];
      const timedChunks: { text: string; time: number }[] = [];
      let totalSize = 0;
      let flushed = false;
      let firstChunkSent = false;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const flushCapture = (): void => {
        if (flushed) return;
        flushed = true;
        if (cap === 0 || totalSize <= cap) {
          try {
            const tail = decoder.decode();
            if (tail) parts.push(tail);
          } catch {
            // Tail had invalid bytes — ignore, already captured above.
          }
        }
        const fullBody = parts.join("");
        const isStream = isSSE;
        let usage: UsageMetrics | null = null;
        let model: string | null = null;
        try {
          const result = extractUsage({
            provider: isOpenAi ? "openai" : "anthropic",
            streaming: isStream,
            requestBody: reqBodyText,
            responseBody: fullBody,
            durationMs: Date.now() - startedAt,
            requestStartedAt: startedAt,
            chunks: isStream ? timedChunks : undefined,
          });
          model = result.model;
          usage = result.metrics;
        } catch {
          usage = null;
          model = null;
        }
        try {
          queue.queueUpdate(capId, reqMeta, {
            ...doneRes(),
            $rb: fullBody,
            $rs: totalSize,
            $usage: usage,
            $model: model,
          });
        } catch {
          // Non-critical: capture persistence failure must not block permit release
        }
      };

      const onAbort = (): void => {
        flushCapture();
        releasePermit();
      };

      if (req.signal) {
        if (req.signal.aborted) {
          flushCapture();
        } else {
          req.signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      const capture = new TransformStream({
        transform(chunk: Uint8Array, controller) {
          totalSize += chunk.byteLength;
          const capturing = cap === 0 || totalSize <= cap;
          const now = Date.now();
          if (capturing) {
            let decoded = "";
            try {
              decoded = decoder.decode(chunk, { stream: true });
              parts.push(decoded);
            } catch {
              parts.push(Buffer.from(chunk).toString("base64"));
            }
            if (decoded) timedChunks.push({ text: decoded, time: now });
          }
          if (!firstChunkSent) {
            firstChunkSent = true;
            try {
              ws.broadcast({
                type: "update",
                capture: {
                  ...newSummary(capId, reqMeta, config, "streaming", reqModelName),
                  ttft_ms: now - startedAt,
                },
              });
            } catch {
              // Non-critical: dashboard update failure must not error the stream
            }
          }
          controller.enqueue(chunk);
        },
        flush() {
          flushCapture();
          if (req.signal) {
            req.signal.removeEventListener("abort", onAbort);
          }
          releasePermit();
        },
      });

      const stream = sourceStream.pipeThrough(capture);
      streamingStarted = true;
      return new Response(stream, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: outHeaders,
      });
    } catch (err) {
      log.error("post-fetch processing failed", {
        error: (err as Error).message,
        captureId: capId,
      });
      queue.queueUpdate(capId, reqMeta, {
        $status: 500,
        $rh: JSON.stringify({ error: "internal_error" }),
        $rb: `Internal error: ${(err as Error).message}`,
        $rs: 0,
        $ct: "application/json",
        $sse: 0,
        $dur: Date.now() - startedAt,
        $fin: Date.now(),
        $status_source: "gate",
        $gate_reason: `Internal proxy error — ${(err as Error).message}`,
      });
      return new Response(
        JSON.stringify({ error: "internal_error", message: (err as Error).message }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    } finally {
      if (!streamingStarted) releasePermit();
    }
  }

  return { handleProxy };
}
