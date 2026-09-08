/**
 * `tailwind.config.ts` is the second consumer of the tokens (the first is the
 * generated stylesheet). It was also the one with no test: a hand-typed
 * "65ch" or a forgotten fallback stack in there passes typecheck, lint, build
 * and every other gate, and only shows up as a screen that is subtly off the
 * signed design.
 *
 * These assertions resolve the real config through Tailwind's own resolver,
 * so they check what Tailwind will actually use rather than re-reading the
 * source.
 */

import resolveConfig from "tailwindcss/resolveConfig";
import { describe, expect, it } from "vitest";

import config from "../../tailwind.config";
import {
  BORDER_WIDTH_KEYS,
  BOX_SHADOW_KEYS,
  MAX_WIDTH_KEYS,
  MIN_HEIGHT_KEYS,
  NON_PAINT_COLORS,
  SHADCN_COLOR_KEYS,
  SPACING_KEYS,
} from "@/lib/theme-keys";
import { cn } from "@/lib/utils";
import {
  bodyMaxWidth,
  border,
  colorNames,
  fonts,
  layouts,
  radius,
  scale,
  shadow,
  space,
  type,
} from "@/lib/tokens";

const resolved = resolveConfig(config);
const theme = resolved.theme;

/**
 * The theme sections are built with `Object.fromEntries`, so their literal key
 * types are gone by the time the resolver sees them. These read a section by
 * name without arguing with the inferred type.
 */
const at = (section: unknown, name: string): unknown =>
  (section as Record<string, unknown>)[name];
const colorOf = (name: string): unknown => at(theme.colors, name);

