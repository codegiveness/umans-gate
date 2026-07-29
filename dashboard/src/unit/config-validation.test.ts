import { describe, expect, it } from "vitest";

import type { FieldDef } from "@/components/config-sections";
import type { RawConfig } from "@/hooks/use-config";
import { validateConfigDraft } from "@/lib/config-validation";

function makeField(overrides: Partial<FieldDef>): FieldDef {
  return {
    key: "concurrency_hard_cap",
    label: "Hard Cap",
    kind: "number",
    ...overrides,
  } as FieldDef;
}

describe("validateConfigDraft", () => {
  it("skips validation for disabled fields even when value violates min", () => {
    const draft = { concurrency_soft_limit: 0 } as RawConfig;
    const sections = [
      {
        fields: [
          makeField({
            key: "concurrency_soft_limit",
            label: "Soft Limit",
            kind: "number",
            min: 1,
            disabled: true,
          }),
        ],
      },
    ];
    const result = validateConfigDraft(draft, sections);
    expect(result.errors).toEqual({});
  });

  it("validates enabled fields with the same min constraint", () => {
    const draft = { concurrency_hard_cap: 0 } as RawConfig;
    const sections = [
      {
        fields: [
          makeField({ key: "concurrency_hard_cap", label: "Hard Cap", kind: "number", min: 1 }),
        ],
      },
    ];
    const result = validateConfigDraft(draft, sections);
    expect(result.errors.concurrency_hard_cap).toBe("Hard Cap must be ≥ 1");
  });

  it("returns no errors when all fields are valid", () => {
    const draft = { concurrency_hard_cap: 5 } as RawConfig;
    const sections = [
      {
        fields: [
          makeField({ key: "concurrency_hard_cap", label: "Hard Cap", kind: "number", min: 1 }),
        ],
      },
    ];
    const result = validateConfigDraft(draft, sections);
    expect(result.errors).toEqual({});
  });

  it("returns warning for rate_limit_requests=-1", () => {
    const draft = { rate_limit_requests: -1 } as RawConfig;
    const sections = [
      {
        fields: [
          makeField({
            key: "rate_limit_requests",
            label: "Requests",
            kind: "number",
            min: -1,
          }),
        ],
      },
    ];
    const result = validateConfigDraft(draft, sections);
    expect(result.errors).toEqual({});
    expect(result.warnings.rate_limit_requests).toContain("Unlimited");
  });

  it("returns no warning for rate_limit_requests=0", () => {
    const draft = { rate_limit_requests: 0 } as RawConfig;
    const sections = [
      {
        fields: [
          makeField({
            key: "rate_limit_requests",
            label: "Requests",
            kind: "number",
            min: -1,
          }),
        ],
      },
    ];
    const result = validateConfigDraft(draft, sections);
    expect(result.warnings).toEqual({});
  });

  it("returns warning for rate_limit_requests='-1' (string from NumberInput)", () => {
    const draft = { rate_limit_requests: "-1" } as unknown as RawConfig;
    const sections = [
      {
        fields: [
          makeField({
            key: "rate_limit_requests",
            label: "Requests",
            kind: "number",
            min: -1,
          }),
        ],
      },
    ];
    const result = validateConfigDraft(draft, sections);
    expect(result.errors).toEqual({});
    expect(result.warnings.rate_limit_requests).toContain("Unlimited");
  });
});
