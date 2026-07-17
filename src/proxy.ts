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
  GateConfig,
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
  config: StampConfig & CaptureConfig & GateConfig & ProtocolConfig,
  gate: ConcurrencyGate,
  rateRef: RateLimiterRef,
  vision: VisionHandoff | null,
  models: ModelsClient,
  onTraffic?: () => void,
) {
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
      // --- Forward upstream ---
      let upstream: Response;
      try {
        const upstreamSignal = AbortSignal.any([
          req.signal,
          AbortSignal.timeout(config.upstreamTimeoutMs),
        ]);
        upstream = await fetch(finalTargetUrl, {
          method: req.method,
          headers: fwdHeaders,
          body: reqBuf && reqBuf.byteLength > 0 ? (reqBuf as BodyInit) : undefined,
          protocol: config.upstreamProtocol as unknown as never,
          signal: upstreamSignal,
        });
      } catch (e) {
        const err = e as Error;
        const clientAborted = err.name === "AbortError" && req.signal.aborted;
        const upstreamTimedOut =
          err.name === "TimeoutError" || (err.name === "AbortError" && !req.signal.aborted);
        const status = clientAborted ? 499 : upstreamTimedOut ? 504 : 502;
        queue.queueUpdate(capId, reqMeta, {
          $status: status,
          $rh: JSON.stringify({
            error: clientAborted
              ? "client_disconnected"
              : upstreamTimedOut
                ? "upstream_timeout"
                : String(err),
          }),
          $rb: clientAborted ? "" : `Upstream error: ${err.message}`,
          $rs: 0,
          $ct: "text/plain",
          $sse: 0,
          $dur: Date.now() - startedAt,
          $fin: Date.now(),
          $status_source: "gate",
          $gate_reason: clientAborted
            ? "Client disconnected during upstream request"
            : upstreamTimedOut
              ? "Upstream inactivity timeout (300s)"
              : `Upstream unreachable — ${err.message}`,
        });
        if (clientAborted) return new Response(null, { status: 499 });
        if (upstreamTimedOut)
          return new Response(`Gateway Timeout: ${err.message}`, { status: 504 });
        return new Response(`Bad Gateway: ${err.message}`, { status: 502 });
      }

      // --- Classify 429: only concurrency-429s trip the breaker ---
      if (upstream.status === 429) {
        gate.record429(classify429(upstream));
      } else if (upstream.status < 400) {
        gate.recordSuccess();
      }

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

      const stream = upstream.body.pipeThrough(capture);
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
