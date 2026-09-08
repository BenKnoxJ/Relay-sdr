/**
 * The signed design system, executed.
 *
 * `products/relay/design/relay-tokens.md` (v1.0, signed by Benny-san
 * 2026-09-08) is the authority. The fixtures below are transcribed from its
 * tables by hand, on purpose: if `src/lib/tokens.ts` and the fixture were
 * derived from each other the test would only prove the file equals itself.
 * A reviewer checks the fixture against the signed file; the test then holds
 * the code to the fixture.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  TOKENS_CSS_PATH,
  cssVar,
  hexToHslTriplet,
  renderTokensCss,
} from "../../scripts/tokens-css";
import {
  bodyMaxWidth,
  border,
  colorNames,
  colors,
  dotGrid,
  fonts,
  layouts,
  radius,
  scale,
  shadow,
  space,
  themes,
  type,
} from "@/lib/tokens";

// ── Fixtures, transcribed from the signed file ─────────────────────────────

/** Signed file §1, the colour table. */
const SIGNED_COLORS = {
  light: {
    ground: "#F7F7FB",
    panel: "#FFFFFF",
    ink: "#272F4A",
    muted: "#6B7280",
    line: "#E6E8EF",
    action: "#804EE7",
    onAction: "#FFFFFF",
    soft: "#F1EBFD",
    warn: "#B45309",
    warnBg: "#FFF4E5",
    dot: "rgba(39,47,74,.10)",
    shadow: "rgba(39,47,74,.08)",
    gradient: "linear-gradient(90deg,#7B5CFF 0%,#B055C8 45%,#FD910C 100%)",
  },
  dark: {
    ground: "#13141C",
    panel: "#1B1D28",
    ink: "#ECEEF5",
    muted: "#9AA0B3",
    line: "#2A2D3C",
    action: "#A07CF5",
    onAction: "#FFFFFF",
    soft: "#2A2340",
    warn: "#F5B04C",
    warnBg: "#3A2A12",
    dot: "rgba(236,238,245,.07)",
    shadow: "rgba(0,0,0,.35)",
    gradient: "linear-gradient(90deg,#7B5CFF 0%,#B055C8 45%,#FD910C 100%)",
  },
} as const;

/** Signed file §2, the type table. Arrays carry the primary value first. */
const SIGNED_TYPE = {
  display: { family: "sans", weight: 700, size: 24, lineHeight: 1.15, letterSpacing: "-0.015em" },
  heading: { family: "sans", weight: 700, size: 20, lineHeight: 1.2, letterSpacing: null },
  name: { family: "sans", weight: 600, size: [16, 14], lineHeight: 1.3, letterSpacing: null },
  body: { family: "sans", weight: 400, size: 14, lineHeight: 1.6, letterSpacing: null },
  bodyLarge: { family: "sans", weight: 400, size: 15, lineHeight: 1.55, letterSpacing: null },
  small: {
    family: "sans",
    weight: [400, 500],
    size: [13, 12],
    lineHeight: 1.5,
    letterSpacing: null,
  },
  label: {
    family: "sans",
    weight: 600,
    size: [11, 12],
    lineHeight: null,
    letterSpacing: "0.1em",
    transform: "uppercase",
    color: "muted",
  },
  mono: {
    family: "mono",
    weight: [400, 500],
    size: [11, 12, 13],
    lineHeight: null,
    letterSpacing: null,
    numeric: "tabular-nums",
  },
  monoBig: {
    family: "mono",
    weight: 500,
    size: 26,
    lineHeight: null,
    letterSpacing: null,
    numeric: "tabular-nums",
  },
} as const;

/** Signed file §3, shape and space. */
const SIGNED_SHAPE = {
  radius: { card: 16, input: 12, pill: 999, frame: 18 },
  space: {
    padCard: [22, 18],
    padRow: { y: [11, 14], x: 20 },
    rowHeight: [48, 52],
    gapGrid: 16,
    gapChips: 8,
  },
  shadow: { card: "0 6px 24px", nav: "0 4px 18px" },
  border: { hairline: 1, input: 1.5 },
  layouts: {
    home: "1.5fr 1fr",
    inbox: "340px 1fr",
    campaign: "1.4fr 1fr",
    singleColumnBelow: 820,
  },
} as const;

