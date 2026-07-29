// Poll-until-condition helper for replacing fixed sleep(N) waits in tests.
//
// Fixed sleeps waste wall time when the condition is met early and flake on
// CI when the work is slower than expected. pollUntil checks a predicate on
// a tight interval and returns as soon as it passes, with a hard timeout so
// genuine failures surface loudly instead of silently padding.
//
// See Bun team's own test guidance:
//   "never wait for time to pass in tests. Always wait for the condition to
//    be met instead of waiting for an arbitrary amount of time."
//   https://github.com/oven-sh/bun/blob/main/test/CLAUDE.md

/** Options for {@link pollUntil}. */
export interface PollUntilOptions {
  /** Max total wait time in ms. Default 5000. */
  timeout?: number;
  /** Interval between checks in ms. Default 10. */
  interval?: number;
}

const DEFAULT_TIMEOUT = 5000;
const DEFAULT_INTERVAL = 10;

/**
 * Poll a predicate until it returns truthy, or until the timeout elapses.
 *
 * The predicate may be sync or async. A thrown error does not abort polling —
 * the predicate is retried until it either returns truthy or the timeout
 * fires, at which point the last error (if any) is included in the failure
 * message.
 *
 * @throws Error if the predicate does not pass within the timeout.
 */
export async function pollUntil(
  predicate: () => boolean | Promise<boolean>,
  options: PollUntilOptions = {},
): Promise<void> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const interval = options.interval ?? DEFAULT_INTERVAL;
  const deadline = Date.now() + timeout;
  let lastErr: unknown;

  for (;;) {
    try {
      if (await predicate()) return;
    } catch (err) {
      lastErr = err;
    }
    if (Date.now() >= deadline) {
      const errDetail = lastErr
        ? ` (last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)})`
        : "";
      throw new Error(`pollUntil timed out after ${timeout}ms${errDetail}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

/**
 * Poll a predicate that returns a value. Resolves with the first non-null,
 * non-undefined result. Rejects on timeout.
 */
export async function pollFor<T>(
  fn: () => T | Promise<T> | null | undefined,
  options: PollUntilOptions = {},
): Promise<T> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const interval = options.interval ?? DEFAULT_INTERVAL;
  const deadline = Date.now() + timeout;
  let lastErr: unknown;

  for (;;) {
    try {
      const result = await fn();
      if (result !== null && result !== undefined) return result;
    } catch (err) {
      lastErr = err;
    }
    if (Date.now() >= deadline) {
      const errDetail = lastErr
        ? ` (last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)})`
        : "";
      throw new Error(`pollFor timed out after ${timeout}ms${errDetail}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}
