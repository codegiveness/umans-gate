import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fmtDurationUntil, fmtUtcDateTime, fmtUtcTime } from "@/lib/format";

const FROZEN_NOW = Date.UTC(2026, 6, 23, 12, 0, 0);

// Pinned epoch-ms: 2026-01-15T14:32:05.000Z (UTC).
// UTC hour = 14. In several common local timezones this lands at a
// different wall-clock hour (e.g. UTC+8 → 22:32, UTC-5 → 09:32), so a
// local-timezone regression is visible in the assertion.
const TS_UTC_AFTERNOON = Date.UTC(2026, 0, 15, 14, 32, 5); // Jan 15 2026 14:32:05Z

describe("fmtUtcTime", () => {
  it("formats a known epoch-ms as HH:mm:ss in UTC", () => {
    expect(fmtUtcTime(TS_UTC_AFTERNOON)).toBe("14:32:05");
  });

  it("returns empty string for null", () => {
    expect(fmtUtcTime(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(fmtUtcTime(undefined)).toBe("");
  });

  it("returns empty string for 0", () => {
    expect(fmtUtcTime(0)).toBe("");
  });

  it("pads single-digit hours/minutes/seconds", () => {
    // 2026-01-15T03:05:09.000Z
    const ts = Date.UTC(2026, 0, 15, 3, 5, 9);
    expect(fmtUtcTime(ts)).toBe("03:05:09");
  });
});

describe("fmtDurationUntil", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats future timestamp with hours and minutes", () => {
    expect(fmtDurationUntil(FROZEN_NOW + 3 * 60 * 60 * 1000 + 15 * 60 * 1000)).toBe("3h 15m");
  });

  it("formats future timestamp with minutes only", () => {
    expect(fmtDurationUntil(FROZEN_NOW + 42 * 60 * 1000)).toBe("42m");
  });

  it("returns 'now' for near-zero future timestamps", () => {
    expect(fmtDurationUntil(FROZEN_NOW + 1000)).toBe("now");
    expect(fmtDurationUntil(FROZEN_NOW - 1000)).toBe("now");
  });

  it("returns empty string for past timestamps", () => {
    expect(fmtDurationUntil(FROZEN_NOW - 60 * 1000)).toBe("");
  });

  it("returns empty string for null", () => {
    expect(fmtDurationUntil(null)).toBe("");
  });

  it("returns empty string for 0", () => {
    expect(fmtDurationUntil(0)).toBe("");
  });
});

describe("fmtUtcDateTime", () => {
  it("formats a known epoch-ms as MMM d, yyyy, HH:mm:ss in UTC", () => {
    expect(fmtUtcDateTime(TS_UTC_AFTERNOON)).toBe("Jan 15, 2026, 14:32:05");
  });

  it("returns empty string for null", () => {
    expect(fmtUtcDateTime(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(fmtUtcDateTime(undefined)).toBe("");
  });

  it("returns empty string for 0", () => {
    expect(fmtUtcDateTime(0)).toBe("");
  });

  it("does not zero-pad the day", () => {
    // 2026-01-05T03:05:09.000Z → day 5, not "05"
    const ts = Date.UTC(2026, 0, 5, 3, 5, 9);
    expect(fmtUtcDateTime(ts)).toBe("Jan 5, 2026, 03:05:09");
  });
});
