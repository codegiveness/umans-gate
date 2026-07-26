import { act, render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FieldRow } from "@/components/config-fields";
import type { FieldDef } from "@/components/config-sections";
import type { RawConfig } from "@/hooks/use-config";
import { useConfigDraft } from "@/hooks/use-config-draft";
import { flushEffects } from "@/test/utils";

// Minimal RawConfig for testing — only needs the dependsOn target field.
const makeValues = (overrides: Partial<RawConfig> = {}): RawConfig =>
  ({
    stamp_claude_code_enabled: false,
    ...overrides,
  }) as RawConfig;

const toggleDef: FieldDef = {
  key: "stamp_glm_5_2_thinking_enabled",
  label: "GLM 5.2 Thinking",
  kind: "toggle",
  dependsOn: "stamp_claude_code_enabled",
};

const booleanDef: FieldDef = {
  key: "stamp_glm_5_2_thinking_enabled",
  label: "GLM 5.2 Thinking",
  kind: "boolean",
  dependsOn: "stamp_claude_code_enabled",
};

async function renderFieldRow(def: FieldDef, values: RawConfig) {
  const result = render(
    <FieldRow def={def} value={false} onChange={() => {}} dirty={false} values={values} />,
  );
  await flushEffects();
  return result;
}

function getSwitch(): HTMLElement {
  // Base UI Switch renders role="switch" on the root element.
  return screen.getByRole("switch");
}

describe("FieldRow dependsOn", () => {
  it("disables Toggle Switch when dependsOn field is falsy", async () => {
    const values = makeValues({ stamp_claude_code_enabled: false });
    await renderFieldRow(toggleDef, values);
    expect(getSwitch()).toHaveAttribute("data-disabled");
  });

  it("enables Toggle Switch when dependsOn field is truthy", async () => {
    const values = makeValues({ stamp_claude_code_enabled: true });
    await renderFieldRow(toggleDef, values);
    expect(getSwitch()).not.toHaveAttribute("data-disabled");
  });

  it("disables Boolean Switch when dependsOn field is falsy", async () => {
    const values = makeValues({ stamp_claude_code_enabled: false });
    await renderFieldRow(booleanDef, values);
    expect(getSwitch()).toHaveAttribute("data-disabled");
  });

  it("enables Boolean Switch when dependsOn field is truthy", async () => {
    const values = makeValues({ stamp_claude_code_enabled: true });
    await renderFieldRow(booleanDef, values);
    expect(getSwitch()).not.toHaveAttribute("data-disabled");
  });

  it("does not disable Switch when no dependsOn set", async () => {
    const values = makeValues({ stamp_claude_code_enabled: false });
    const noDeps: FieldDef = { ...toggleDef, dependsOn: undefined };
    await renderFieldRow(noDeps, values);
    expect(getSwitch()).not.toHaveAttribute("data-disabled");
  });

  it("disables Switch when def.disabled is true (static)", async () => {
    const values = makeValues({ stamp_claude_code_enabled: false });
    const staticDisabled: FieldDef = { ...toggleDef, dependsOn: undefined, disabled: true };
    await renderFieldRow(staticDisabled, values);
    expect(getSwitch()).toHaveAttribute("data-disabled");
  });

  it("disables Switch when def.disabled is true even if dependsOn is truthy (static wins)", async () => {
    const values = makeValues({ stamp_claude_code_enabled: true });
    const both: FieldDef = { ...toggleDef, disabled: true };
    await renderFieldRow(both, values);
    expect(getSwitch()).toHaveAttribute("data-disabled");
  });
});

describe("useConfigDraft auto-reset", () => {
  it("resets stamp_glm_5_2_thinking_enabled to false when parent stamp turns off", () => {
    const initial: RawConfig = {
      stamp_claude_code_enabled: true,
      stamp_glm_5_2_thinking_enabled: true,
    } as RawConfig;
    const { result } = renderHook(() => useConfigDraft(initial));
    act(() => {
      result.current.updateField("stamp_claude_code_enabled", false);
    });
    expect(result.current.draft?.stamp_claude_code_enabled).toBe(false);
    expect(result.current.draft?.stamp_glm_5_2_thinking_enabled).toBe(false);
  });

  it("does not reset child when parent turns on", () => {
    const initial: RawConfig = {
      stamp_claude_code_enabled: false,
      stamp_glm_5_2_thinking_enabled: false,
    } as RawConfig;
    const { result } = renderHook(() => useConfigDraft(initial));
    act(() => {
      result.current.updateField("stamp_claude_code_enabled", true);
    });
    expect(result.current.draft?.stamp_claude_code_enabled).toBe(true);
    expect(result.current.draft?.stamp_glm_5_2_thinking_enabled).toBe(false);
  });

  it("resets stamp_kimi_k2_7_code_thinking_enabled to false when parent stamp turns off", () => {
    const initial: RawConfig = {
      stamp_claude_code_enabled: true,
      stamp_kimi_k2_7_code_thinking_enabled: true,
    } as RawConfig;
    const { result } = renderHook(() => useConfigDraft(initial));
    act(() => {
      result.current.updateField("stamp_claude_code_enabled", false);
    });
    expect(result.current.draft?.stamp_claude_code_enabled).toBe(false);
    expect(result.current.draft?.stamp_kimi_k2_7_code_thinking_enabled).toBe(false);
  });

  it("resets both GLM and Kimi children when parent turns off", () => {
    const initial: RawConfig = {
      stamp_claude_code_enabled: true,
      stamp_glm_5_2_thinking_enabled: true,
      stamp_kimi_k2_7_code_thinking_enabled: true,
    } as RawConfig;
    const { result } = renderHook(() => useConfigDraft(initial));
    act(() => {
      result.current.updateField("stamp_claude_code_enabled", false);
    });
    expect(result.current.draft?.stamp_claude_code_enabled).toBe(false);
    expect(result.current.draft?.stamp_glm_5_2_thinking_enabled).toBe(false);
    expect(result.current.draft?.stamp_kimi_k2_7_code_thinking_enabled).toBe(false);
  });
});