// ── Contrast, per WCAG 2.1 relative luminance ──────────────────────────────

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (match === null) {
    throw new Error(`Contrast is only defined for an opaque six-digit hex; received ${hex}.`);
  }
  const n = parseInt(match[1] as string, 16);
  return (
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255)
  );
}

/** Rounded down to two places: a ratio must clear the floor, not round up to it. */
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  const ratio = (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  return Math.floor(ratio * 100) / 100;
}

describe("contrast helper", () => {
  it("agrees with the two ratios everybody knows", () => {
    expect(contrast("#000000", "#FFFFFF")).toBe(21);
    expect(contrast("#FFFFFF", "#FFFFFF")).toBe(1);
  });
});

// ── The tokens themselves ──────────────────────────────────────────────────

describe("tokens", () => {
  it("carries exactly the colours the signed file lists, for both themes", () => {
    expect(colors).toEqual(SIGNED_COLORS);
  });

  it("names every colour token, in signed-table order", () => {
    expect([...colorNames]).toEqual(Object.keys(SIGNED_COLORS.light));
    for (const theme of themes) {
      expect(Object.keys(colors[theme])).toEqual([...colorNames]);
    }
  });

  it("carries exactly the type roles the signed file lists", () => {
    expect(type).toEqual(SIGNED_TYPE);
  });

  it("carries the signed shape, space, shadow, border and layout values", () => {
    expect({ radius, space, shadow, border, layouts }).toEqual(SIGNED_SHAPE);
  });

  it("carries the signed type scale and body measure", () => {
    expect([...scale]).toEqual([11, 12, 13, 14, 15, 16, 20, 24]);
    expect(bodyMaxWidth).toBe("65ch");
  });

  it("carries the signed dot grid and font stacks", () => {
    expect(dotGrid).toEqual({ dotSize: 1, tile: 22 });
    expect(fonts.sans.name).toBe("Poppins");
    expect([...fonts.sans.weights]).toEqual(["400", "500", "600", "700"]);
    expect([...fonts.sans.fallback]).toEqual(["system-ui", "sans-serif"]);
    expect(fonts.mono.name).toBe("IBM Plex Mono");
    expect([...fonts.mono.weights]).toEqual(["400", "500"]);
    expect([...fonts.mono.fallback]).toEqual(["ui-monospace", "monospace"]);
  });

  it("keeps every type size on the scale, apart from the one the signed file contradicts itself on", () => {
    const offScale: Record<string, number[]> = {};
    for (const [role, spec] of Object.entries(type)) {
      const sizes: number[] = Array.isArray(spec.size) ? [...spec.size] : [spec.size];
      const bad = sizes.filter((s) => !(scale as readonly number[]).includes(s));
      if (bad.length > 0) offScale[role] = bad;
    }

    // The signed file says "Nothing off-scale" in §2 and then gives `monoBig`
    // a size of 26, which is not one of the eight. Pinned rather than
    // resolved: fixing it is a design decision, and this assertion fails the
    // moment either half changes, so it cannot be forgotten.
    expect(offScale).toEqual({ monoBig: [26] });
  });
});

// ── The contrast floors the signed file demands ────────────────────────────

describe("contrast", () => {
  const floors = [
    { pair: ["ink", "panel"], floor: 7 },
    { pair: ["muted", "panel"], floor: 4.5 },
    { pair: ["warn", "warnBg"], floor: 4.5 },
  ] as const;

  for (const theme of themes) {
    for (const { pair, floor } of floors) {
      const [fg, bg] = pair;
      it(`${theme}: ${fg} on ${bg} clears ${floor}:1`, () => {
        expect(contrast(colors[theme][fg], colors[theme][bg])).toBeGreaterThanOrEqual(floor);
      });
    }
  }

  it("light: onAction on action clears 4.5:1", () => {
    expect(contrast(colors.light.onAction, colors.light.action)).toBeGreaterThanOrEqual(4.5);
  });

  /**
   * The one place the signed palette misses its own floor.
   *
   * §1 sets dark `onAction` to `#FFFFFF` and dark `action` to `#A07CF5`, and
   * then requires `onAction` on `action` to clear 4.5:1 in BOTH themes. White
   * on that violet is 3.13:1 — it fails for a 14px/600 button label (AA large
   * text is 3:1, and a button label is not large text).
   *
   * Forge does not settle signed design. The measured value is pinned instead,
   * so the shortfall cannot widen unnoticed and cannot be "fixed" without this
   * test failing and forcing the pair back into the list above.
   *
   * Recommendation awaiting Benny-san's sign-off: leave dark `action` alone
   * (the master doc §21 names it) and set dark `onAction` to the dark ground
   * `#13141C`, which measures 5.85:1 — a dark label on a light-violet button.
   */
  it("dark: onAction on action is pinned below the signed floor, pending sign-off", () => {
    expect(contrast(colors.dark.onAction, colors.dark.action)).toBe(3.13);
    expect(contrast("#13141C", colors.dark.action)).toBe(5.85);
  });
});