describe("tailwind theme", () => {
  it("resolves every paint colour through the theme variable, not a hex", () => {
    for (const name of colorNames) {
      const key = name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      if ((NON_PAINT_COLORS as readonly string[]).includes(name)) {
        // Not paint: reachable only as `bg-wordmark` / `shadow-*`.
        expect(colorOf(key)).toBeUndefined();
        continue;
      }
      expect(colorOf(key)).toBe(`var(--relay-${key})`);
    }
  });

  /**
   * `fontSize` REPLACES Tailwind's defaults rather than extending them. If it
   * extended, `text-3xl` would still compile and "nothing off-scale" would be
   * a comment rather than a rule.
   */
  it("offers the eight scale sizes and NOTHING else — no text-xs, no text-9xl", () => {
    expect(Object.keys(theme.fontSize ?? {}).sort((a, b) => Number(a) - Number(b))).toEqual(
      scale.map(String),
    );
    for (const size of scale) {
      expect(at(theme.fontSize, String(size))).toBe(`${size / 16}rem`);
    }
  });

  /** Same argument for the palette: `bg-red-500` must not compile. */
  it("offers the signed palette and NOTHING else — no stock Tailwind colours", () => {
    const expected = [
      "transparent",
      "current",
      "inherit",
      ...colorNames
        .filter((n) => !(NON_PAINT_COLORS as readonly string[]).includes(n))
        .map((n) => n.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)),
      ...SHADCN_COLOR_KEYS,
    ].sort();
    expect(Object.keys(theme.colors ?? {}).sort()).toEqual(expected);
  });

  it("builds both font stacks from the tokens", () => {
    expect(theme.fontFamily?.sans).toEqual(["var(--font-sans)", ...fonts.sans.fallback]);
    expect(theme.fontFamily?.mono).toEqual(["var(--font-mono)", ...fonts.mono.fallback]);
  });

  it("takes radii, borders, shadows and the measure from the tokens", () => {
    for (const [key, value] of Object.entries(radius)) {
      expect(at(theme.borderRadius, key)).toBe(`${value}px`);
    }
    expect(at(theme.borderWidth, "hairline")).toBe(`${border.hairline}px`);
    // `control`, not `input`: `border-input` is already shadcn's border colour.
    expect(at(theme.borderWidth, "control")).toBe(`${border.input}px`);
    expect(at(theme.borderWidth, "input")).toBeUndefined();
    expect(at(theme.boxShadow, "card")).toBe(`${shadow.card} var(--relay-shadow)`);
    expect(at(theme.boxShadow, "nav")).toBe(`${shadow.nav} var(--relay-shadow)`);
    expect(at(theme.maxWidth, "measure")).toBe(bodyMaxWidth);
    expect(at(theme.spacing, "card")).toBe(`${space.padCard[0]}px`);
    expect(at(theme.spacing, "card-rail")).toBe(`${space.padCard[1]}px`);
    expect(at(theme.spacing, "row-x")).toBe(`${space.padRow.x}px`);
    expect(at(theme.spacing, "grid")).toBe(`${space.gapGrid}px`);
    expect(at(theme.spacing, "chips")).toBe(`${space.gapChips}px`);
    expect(at(theme.minHeight, "row")).toBe(`${space.rowHeight[0]}px`);
    expect(at(theme.minHeight, "row-tall")).toBe(`${space.rowHeight[1]}px`);
  });

  it("takes the layouts and the single-column breakpoint from the tokens", () => {
    expect(at(theme.gridTemplateColumns, "home")).toBe(layouts.home);
    expect(at(theme.gridTemplateColumns, "inbox")).toBe(layouts.inbox);
    expect(at(theme.gridTemplateColumns, "campaign")).toBe(layouts.campaign);
    expect(at(theme.screens, "wide")).toBe(`${layouts.singleColumnBelow}px`);
  });

  it("binds the dark variant to the same attribute the stylesheet keys off", () => {
    expect(config.darkMode).toEqual(["selector", '[data-theme="dark"]']);
  });

  it("gives shadcn its colour names, so an added component is not unstyled", () => {
    for (const name of ["background", "foreground", "primary", "primary-foreground", "border", "ring"]) {
      expect(colorOf(name)).toBe(`hsl(var(--${name}))`);
    }
    expect(at(theme.borderRadius, "lg")).toBe("var(--radius)");
  });

  /**
   * The one name the two systems fight over. shadcn means a background by
   * `muted`; the signed file means the secondary text colour, and the signed
   * name wins. Pinned so that the first `shadcn add` finds this test rather
   * than a dark-grey block on the page.
   */
  /**
   * The one name the two systems fight over. `text-muted` must stay the signed
   * secondary grey; `bg-muted` must be shadcn's soft surface, or its canonical
   * `bg-muted text-muted-foreground` pair renders grey on grey.
   */
  it("splits `muted` by property: signed text colour, shadcn surface", () => {
    expect(colorOf("muted")).toBe("var(--relay-muted)");
    expect(at(theme.backgroundColor, "muted")).toBe("hsl(var(--muted))");
    expect(at(theme.textColor, "muted")).toBe("var(--relay-muted)");
    expect(colorOf("muted-foreground")).toBe("hsl(var(--muted-foreground))");
  });

  /**
   * Replacing `theme.colors` resets everything derived from it, and the
   * derived DEFAULTS are what a bare `border` or `ring-2` uses. Unset, a
   * hairline paints in ink (`currentColor`) and a focus ring comes out
   * Tailwind blue — both off the signed palette, both silent.
   */
  it("defaults borders and focus rings to signed colours, not Tailwind's", () => {
    expect(at(theme.borderColor, "DEFAULT")).toBe("var(--relay-line)");
    expect(at(theme.ringColor, "DEFAULT")).toBe("var(--relay-action)");
    expect(at(theme.ringOffsetColor, "DEFAULT")).toBe("var(--relay-ground)");
  });

  /**
   * `src/lib/theme-keys.ts` is the single list of Tailwind key names, read by
   * this config AND by `cn()` in `src/lib/utils.ts`. If the two drifted, the
   * classes would still compile but stop overriding each other — silent. This
   * is the check that they have not.
   */
  it("emits exactly the key names cn() has been told about", () => {
    for (const key of SPACING_KEYS) expect(at(theme.spacing, key)).toBeDefined();
    for (const key of BORDER_WIDTH_KEYS) expect(at(theme.borderWidth, key)).toBeDefined();
    for (const key of MIN_HEIGHT_KEYS) expect(at(theme.minHeight, key)).toBeDefined();
    for (const key of MAX_WIDTH_KEYS) expect(at(theme.maxWidth, key)).toBeDefined();
    for (const key of SHADCN_COLOR_KEYS) expect(colorOf(key)).toBe(`hsl(var(--${key}))`);
  });
});

describe("type roles", () => {
  it("emits one complete class per signed role", async () => {
    // Compile the plugin's output rather than trusting the config object:
    // `addComponents` runs inside Tailwind, not at config time.
    const postcss = (await import("postcss")).default;
    const tailwindcss = (await import("tailwindcss")).default;

    const css = await postcss([
      tailwindcss({
        ...config,
        content: [{ raw: Object.keys(type).map((r) => `type-${r.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`).join(" ") }],
      }),
    ]).process("@tailwind components;", { from: undefined });

    // `label` carries the uppercase and the muted colour a fontSize entry
    // cannot express; `mono` carries the family and the tabular figures.
    expect(css.css).toContain("text-transform: uppercase");
    expect(css.css).toContain("var(--relay-muted)");
    expect(css.css).toContain("var(--font-mono)");
    expect(css.css).toContain("font-variant-numeric: tabular-nums");
    expect(css.css).toContain(".type-mono-big");
    expect(css.css).toContain(`font-size: ${type.display.size / 16}rem`);
  });
});

