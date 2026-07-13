// Zero-dependency in-memory metrics registry.
// Exposes counters and gauges in Prometheus text exposition format.
// Designed for single-process Bun — no external collector required.

export type MetricType = "counter" | "gauge";

interface MetricEntry {
  type: MetricType;
  help: string;
  value: number;
  labels?: Record<string, string>;
}

/** In-memory metrics registry with Prometheus text format export. */
export class MetricsRegistry {
  private metrics = new Map<string, MetricEntry>();

  /** Increment a counter by n (default 1). Creates the metric if missing. */
  inc(name: string, n = 1, help?: string): void {
    const existing = this.metrics.get(name);
    if (existing) {
      existing.value += n;
    } else {
      this.metrics.set(name, {
        type: "counter",
        help: help ?? name,
        value: n,
      });
    }
  }

  /** Set a gauge to a specific value. Creates the metric if missing. */
  set(name: string, value: number, help?: string): void {
    const existing = this.metrics.get(name);
    if (existing) {
      existing.value = value;
    } else {
      this.metrics.set(name, {
        type: "gauge",
        help: help ?? name,
        value,
      });
    }
  }

  /** Get the current value of a metric. */
  get(name: string): number | undefined {
    return this.metrics.get(name)?.value;
  }

  /** Serialize all metrics to Prometheus text exposition format. */
  format(): string {
    const lines: string[] = [];
    const sorted = [...this.metrics.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [name, entry] of sorted) {
      lines.push(`# HELP ${name} ${entry.help}`);
      lines.push(`# TYPE ${name} ${entry.type}`);
      lines.push(`${name} ${entry.value}`);
    }
    return `${lines.join("\n")}\n`;
  }

  /** Reset all counters (not gauges). Used for testing. */
  resetCounters(): void {
    for (const entry of this.metrics.values()) {
      if (entry.type === "counter") entry.value = 0;
    }
  }
}

/** Singleton registry for the process. */
export const metrics = new MetricsRegistry();
