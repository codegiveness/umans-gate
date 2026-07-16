export const API_BASE = "/dashboard/api";
export const CONFIG_API_BASE = `${API_BASE}/config`;

export const CAPTURE_DONE_EVENT = "umans-gate:capture-done";

/** Maximum captures retained in the frontend list. Matches the REST fetch limit
 *  so WS-driven growth doesn't diverge from the server's ring buffer. */
export const MAX_CAPTURES = 200;