// ── The generated stylesheet ───────────────────────────────────────────────

describe("tokens.css", () => {
  const onDisk = readFileSync(path.join(process.cwd(), TOKENS_CSS_PATH), "utf8");
  const globals = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");

  it("is exactly what the tokens render, with no hand edits", () => {
    expect(onDisk).toBe(renderTokensCss());
  });

  it("declares every colour token for both themes", () => {
    for (const theme of themes) {
      for (const name of colorNames) {
        expect(onDisk).toContain(`${cssVar(name)}: ${colors[theme][name]};`);
      }
    }
  });

  it("paints the ground and the dot grid on the body, from the hand-written half", () => {
    expect(globals).toContain(`background-color: var(${cssVar("ground")});`);
    expect(globals).toContain(`var(${cssVar("dot")}) ${dotGrid.dotSize}px`);
    expect(globals).toContain(`background-size: ${dotGrid.tile}px ${dotGrid.tile}px;`);
    expect(globals).toContain(`color: var(${cssVar("ink")});`);
  });

  /**
   * `components.json` points the shadcn CLI at `globals.css`, and a
   * `shadcn add` writes into it. That file therefore must NOT be the generated
   * one, or an `add` either fails the `tokens:check` build gate or is wiped by
   * the next regeneration.
   */
  it("is a separate file from the hand-written stylesheet, which imports it", () => {
    expect(TOKENS_CSS_PATH).not.toBe("src/app/globals.css");
    expect(globals).toContain('@import "./tokens.css";');
    expect(globals).not.toContain("GENERATED FILE");
  });

  it("stamps a colour-scheme for both themes, keyed off the one attribute", () => {
    expect(onDisk).toContain("color-scheme: light;");
    expect(onDisk).toContain("color-scheme: dark;");
    expect(onDisk).toContain(':root[data-theme="dark"]');
  });

  /**
   * There is deliberately no `prefers-color-scheme` fallback. Tailwind's
   * `dark:` variant is bound to `[data-theme="dark"]`, so a palette that could
   * switch without the attribute switching would leave the custom properties
   * in one theme and every `dark:` utility in the other. The root is always
   * stamped instead — `tests/ui/layout.test.tsx` holds the layout to that.
   */
  it("has no second way to switch theme", () => {
    expect(onDisk).not.toContain("@media (prefers-color-scheme");
  });

  it("gives shadcn its variables from the Relay tokens, not its own palette", () => {
    // If a `shadcn add` ever lands, `--primary` has to be Relay's violet.
    expect(onDisk).toContain(`--primary: ${hexToHslTriplet(colors.light.action)};`);
    expect(onDisk).toContain(`--background: ${hexToHslTriplet(colors.dark.ground)};`);
    expect(onDisk).toContain(`--radius: ${radius.card}px;`);
  });
});

describe("hexToHslTriplet", () => {
  it("converts the values shadcn will be handed", () => {
    expect(hexToHslTriplet("#FFFFFF")).toBe("0 0% 100%");
    expect(hexToHslTriplet("#000000")).toBe("0 0% 0%");
    expect(hexToHslTriplet("#804EE7")).toBe("259.6 76.1% 60.6%");
  });

  it("refuses a value that is not an opaque hex, rather than emitting nonsense", () => {
    expect(() => hexToHslTriplet(colors.light.dot)).toThrow(/six-digit hex/);
    expect(() => hexToHslTriplet(colors.light.gradient)).toThrow(/six-digit hex/);
  });
});
