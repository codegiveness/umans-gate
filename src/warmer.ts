// Upstream connection warmer — prevents TLS handshake overhead on the first
// request after startup or extended idle (saves ~750ms cold-start latency).
// Pings a lightweight upstream endpoint on a fixed interval, but skips
// the ping whenever the proxy handled real traffic in the last interval.

import { createLogger } from "./logger.js";
import type { ProxyConfig, UpstreamProtocol } from "./types.js";

const log = createLogger("warmer");

export class ConnectionWarmer {
  private readonly target: string;
  private readonly intervalMs: number;
  private readonly path: string;
  private readonly upstreamProtocol: UpstreamProtocol;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTrafficAt = 0;
  private warmedOnce = false;

  constructor(
    config: Pick<ProxyConfig, "target" | "warmerIntervalMs" | "warmerPath" | "upstreamProtocol">,
  ) {
    this.target = config.target;
    this.intervalMs = config.warmerIntervalMs;
    this.path = config.warmerPath;
    this.upstreamProtocol = config.upstreamProtocol;
  }

  start(): void {
    if (this.timer || this.intervalMs <= 0) return;
    void this.ping();
    this.timer = setInterval(() => void this.ping(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Called by the proxy on every upstream request — connection is already warm. */
  notifyTraffic(): void {
    this.lastTrafficAt = Date.now();
  }

  private async ping(): Promise<void> {
    if (Date.now() - this.lastTrafficAt < this.intervalMs) return;
    const url = `${this.target}${this.path}`;
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { "accept-encoding": "identity" },
        protocol: this.upstreamProtocol as unknown as never,
      });
      if (!this.warmedOnce && res.ok) {
        this.warmedOnce = true;
        log.info(`upstream warm: ${url} (${res.status})`);
      }
    } catch {
      // Silent — warmer is best-effort. Next interval will retry.
    }
  }
}
