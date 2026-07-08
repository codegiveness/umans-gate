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
import type { GateError } from "./limiter.js";
import type { ConcurrencyGate } from "./limiter.js";
import { createLogger } from "./logger.js";

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
export function createProxyHandler(
  db: CaptureDB,
  ws: WsBroadcaster,
  queue: WriteQueue,
  config: StampConfig & CaptureConfig & GateConfig & ProtocolConfig,
  gate: ConcurrencyGate,
  rate: SlidingWindowRateLimiter | null,
  vision: VisionHandoff | null,
  models: ModelsClient,
  onTraffic?: () => void,
) {
  async function handleProxy(req: Request, url: URL): Promise<Response> {
    onTraffic?.();
    const startedAt = Date.now();
    const path = url.pathname + url.search;
    const targetUrl = config.target + path;

    // --- Rate limit check (pro tier only; rate is null when disabled or max tier) ---
    if (rate) {
      const rc = rate.check();
      if (!rc.allowed) {
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

    const reqHeadersRaw = headersToObject(req.headers);
    const isOpenAi = url.pathname.includes(config.openaiPath);

    // --- Request body capture ---
    let reqBuf: Uint8Array | null = null;
    if (req.method !== "GET" && req.method !== "HEAD") {
      reqBuf = new Uint8Array(await req.arrayBuffer());
    }

    // --- Stamp pipeline (TTL, AnthropicBody, OpenAiReasoning, TopK) ---
    let body: unknown = null;
    if (reqBuf && reqBuf.byteLength > 0) {
      const parsed = parseJsonBody(reqBuf, reqHeadersRaw);
      body = parsed.body;
      const stampCtx: StampContext = {
        config,
        isOpenAi,
        headers: reqHeadersRaw,
        url,
        method: req.method,
        modelName: extractModelName(body),
      };
      if (STAMP_PIPELINE.some((s) => s.applies(stampCtx))) {
        if (parsed.ok && typeof body === "object" && body !== null) {
          for (const step of STAMP_PIPELINE) {
            if (!step.applies(stampCtx) || !body) continue;
            if (step.apply(body, stampCtx)) {
              reqBuf = textEncoder.encode(JSON.stringify(body));
            }
          }
        }
      }
    }

    // --- Insert capture row (early, so vision calls can link to it) ---
    const reqMeta: RequestMeta = {
      method: req.method,
      path,
      request_size: reqBuf ? reqBuf.byteLength : 0,
      started_at: startedAt,
    };
    const capId = db.startCapture({
      $method: req.method,
      $path: path,
      $url: targetUrl,
      $rh: JSON.stringify(redactHeaders(headersToObject(req.headers))),
      $rb: reqBuf ? decodeText(reqBuf) : "",
      $rs: reqBuf ? reqBuf.byteLength : 0,
      $st: startedAt,
      $state: "enqueued",
      $inp: config.incomingProtocol,
      $outp: config.upstreamProtocol,
    });
    ws.broadcast({ type: "new", capture: newSummary(capId, reqMeta, config, "enqueued") });

    // --- Vision handoff (image → text description) ---
    if (reqBuf && reqBuf.byteLength > 0 && vision) {
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
        const modelName = extractModelName(body);
        const result = await vision.processBody(body, apiKind, modelName, capId, req.signal);
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
            log.info(`post-handoff stamped ttl="${config.stampTtl}"`, {
              method: req.method,
              path: url.pathname,
            });
          }
          db.updateRequestBody(capId, decodeText(reqBuf), reqBuf.byteLength);
          reqMeta.request_size = reqBuf.byteLength;
          ws.broadcast({
            type: "update",
            capture: newSummary(capId, reqMeta, config, "enqueued"),
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
    }

    const reqSize = reqBuf ? reqBuf.byteLength : 0;
    const reqBodyText = reqBuf ? decodeText(reqBuf) : "";
    reqMeta.request_size = reqSize;

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

    // --- Concurrency gate: acquire a permit (blocks if at cap) ---
    let permit: { release: () => void } | null = null;
    try {
      const modelName = extractModelName(body);
      const weight = computeRequestWeight(config, modelName, models);
      permit = await gate.acquire({
        weight,
        signal: req.signal,
        onAcquire: () => {
          db.setState(capId, "streaming");
          ws.broadcast({ type: "state", captureId: capId, state: "streaming" });
        },
      });
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
      });
      if (aborted) return new Response(null, { status: 499 });
      return new Response(JSON.stringify({ error: err.code, message: err.message }), {
        status,
        headers: { "content-type": "application/json" },
      });
    }

    // --- Forward upstream ---
    let upstream: Response;
    try {
      upstream = await fetch(targetUrl, {
        method: req.method,
        headers: fwdHeaders,
        body: reqBuf && reqBuf.byteLength > 0 ? reqBuf : undefined,
        protocol: config.upstreamProtocol as unknown as never,
        signal: req.signal,
      });
    } catch (e) {
      const err = e as Error;
      const aborted = err.name === "AbortError" || req.signal.aborted;
      const status = aborted ? 499 : 502;
      queue.queueUpdate(capId, reqMeta, {
        $status: status,
        $rh: JSON.stringify({ error: aborted ? "client_disconnected" : String(err) }),
        $rb: aborted ? "" : `Upstream error: ${err.message}`,
        $rs: 0,
        $ct: "text/plain",
        $sse: 0,
        $dur: Date.now() - startedAt,
        $fin: Date.now(),
      });
      permit?.release();
      if (aborted) return new Response(null, { status: 499 });
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
    });

    if (!upstream.body) {
      queue.queueUpdate(capId, reqMeta, { ...doneRes(), $rb: "", $rs: 0 });
      permit?.release();
      return new Response(null, { status: upstream.status, headers: outHeaders });
    }

    // Stream response to client while incrementally decoding for capture.
    // Decodes each chunk with stream:true to handle multi-byte sequences
    // spanning chunk boundaries, avoiding the combine() double-copy.
    // `captureBodyMaxBytes` caps in-memory buffer growth (0 = unlimited);
    // the stream to the client is never truncated.
    const cap = config.captureBodyMaxBytes;
    const parts: string[] = [];
    const chunkTimes: number[] = [];
    const timedChunks: { text: string; time: number }[] = [];
    let totalSize = 0;
    let flushed = false;
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
          chunkTimes,
          chunks: isStream ? timedChunks : undefined,
        });
        model = result.model;
        usage = result.metrics;
      } catch {
        usage = null;
        model = null;
      }
      queue.queueUpdate(capId, reqMeta, {
        ...doneRes(),
        $rb: fullBody,
        $rs: totalSize,
        $usage: usage,
        $model: model,
      });
      permit?.release();
    };
    const capture = new TransformStream({
      transform(chunk: Uint8Array, controller) {
        totalSize += chunk.byteLength;
        // Capture is enabled when unlimited (0) or still within the cap.
        const capturing = cap === 0 || totalSize <= cap;
        const now = Date.now();
        if (capturing) {
          let decoded = "";
          try {
            decoded = decoder.decode(chunk, { stream: true });
            parts.push(decoded);
          } catch {
            // Invalid UTF-8 in this chunk — base64-encode for fidelity.
            parts.push(Buffer.from(chunk).toString("base64"));
          }
          if (decoded) timedChunks.push({ text: decoded, time: now });
          chunkTimes.push(now);
        }
        controller.enqueue(chunk);
      },
      flush() {
        flushCapture();
      },
    });

    // Client disconnected mid-stream — flush capture so it doesn't stay "streaming".
    if (req.signal) {
      if (req.signal.aborted) {
        flushCapture();
      } else {
        req.signal.addEventListener(
          "abort",
          () => {
            flushCapture();
          },
          { once: true },
        );
      }
    }

    const stream = upstream.body.pipeThrough(capture);
    return new Response(stream, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: outHeaders,
    });
  }

  return { handleProxy };
}
