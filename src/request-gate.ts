export interface RequestGateStats {
  /** Unweighted upstream window count. */
  requestsInWindow: number;
  /** Upstream limits.requests.hard_cap. */
  requestsHardCap: number | null;
  /** Upstream limits.requests.limit (tier). */
  requestsLimit: number | null;
}

export interface RequestGateDecision {
  /** True => reject 503 locally. */
  block: boolean;
  /** Effective cap chosen (null when no limit known). */
  cap: number | null;
  /** cap - margin (null when no cap). */
  threshold: number | null;
}

/**
 * Decide whether to gate a request on the upstream UNWEIGHTED
 * requests-in-window count crossing (hardCap - margin).
 *
 * Effective cap prefers the field selected by `useHardCap`, falling back
 * to the other field when the chosen one is null. When no limit is known
 * at all (both null), block is false and cap/threshold are null.
 */
export function computeRequestGateDecision(
  stats: RequestGateStats,
  margin: number,
  useHardCap: boolean,
): RequestGateDecision {
  const sanitizedMargin = Number.isFinite(margin) ? Math.max(0, Math.floor(margin)) : 0;

  const chosen = useHardCap ? stats.requestsHardCap : stats.requestsLimit;
  const fallback = useHardCap ? stats.requestsLimit : stats.requestsHardCap;
  const cap = chosen ?? fallback;

  if (cap === null) {
    return { block: false, cap: null, threshold: null };
  }

  // A margin at or above the cap is a misconfiguration: the threshold would
  // collapse and reject every request. Fall back to a zero buffer so the gate
  // still rejects only when the window actually crosses the cap.
  const effectiveMargin = sanitizedMargin >= cap ? 0 : sanitizedMargin;
  const threshold = Math.max(0, cap - effectiveMargin);
  const block = stats.requestsInWindow >= threshold;

  return { block, cap, threshold };
}
