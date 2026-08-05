import { act, fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FieldRow } from "@/components/config-fields";
import type { FieldDef } from "@/components/config-sections";
import { CANONICAL_STAMP_MODEL_RULES } from "@/components/config-sections";
import { flushEffects } from "@/test/utils";

const DEEPSEEK_PATTERN = "umans-deepseek-v4-flash-0731";

describe("CANONICAL_STAMP_MODEL_RULES — umans-deepseek-v4-flash-0731", () => {
  it("ships a per-model rule that stamps {type:enabled} thinking on both routes", () => {
    const entry = CANONICAL_STAMP_MODEL_RULES.find((c) => c.pattern === DEEPSEEK_PATTERN);
    expect(entry).toBeDefined();
    expect(entry?.rule.pattern).toBe(DEEPSEEK_PATTERN);
    expect(entry?.rule.anthropic_thinking_shape).toEqual({ type: "enabled" });
    expect(entry?.rule.openai_thinking_shape).toEqual({ type: "enabled" });
    expect(entry?.rule.force_thinking_when_absent).toBe(true);
  });
});

describe("ModelRulesRenderer — deepseek toggle", () => {
  const def: FieldDef = {
    key: "stamp_model_rules",
    label: "Model Rules",
    kind: "modelRules",
  };

  function deepseekSwitch(container: HTMLElement): HTMLElement {
    const label = within(container)
      .getByText(/DeepSeek V4 Flash/i)
      .closest("label");
    expect(label).not.toBeNull();
    return within(label as HTMLElement).getByRole("switch");
  }

  it("toggling deepseek ON writes the canonical both-routes rule into stamp_model_rules", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <FieldRow def={def} value={[]} onChange={onChange} dirty={false} values={{} as never} />,
    );
    await flushEffects();

    const sw = deepseekSwitch(container);
    await act(async () => {
      fireEvent.click(sw);
    });

    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({
        pattern: DEEPSEEK_PATTERN,
        anthropic_thinking_shape: { type: "enabled" },
        openai_thinking_shape: { type: "enabled" },
        force_thinking_when_absent: true,
      }),
    ]);
  });
});
