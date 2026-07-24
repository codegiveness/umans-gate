export const API_BASE = "/dashboard/api";
export const CONFIG_API_BASE = `${API_BASE}/config`;
export const VERSION_API_BASE = `${API_BASE}/version`;

export const CAPTURE_DONE_EVENT = "umans-gate:capture-done";

/** Window event dispatched by useCapturesSocket when a `usage-sample` WS
 *  message arrives (ticket 07). `detail` carries the day to refresh. */
export const USAGE_SAMPLE_EVENT = "umans-gate:usage-sample";

/** Window event dispatched by useCapturesSocket when a `usage-event` WS
 *  message arrives (ticket 07). `detail` carries the tupleKind + transition. */
export const USAGE_EVENT_EVENT = "umans-gate:usage-event";

export interface UsageSampleWsDetail {
  dayUtc: string;
  fetchedAt: number;
}

export interface UsageEventWsDetail {
  dayUtc: string;
  tupleKind: "priority" | "service_mode";
  transition: "onset" | "resolved" | "morph";
  fetchedAt: number;
}

/** Maximum captures retained in the frontend list. Matches the REST fetch limit
 *  so WS-driven growth doesn't diverge from the server's ring buffer. */
export const MAX_CAPTURES = 200;
