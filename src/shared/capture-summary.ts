// Capture summary builders.

import type {
  CaptureRow,
  CaptureState,
  CaptureSummary,
  ProtocolConfig,
  RequestMeta,
  ResponseMeta,
} from "../types.js";

/** Build a summary from a full capture row (no body data). */
export function summary(row: CaptureRow): CaptureSummary {
  return {
    id: row.id,
    method: row.method,
    path: row.path,
    response_status: row.response_status,
    is_sse: !!row.is_sse,
    content_type: row.content_type,
    request_size: row.request_size,
    response_size: row.response_size,
    duration_ms: row.duration_ms,
    state: row.state,
    started_at: row.started_at,
    finished_at: row.finished_at,
    incoming_protocol: row.incoming_protocol ?? "",
    upstream_protocol: row.upstream_protocol ?? "",
    model: row.model,
    usage_missing: row.usage_missing == null ? null : !!row.usage_missing,
    ttft_ms: row.ttft_ms ?? null,
    tps: row.tps ?? null,
    cache_creation_tokens: row.cache_creation_tokens ?? null,
    cache_read_tokens: row.cache_read_tokens ?? null,
    total_input_tokens: row.total_input_tokens ?? null,
    output_tokens: row.output_tokens ?? null,
    total_output_tokens: row.total_output_tokens ?? null,
    is_vision: !!row.is_vision,
    status_source: (row.status_source as "upstream" | "gate" | null) ?? null,
    gate_reason: row.gate_reason ?? null,
  };
}

/** Build a summary for a newly-started capture (before response). */
export function newSummary(
  id: number,
  reqMeta: RequestMeta,
  config: ProtocolConfig,
  state: CaptureState = "streaming",
  model: string | null = null,
): CaptureSummary {
  return {
    id,
    method: reqMeta.method,
    path: reqMeta.path,
    response_status: null,
    is_sse: false,
    content_type: null,
    request_size: reqMeta.request_size,
    response_size: 0,
    duration_ms: 0,
    state,
    started_at: reqMeta.started_at,
    finished_at: null,
    incoming_protocol: config.incomingProtocol,
    upstream_protocol: config.upstreamProtocol,
    model,
    usage_missing: null,
    ttft_ms: null,
    tps: null,
    cache_creation_tokens: null,
    cache_read_tokens: null,
    total_input_tokens: null,
    output_tokens: null,
    total_output_tokens: null,
    is_vision: false,
    status_source: null,
    gate_reason: null,
  };
}

/** Build a summary from queued response metadata. */
export function buildSummary(
  id: number,
  reqMeta: RequestMeta,
  res: ResponseMeta,
  config: ProtocolConfig,
): CaptureSummary {
  const u = res.$usage ?? null;
  return {
    id,
    method: reqMeta.method,
    path: reqMeta.path,
    response_status: res.$status,
    is_sse: !!res.$sse,
    content_type: res.$ct,
    request_size: reqMeta.request_size,
    response_size: res.$rs,
    duration_ms: res.$dur,
    state: "done",
    started_at: reqMeta.started_at,
    finished_at: res.$fin,
    incoming_protocol: config.incomingProtocol,
    upstream_protocol: config.upstreamProtocol,
    model: res.$model ?? null,
    usage_missing: u?.usage_missing ?? null,
    ttft_ms: u?.ttft_ms ?? null,
    tps: u?.tps ?? null,
    cache_creation_tokens: u?.cache_creation_tokens ?? null,
    cache_read_tokens: u?.cache_read_tokens ?? null,
    total_input_tokens: u?.total_input_tokens ?? null,
    output_tokens: u?.output_tokens ?? null,
    total_output_tokens: u?.total_output_tokens ?? null,
    is_vision: false,
    status_source: res.$status_source,
    gate_reason: res.$gate_reason,
  };
}
