import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { App } from "@/App";
import { flushEffects } from "@/test/utils";

vi.mock("@/hooks/use-captures", () => ({
  useCaptures: () => ({
    captures: [],
    selectedCapture: null,
    isLoadingDetail: false,
    isLoadingList: false,
    wsState: "down" as const,
    selectedId: null,
    gateStats: null,
    listError: null,
    gateError: null,
    detailError: null,
    selectCapture: () => {},
    clearCaptures: () => {},
    retryList: () => {},
    retryGate: () => {},
    retryDetail: () => {},
  }),
}));

vi.mock("@/hooks/use-clipboard", () => ({
  useClipboard: () => ({
    copyText: () => Promise.resolve(true),
  }),
}));

vi.mock("@/components/mode-toggle", () => ({
  ModeToggle: () => null,
}));

vi.mock("@/components/ui/sonner", () => ({
  Toaster: () => null,
}));

// WCAG 2.2 AA contrast-ratio assertions — parse index.css at test time,
// extract :root and .dark vars, compute sRGB relative-luminance contrast
// against each theme background, and assert thresholds:
//   text ≥4.5:1 (WCAG 1.4.3), UI/graphical ≥3.0:1 (WCAG 1.4.11).

const CSS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "index.css");

type Hsla = { h: number; s: number; l: number; a: number };

function parseHsla(raw: string): Hsla | null {
  const trimmed = raw.trim();
  const match = trimmed.match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%(?:\s*\/\s*([\d.]+)%)?$/);
  if (!match) return null;
  const [, hStr, sStr, lStr, aStr] = match;
  return {
    h: Number(hStr),
    s: Number(sStr),
    l: Number(lStr),
    a: aStr === undefined ? 1 : Number(aStr) / 100,
  };
}

