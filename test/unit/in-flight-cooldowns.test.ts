import { describe, expect, test } from "bun:test";
import { InFlightCooldowns } from "../../src/in-flight-cooldowns.js";
import type { CaptureState } from "../../src/types.js";

type Row = { id: number; state: CaptureState; retry_attempt?: number | null };

describe("InFlightCooldowns", () => {
  test("enrich returns input unchanged when no entries", () => {
    const tracker = new InFlightCooldowns();
    const rows: Row[] = [{ id: 1, state: "streaming" }];
    expect(tracker.enrich(rows)).toBe(rows);
  });

  test("enrich rewrites streaming→cooling_down for matching id", () => {
    const tracker = new InFlightCooldowns();
    const endsAt = Date.now() + 30000;
    tracker.start(5, 1, endsAt);
    const result = tracker.enrich<Row>([
      { id: 5, state: "streaming" },
      { id: 6, state: "streaming" },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].state).toBe("cooling_down");
    expect(result[0]).toHaveProperty("cooldownEndsAt", endsAt);
    expect(result[0]).toHaveProperty("retryAttempt", 1);
    expect(result[1].state).toBe("streaming");
  });

  test("clear removes entry so enrich no longer rewrites", () => {
    const tracker = new InFlightCooldowns();
    tracker.start(1, 2, Date.now() + 30000);
    tracker.clear(1);
    const result = tracker.enrich<Row>([{ id: 1, state: "streaming" }]);
    expect(result[0].state).toBe("streaming");
  });

  test("expired entries are pruned during enrich", () => {
    const tracker = new InFlightCooldowns();
    tracker.start(1, 1, Date.now() - 1);
    const result = tracker.enrich<Row>([{ id: 1, state: "streaming" }]);
    expect(result[0].state).toBe("streaming");
    expect(tracker.size()).toBe(0);
  });

  test("does not rewrite non-streaming states", () => {
    const tracker = new InFlightCooldowns();
    tracker.start(1, 1, Date.now() + 30000);
    const result = tracker.enrich<Row>([
      { id: 1, state: "done" },
      { id: 1, state: "failed" },
    ]);
    expect(result[0].state).toBe("done");
    expect(result[1].state).toBe("failed");
  });

  test("enrich returns same array reference when no mutation needed", () => {
    const tracker = new InFlightCooldowns();
    tracker.start(1, 1, Date.now() + 30000);
    const rows: Row[] = [{ id: 1, state: "done" }];
    expect(tracker.enrich(rows)).toBe(rows);
  });

  test("rewrites enqueued→cooling_down when cooldown entry exists", () => {
    const tracker = new InFlightCooldowns();
    const endsAt = Date.now() + 30000;
    tracker.start(3, 1, endsAt);
    const result = tracker.enrich<Row>([{ id: 3, state: "enqueued" }]);
    expect(result[0].state).toBe("cooling_down");
    expect(result[0]).toHaveProperty("cooldownEndsAt", endsAt);
    expect(result[0]).toHaveProperty("retryAttempt", 1);
  });
});
