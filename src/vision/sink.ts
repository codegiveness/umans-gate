// Vision record sinks.
//
// Decouples VisionHandoff.addRecord() from the concrete persistence (CaptureDB)
// and broadcast (WsBroadcaster) side effects. A sink receives a fully-built
// VisionRecord and performs its side effect; error isolation is the
// CompositeVisionSink's responsibility so a DB failure never prevents a WS
// broadcast (and vice versa).

import { type CaptureDB, flattenUsage } from "../db.js";
import type { CaptureSummary, ProtocolConfig, WsMessage } from "../types.js";
import type { UsageMetrics } from "../usage/types.js";
import type { WsBroadcaster } from "../ws.js";
import type { VisionCallRecord } from "./handoff.js";

interface SinkRecordParts {
  metaJson: string;
  reqBody: string;
  resBody: string;
  reqHeaders: string;
  resHeaders: string;
  path: string;
  url: string;
  status: number | null;
  startedAt: number;
}

function buildSinkRecord(record: VisionRecord, opts?: { includeUrl?: boolean }): SinkRecordParts {
  const { rec, httpExchange } = record;
  const metaJson = JSON.stringify({
    status: rec.status,
    httpStatus: rec.httpStatus,
    latencyMs: rec.latencyMs,
    description: rec.description,
    error: rec.error,
    imageHash: rec.imageHash,
    imageSize: rec.imageSize,
    model: rec.model,
    target: rec.target,
  });
  const reqBody =
    httpExchange?.requestBody ??
    JSON.stringify({
      model: rec.model,
      target: rec.target,
      imageSize: rec.imageSize,
      imageHash: rec.imageHash,
    });
  const resBody = httpExchange?.responseBody ?? metaJson;
  const reqHeaders = httpExchange?.requestHeaders ?? "{}";
  const resHeaders = httpExchange?.responseHeaders ?? "{}";

  let path = "/v1/chat/completions";
  let url = "";
  if (rec.target) {
    try {
      const u = new URL(rec.target);
      path = u.pathname + u.search;
      if (opts?.includeUrl) {
        url = rec.target;
      }
    } catch {
      path = rec.target;
      if (opts?.includeUrl) {
        url = rec.target;
      }
    }
  }

  const status = rec.status === "ok" || rec.status === "cache_hit" ? 200 : (rec.httpStatus ?? null);
  const startedAt = rec.timestamp - Math.max(0, rec.latencyMs);

  return {
    metaJson,
    reqBody,
    resBody,
    reqHeaders,
    resHeaders,
    path,
    url,
    status,
    startedAt,
  };
}

/** Raw HTTP exchange captured alongside a vision call (bodies + headers). */
export interface VisionHttpExchange {
  requestBody: string;
  requestHeaders: string;
  responseBody: string;
  responseHeaders: string;
}

/**
 * Everything a sink needs to persist a vision capture and broadcast it.
 * Bundles the call record, the optional HTTP exchange, and parsed usage.
 */
export interface VisionRecord {
  /** The assigned vision call record (id + timestamp included). */
  rec: VisionCallRecord;
  /** Raw HTTP exchange if available; sinks fall back to synthesized bodies. */
  httpExchange?: VisionHttpExchange;
  /** Parsed usage metrics for token accounting (null if absent). */
  usage: UsageMetrics | null;
  /** CaptureDB row id when the row has already been inserted (lifecycle path). */
  dbId?: number;
}

/**
 * Receives a completed vision record for persistence and/or broadcast.
 * Implementations must not throw — wrap errors internally if they cannot
 * propagate cleanly, because {@link CompositeVisionSink} relies on the
 * "one sink throwing must not break the others" contract at the composite
 * boundary (it also isolates, but sinks shouldn't depend on that).
 */
export interface VisionRecordSink {
  record(record: VisionRecord): void;
}