function extractThemeVars(css: string): {
  root: Record<string, string>;
  dark: Record<string, string>;
} {
  const root: Record<string, string> = {};
  const dark: Record<string, string> = {};

  const captureBlock = (selector: string): string | null => {
    const pattern = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`);
    const match = pattern.exec(css);
    if (!match) return null;
    const braceOpen = match.index + match[0].length - 1;
    let depth = 0;
    for (let i = braceOpen; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") {
        depth--;
        if (depth === 0) return css.slice(braceOpen + 1, i);
      }
    }
    return null;
  };

  for (const [selector, target] of [
    [":root", root],
    [".dark", dark],
  ] as const) {
    const block = captureBlock(selector);
    if (!block) continue;
    const varRegex = /--([\w-]+)\s*:\s*([^;]+);/g;
    for (const match of block.matchAll(varRegex)) {
      target[match[1]] = match[2].trim();
    }
  }

  return { root, dark };
}

/** HSL (0-360, 0-100, 0-100) → sRGB channels in [0,1]. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = h / 360;
  const sat = s / 100;
  const light = l / 100;

  if (sat === 0) {
    return [light, light, light];
  }

  const hueToRgb = (p: number, q: number, t: number): number => {
    const tt = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };

  const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
  const p = 2 * light - q;
  const r = hueToRgb(p, q, hue + 1 / 3);
  const g = hueToRgb(p, q, hue);
  const b = hueToRgb(p, q, hue - 1 / 3);
  return [r, g, b];
}

/** WCAG sRGB channel linearization: c <= 0.04045 ? c/12.92 : ((c+0.055)/1.055)^2.4 */
function linearize(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance, alpha-compositing color over backdrop when needed. */
function relativeLuminance(color: Hsla, backdrop: Hsla): number {
  const a = color.a;
  const [cr, cg, cb] = hslToRgb(color.h, color.s, color.l);
  if (a === 1) {
    return 0.2126 * linearize(cr) + 0.7152 * linearize(cg) + 0.0722 * linearize(cb);
  }
  const [br, bg, bb] = hslToRgb(backdrop.h, backdrop.s, backdrop.l);
  const mix = (fg: number, bgc: number): number => fg * a + bgc * (1 - a);
  const r2 = mix(cr, br);
  const g2 = mix(cg, bg);
  const b2 = mix(cb, bb);
  return 0.2126 * linearize(r2) + 0.7152 * linearize(g2) + 0.0722 * linearize(b2);
}

/** WCAG contrast ratio: (L_lighter + 0.05) / (L_darker + 0.05). */
function contrastRatio(fg: Hsla, bg: Hsla): number {
  // Compositing bg over itself yields its opaque luminance (a=1 early-return).
  const l1 = relativeLuminance(fg, bg);
  const l2 = relativeLuminance(bg, bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

const cssSource = readFileSync(CSS_PATH, "utf8");
const themeVars = extractThemeVars(cssSource);

function tokenHsla(theme: "root" | "dark", token: string): Hsla {
  const vars = themeVars[theme];
  const raw = vars[token];
  if (!raw) throw new Error(`--${token} not found in ${theme} theme`);
  const parsed = parseHsla(raw);
  if (!parsed) throw new Error(`--${token} value "${raw}" is not valid HSL(A)`);
  return parsed;
}

function bgHsla(theme: "root" | "dark"): Hsla {
  return tokenHsla(theme, "background");
}

const LIGHT_BG = bgHsla("root");
const DARK_BG = bgHsla("dark");

describe("App accessibility structure", () => {
  it("renders exactly one h1 (the app name)", async () => {
    render(<App />);
    await flushEffects();
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent("umans-gate");
  });

  it("renders a skip link pointing to #main", async () => {
    render(<App />);
    await flushEffects();
    const skipLink = screen.getByText("Skip to content");
    expect(skipLink.tagName).toBe("A");
    expect(skipLink).toHaveAttribute("href", "#main");
  });

  it("wraps tab content in a main landmark with id=main", async () => {
    render(<App />);
    await flushEffects();
    const main = screen.getByRole("main", { name: "Inspector" });
    expect(main).toHaveAttribute("id", "main");
  });
});

describe("light theme WCAG contrast ratios (:root vs background)", () => {
  const TEXT_THRESHOLD = 4.5;
  const UI_THRESHOLD = 3.0;

  // --border (0 0% 85%, ~1.41:1) is decorative — WCAG 1.4.11 exempts purely
  // decorative boundaries. Not asserted; see ADR-0010 and DESIGN.md.

  it("--muted-foreground meets text threshold (≥4.5:1)", () => {
    const fg = tokenHsla("root", "muted-foreground");
    expect(contrastRatio(fg, LIGHT_BG)).toBeGreaterThanOrEqual(TEXT_THRESHOLD);
  });

  it("--ring meets UI/focus threshold (≥3.0:1)", () => {
    const fg = tokenHsla("root", "ring");
    expect(contrastRatio(fg, LIGHT_BG)).toBeGreaterThanOrEqual(UI_THRESHOLD);
  });

  it("--input meets functional UI threshold (≥3.0:1)", () => {
    const fg = tokenHsla("root", "input");
    expect(contrastRatio(fg, LIGHT_BG)).toBeGreaterThanOrEqual(UI_THRESHOLD);
  });

  it.each([1, 2, 3, 4, 5] as const)("--chart-%i meets graphical-object threshold (≥3.0:1)", (n) => {
    const fg = tokenHsla("root", `chart-${n}`);
    expect(contrastRatio(fg, LIGHT_BG)).toBeGreaterThanOrEqual(UI_THRESHOLD);
  });

  it("--sidebar-primary meets UI threshold (≥3.0:1)", () => {
    const fg = tokenHsla("root", "sidebar-primary");
    expect(contrastRatio(fg, LIGHT_BG)).toBeGreaterThanOrEqual(UI_THRESHOLD);
  });

  it("--sidebar-ring meets UI threshold (≥3.0:1)", () => {
    const fg = tokenHsla("root", "sidebar-ring");
    expect(contrastRatio(fg, LIGHT_BG)).toBeGreaterThanOrEqual(UI_THRESHOLD);
  });
});

describe("dark theme WCAG contrast ratios (.dark vs background)", () => {
  const UI_THRESHOLD = 3.0;
  const TEXT_THRESHOLD = 4.5;

  it.each([1, 2, 3, 4, 5] as const)("--chart-%i meets graphical-object threshold (≥3.0:1)", (n) => {
    const fg = tokenHsla("dark", `chart-${n}`);
    expect(contrastRatio(fg, DARK_BG)).toBeGreaterThanOrEqual(UI_THRESHOLD);
  });

  it("--ring meets UI/focus threshold (≥3.0:1)", () => {
    const fg = tokenHsla("dark", "ring");
    expect(contrastRatio(fg, DARK_BG)).toBeGreaterThanOrEqual(UI_THRESHOLD);
  });

  it("--sidebar-ring meets UI threshold (≥3.0:1)", () => {
    const fg = tokenHsla("dark", "sidebar-ring");
    expect(contrastRatio(fg, DARK_BG)).toBeGreaterThanOrEqual(UI_THRESHOLD);
  });

  // --destructive-foreground on --destructive (button text on red fill)
  it("--destructive-foreground on --destructive meets text threshold (≥4.5:1)", () => {
    const fg = tokenHsla("dark", "destructive-foreground");
    const bg = tokenHsla("dark", "destructive");
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(TEXT_THRESHOLD);
  });

  // --sidebar-primary-foreground on --sidebar-primary (button text on violet fill)
  it("--sidebar-primary-foreground on --sidebar-primary meets text threshold (≥4.5:1)", () => {
    const fg = tokenHsla("dark", "sidebar-primary-foreground");
    const bg = tokenHsla("dark", "sidebar-primary");
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(TEXT_THRESHOLD);
  });

  // --input is a functional border (alpha-blended white over dark bg)
  it("--input meets functional UI threshold (≥3.0:1)", () => {
    const fg = tokenHsla("dark", "input");
    expect(contrastRatio(fg, DARK_BG)).toBeGreaterThanOrEqual(UI_THRESHOLD);
  });
});

// Tooltip secondary text uses text-background/70 on bg-foreground.
// Verify the composited pair meets text threshold in both themes.
describe("tooltip secondary text WCAG contrast (background/70 on foreground)", () => {
  const TEXT_THRESHOLD = 4.5;

  it("light theme: --background at 70% alpha on --foreground meets text threshold (≥4.5:1)", () => {
    const secondary = { ...tokenHsla("root", "background"), a: 0.7 };
    const tooltipBg = tokenHsla("root", "foreground");
    expect(contrastRatio(secondary, tooltipBg)).toBeGreaterThanOrEqual(TEXT_THRESHOLD);
  });

  it("dark theme: --background at 70% alpha on --foreground meets text threshold (≥4.5:1)", () => {
    const secondary = { ...tokenHsla("dark", "background"), a: 0.7 };
    const tooltipBg = tokenHsla("dark", "foreground");
    expect(contrastRatio(secondary, tooltipBg)).toBeGreaterThanOrEqual(TEXT_THRESHOLD);
  });
});
