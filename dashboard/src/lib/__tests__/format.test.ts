import { describe, expect, it } from "vitest";

import { fmtUtcDateTime, fmtUtcTime } from "@/lib/format";

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