/**
 * Fan-out sink: forwards the record to each child sink, isolating errors so
 * a throw in one sink never prevents the remaining sinks from running.
 *
 * This is the default sink wired in src/index.ts: CompositeVisionSink([
 *   new DbVisionSink(db),
 *   new WsBroadcastVisionSink(ws),
 * ]).
 */
export class CompositeVisionSink implements VisionRecordSink {
  private readonly sinks: readonly VisionRecordSink[];

  constructor(sinks: readonly VisionRecordSink[]) {
    this.sinks = sinks;
  }

  record(record: VisionRecord): void {
    for (const sink of this.sinks) {
      try {
        sink.record(record);
      } catch {
        // Error isolation: one sink failing must not break the others.
        // Intentionally swallowed — each sink owns its own logging if needed.
      }
    }
  }
}

/**
 * Persists a vision record into the captures table via CaptureDB.
 * Reproduces the exact insert params the fused VisionHandoff.addRecord()
 * previously built inline.
 */
export class DbVisionSink implements VisionRecordSink {
  constructor(
    private readonly db: CaptureDB,
    private readonly protocolConfig: ProtocolConfig,
  ) {}

  record(record: VisionRecord): void {
    if (record.dbId !== undefined) return;
    const { rec, usage } = record;
    const parts = buildSinkRecord(record, { includeUrl: true });

    record.dbId = this.db.insertVisionCapture({
      $method: "POST",
      $path: parts.path,
      $url: parts.url,
      $rh: parts.reqHeaders,
      $rb: parts.reqBody,
      $rs: parts.reqBody.length,
      $status: parts.status,
      $rh2: parts.resHeaders,
      $rb2: parts.resBody,
      $rs2: parts.resBody.length,
      $ct: "application/json",
      $dur: rec.latencyMs,
      $state: rec.state,
      $started_at: parts.startedAt,
      $finished_at: rec.timestamp,
      $inp: this.protocolConfig.incomingProtocol,
      $outp: this.protocolConfig.upstreamProtocol,
      $model: rec.model,
      $parent_capture_id: rec.captureId ?? null,
      $vision_meta: parts.metaJson,
      ...flattenUsage(usage),
    });
  }
}

/**
 * Broadcasts a vision record as a "new capture" WS message.
 * Reproduces the exact CaptureSummary the fused VisionHandoff.addRecord()
 * previously built inline.
 */
export class WsBroadcastVisionSink implements VisionRecordSink {
  constructor(
    private readonly ws: WsBroadcaster,
    private readonly protocolConfig: ProtocolConfig,
  ) {}

  record(record: VisionRecord): void {
    const { rec, usage } = record;
    const parts = buildSinkRecord(record);
    const msg: WsMessage = {
      type: record.dbId ? "update" : "new",
      capture: {
        id: record.dbId ?? rec.id,
        method: "POST",
        path: parts.path,
        response_status: parts.status,
        is_sse: false,
        content_type: "application/json",
        request_size: parts.reqBody.length,
        response_size: parts.resBody.length,
        duration_ms: rec.latencyMs,
        state: rec.state,
        started_at: parts.startedAt,
        finished_at: rec.timestamp,
        incoming_protocol: this.protocolConfig.incomingProtocol,
        upstream_protocol: this.protocolConfig.upstreamProtocol,
        model: rec.model,
        usage_missing: usage ? usage.usage_missing : null,
        ttft_ms: usage?.ttft_ms ?? null,
        tps: usage?.tps ?? null,
        cache_creation_tokens: usage?.cache_creation_tokens ?? null,
        cache_read_tokens: usage?.cache_read_tokens ?? null,
        total_input_tokens: usage?.total_input_tokens ?? null,
        output_tokens: usage?.output_tokens ?? null,
        total_output_tokens: usage?.total_output_tokens ?? null,
        is_vision: true,
        status_source: "upstream",
        gate_reason: null,
        retry_attempt: null,
        ttft_exceeded: null,
      } satisfies CaptureSummary,
    };
    this.ws.broadcast(msg);
  }
}
