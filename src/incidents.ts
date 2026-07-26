// Incident attribution derivation — maps non-200 capture signals to a
// responsible party and incident type. Centralized so each non-200 write
// site in the proxy handler gets correct attribution for free.
//
// The id_rewrite path bypasses deriveIncident() and passes pre-resolved
// { responsibleParty: "proxy", incidentType: "id_rewrite" } directly to
// db.recordIncident(), because the rewrite context is only known there.

import type { CaptureDB } from "./db.js";

export type ResponsibleParty = "upstream" | "proxy" | "client";

export type IncidentType =
  | "upstream_error"
  | "ttft_timeout"
  | "id_rewrite"
  | "rate_limited"
  | "gate_rejected"
  | "client_aborted";

/** Inputs available at every non-200 write site in the proxy handler. */
export interface DeriveIncidentInput {
  status: number;
  statusSource: "upstream" | "gate";
  clientAborted: boolean;
}

/** Derive responsible party + incident type from raw proxy signals. */
export function deriveIncident(input: DeriveIncidentInput): {
  responsibleParty: ResponsibleParty;
  incidentType: IncidentType;
} {
  if (input.statusSource === "upstream") {
    return { responsibleParty: "upstream", incidentType: "upstream_error" };
  }
  // statusSource === "gate"
  if (input.clientAborted) {
    return { responsibleParty: "client", incidentType: "client_aborted" };
  }
  if (input.status === 429) {
    return { responsibleParty: "proxy", incidentType: "rate_limited" };
  }
  if (input.status === 504) {
    return { responsibleParty: "proxy", incidentType: "ttft_timeout" };
  }
  return { responsibleParty: "proxy", incidentType: "gate_rejected" };
}

/** Fire an upstream_error incident when the upstream returned a non-200.
 *  No-op unless status >= 400 && statusSource === "upstream".
 *  Wrapped in try/catch — a DB error on incident persistence must not break
 *  the capture's response path. */
export function maybeRecordUpstreamIncident(params: {
  db: CaptureDB;
  captureId: number;
  status: number;
  statusSource: "upstream" | "gate" | null;
  clientAborted: boolean;
}): void {
  if (params.statusSource !== "upstream" || params.status < 400) return;
  try {
    const { responsibleParty, incidentType } = deriveIncident({
      status: params.status,
      statusSource: "upstream",
      clientAborted: params.clientAborted,
    });
    params.db.recordIncident({
      captureId: params.captureId,
      responsibleParty,
      incidentType,
      upstreamStatus: params.status,
      servedStatus: params.status,
      reason: null,
    });
  } catch {
    // Non-blocking: incident persistence failure must not break the response path.
  }
}