/**
 * These compile the real config and read the emitted rules. The theme object
 * alone cannot show them: the defects they cover are produced by Tailwind's
 * own plugins on top of the theme, not by anything in the config.
 */
describe("compiled output", () => {
  async function compile(markup: string): Promise<string> {
    const postcss = (await import("postcss")).default;
    const tailwindcss = (await import("tailwindcss")).default;
    const result = await postcss([
      tailwindcss({ ...config, content: [{ raw: markup }] }),
    ]).process("@tailwind base;@tailwind components;@tailwind utilities;", { from: undefined });
    return result.css;
  }

  /**
   * `boxShadowColor` emits a `.shadow-<colour>` utility for every palette key,
   * and `card` is both a shadow name and a shadcn colour. Its rule lands after
   * `boxShadow`, so with the plugin on, `.shadow-card` stops meaning the
   * signed card shadow and becomes "shadow coloured like the card surface" —
   * an opaque white shadow in light theme, product-wide, in silence.
   */
  it("emits the signed card shadow, not a shadow the colour of the card", async () => {
    const css = await compile("shadow-card shadow-nav");
    for (const key of BOX_SHADOW_KEYS) {
      const rules = css.match(new RegExp(String.raw`\.shadow-${key}\s*\{[^}]*\}`, "g"));
      // Exactly one rule per name. A second, later one is the collision.
      expect(rules).toHaveLength(1);
      expect(rules?.[0]).toContain("--tw-shadow: 0 ");
      expect(rules?.[0]).toContain("var(--relay-shadow)");
    }
  });

  it("paints a bare hairline in the signed line colour", async () => {
    const css = await compile("border border-hairline");
    expect(css).toContain("--relay-line");
  });

  it("has no Tailwind blue focus ring left in the sheet", async () => {
    const css = await compile("ring-2 ring-offset-2 focus:ring-2");
    // Tailwind's own blue is emitted by preflight and cannot be configured
    // away (see the addBase note in tailwind.config.ts). What matters is which
    // declaration wins, so assert the last one — the effective value.
    const ringColors = css.match(/--tw-ring-color: [^;]*/g) ?? [];
    expect(ringColors.length).toBeGreaterThan(0);
    expect(ringColors.at(-1)).toBe("--tw-ring-color: var(--relay-action)");
    expect(css).toContain("--tw-ring-offset-color: var(--relay-ground)");
  });

  it("does not compile an off-palette colour or an off-scale size", async () => {
    const css = await compile("bg-red-500 text-3xl text-xs");
    expect(css).not.toContain(".bg-red-500");
    expect(css).not.toContain(".text-3xl");
    expect(css).not.toContain(".text-xs");
  });
});

describe("cn", () => {
  it("resolves the custom spacing scale, so an override actually overrides", () => {
    // Unconfigured, tailwind-merge does not know `p-card` and keeps both —
    // and `.p-4` is emitted after `.p-card`, so the caller silently loses.
    expect(cn("p-card", "p-4")).toBe("p-4");
    expect(cn("rounded-card", "rounded-pill")).toBe("rounded-pill");
    expect(cn("min-h-row", "min-h-row-tall")).toBe("min-h-row-tall");
    expect(cn("border-hairline", "border-control")).toBe("border-control");
    expect(cn("type-body", "type-display")).toBe("type-display");
  });

  it("keeps a custom size and a colour together instead of dropping one", () => {
    // Unconfigured, tailwind-merge reads `text-14` as a colour and this
    // collapses to `text-ink` — the size silently vanishes.
    expect(cn("text-14", "text-ink").split(" ").sort()).toEqual(["text-14", "text-ink"]);
    expect(cn("text-11", "text-muted").split(" ").sort()).toEqual(["text-11", "text-muted"]);
  });

  it("still resolves a genuine conflict, last one winning", () => {
    expect(cn("text-14", "text-24")).toBe("text-24");
    expect(cn("bg-ground", "bg-panel")).toBe("bg-panel");
    expect(cn("shadow-card", "shadow-nav")).toBe("shadow-nav");
  });

  it("does not confuse the gradient background with a background colour", () => {
    expect(cn("bg-wordmark", "bg-panel").split(" ").sort()).toEqual(["bg-panel", "bg-wordmark"]);
  });
});
