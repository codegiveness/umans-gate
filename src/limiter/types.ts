import type { BreakerState, GateConfig, ProxyConfig } from "../types.js";

export type { BreakerState };

/** Raw config keys that should trigger a gate reconfigure on reload. */
export const GATE_RECONFIG_FIELDS = new Set<keyof ProxyConfig>([
  "breakerThreshold",
  "breakerWindowMs",
  "breakerCooldownMs",
  "queueTimeoutMs",
  "maxQueueDepth",
  "releaseCooldownMs",
  "concurrencyMainReservation",
  "concurrencyVisionReservation",
]);

export const SCALE = 1000;

export interface Waiter {
  resolve: (permit: Permit) => void;
  reject: (e: GateError) => void;
  enqueuedAt: number;
  weight: number;
  intention: string;
  signal?: AbortSignal;
  onAcquire?: () => void;
  timeout: ReturnType<typeof setTimeout>;
  wasProbe?: boolean;
}

export interface Permit {
  release: () => void;
}

export interface ConcurrencyGateOptions {
  hardCap: number;
  softLimit: number;
  releaseCooldownMs: number;
  breakerThreshold: number;
  breakerWindowMs: number;
  breakerCooldownMs: number;
  maxQueueDepth: number;
  queueTimeoutMs: number;
  intentions?: Record<string, number>;
}

export class GateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GateError";
    this.code = code;
  }
}

export function gateOptionsFromConfig(config: GateConfig): ConcurrencyGateOptions {
  return {
    hardCap: config.concurrencyHardCap,
    softLimit: config.concurrencySoftLimit,
    releaseCooldownMs: config.releaseCooldownMs,
    breakerThreshold: config.breakerThreshold,
    breakerWindowMs: config.breakerWindowMs,
    breakerCooldownMs: config.breakerCooldownMs,
    maxQueueDepth: config.maxQueueDepth,
    queueTimeoutMs: config.queueTimeoutMs,
    intentions: {
      main: config.concurrencyMainReservation,
      vision: config.concurrencyVisionReservation,
    },
  };
}
