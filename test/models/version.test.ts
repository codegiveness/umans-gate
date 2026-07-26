import { describe, expect, it } from "bun:test";
import { modelVersionMatches } from "../../src/models/version.js";

describe("modelVersionMatches", () => {
  it("matches exact version segment in GLM model name", () => {
    expect(modelVersionMatches("umans-glm-5.2", "5.2")).toBe(true);
  });

  it("does not match when version segment is absent", () => {
    expect(modelVersionMatches("umans-glm-5.1", "5.2")).toBe(false);
  });

  it("matches version segment with suffix", () => {
    expect(modelVersionMatches("umans-glm-5.2-turbo", "5.2")).toBe(true);
  });

  it("matches via substring (5.22 contains '5.2' — acceptable per spec)", () => {
    expect(modelVersionMatches("umans-glm-5.22", "5.2")).toBe(true);
  });

  it("returns false for undefined model name", () => {
    expect(modelVersionMatches(undefined, "5.2")).toBe(false);
  });

  it("returns false for empty model name", () => {
    expect(modelVersionMatches("", "5.2")).toBe(false);
  });

  it("matches Kimi k2.7-code target segment", () => {
    expect(modelVersionMatches("umans-kimi-k2.7-code", "k2.7-code")).toBe(true);
  });

  it("does not match Kimi target when version differs", () => {
    expect(modelVersionMatches("umans-kimi-k2.6", "k2.7-code")).toBe(false);
  });

  it("matches Kimi k2.7-code with highspeed suffix", () => {
    expect(modelVersionMatches("umans-kimi-k2.7-code-highspeed", "k2.7-code")).toBe(true);
  });

  it("returns false for empty target version", () => {
    // Empty target would match everything via includes; guard against it.
    expect(modelVersionMatches("umans-glm-5.2", "")).toBe(false);
  });
});
