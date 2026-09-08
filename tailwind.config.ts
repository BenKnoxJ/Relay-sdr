import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";
import animate from "tailwindcss-animate";

import {
  BACKGROUND_IMAGE,
  BORDER_WIDTH,
  BOX_SHADOW,
  GRID_TEMPLATE_COLUMNS,
  MAX_WIDTH,
  MIN_HEIGHT,
  NON_PAINT_COLORS,
  RADIUS,
  SHADCN_COLOR_KEYS,
  SPACING,
  kebab,
} from "./src/lib/theme-keys";
import { colorNames, fonts, layouts, scale, type } from "./src/lib/tokens";

/**
 * The Tailwind theme is a projection of `src/lib/tokens.ts` (the signed §21
 * design system). Nothing here is a design decision and no value is written
 * out by hand — the names live in `src/lib/theme-keys.ts` and
 * `tests/ui/tailwind.test.ts` holds all of it to the tokens.
 *
 * Colours resolve through the CSS custom properties in `src/app/tokens.css`
 * rather than the hex itself, so one Tailwind class renders correctly in both
 * themes: `bg-panel` is white in light and `#1B1D28` in dark, because
 * `--relay-panel` changed underneath it.
 */

const rem = (n: number) => `${n / 16}rem`;

/** A CSS `font-family` stack for one of the two signed faces. */
const stack = (face: keyof typeof fonts) =>
  [`var(--font-${face})`, ...fonts[face].fallback].join(", ");

/**
 * The signed table gives some roles more than one value ("400/500", "11–12").
 * `src/lib/tokens.ts` carries those as an array with the primary first.
 * `Array.isArray` does not narrow a `readonly` tuple, hence the explicit test.
 */
const primary = (value: number | readonly number[]): number =>
  typeof value === "number" ? value : (value[0] as number);

const relayColors: Record<string, string> = Object.fromEntries(
  colorNames
    .filter((name) => !(NON_PAINT_COLORS as readonly string[]).includes(name))
    .map((name) => [kebab(name), `var(--relay-${kebab(name)})`]),
);

const shadcnColors: Record<string, string> = Object.fromEntries(
  SHADCN_COLOR_KEYS.map((name) => [name, `hsl(var(--${name}))`]),
);

const palette = { ...relayColors, ...shadcnColors };

/** The nine sizes of the scale, as `text-11` … `text-26`, and nothing else. */
const scaleSizes: Record<string, string> = Object.fromEntries(
  scale.map((size) => [String(size), rem(size)]),
);

/**
 * The type roles as complete `.type-*` classes.
 *
 * A `fontSize` entry can only carry size, line height, letter spacing and
 * weight — it has no way to express the family, the uppercasing on `label`,
 * its `muted` colour, or `tabular-nums` on the mono roles. A `text-mono` that
 * silently rendered in Poppins with proportional figures would be worse than
 * no class at all, so the roles are emitted as components instead, each one
 * the whole row of the signed §2 table.
 */
const typeRoles = plugin(({ addBase, addComponents }) => {
  /**
   * Tailwind bakes `--tw-ring-color` into preflight by applying the ring
   * opacity to `theme.ringColor.DEFAULT`. It cannot apply an alpha to a CSS
   * variable in any form — neither `var(--relay-action)` nor
   * `hsl(var(--ring) / <alpha-value>)` parses, and both fall through to its own
   * hard-coded blue-300. So a bare `focus:ring-2` comes out Tailwind blue while
   * the config reads correctly, which is the worst kind of wrong. Overriding
   * the variable in the base layer is the only thing that actually moves it;
   * `tests/ui/tailwind.test.ts` asserts the effective value in the built sheet.
   */
  addBase({ "*, ::before, ::after": { "--tw-ring-color": "var(--relay-action)" } });

  addComponents(
    Object.fromEntries(
      Object.entries(type).map(([role, spec]) => [
        `.type-${kebab(role)}`,
        {
          fontFamily: stack(spec.family),
          fontWeight: String(primary(spec.weight)),
          fontSize: rem(primary(spec.size)),
          ...(spec.lineHeight === null ? {} : { lineHeight: String(spec.lineHeight) }),
          ...(spec.letterSpacing === null ? {} : { letterSpacing: spec.letterSpacing }),
          ...("transform" in spec ? { textTransform: spec.transform } : {}),
          ...("color" in spec ? { color: `var(--relay-${kebab(spec.color)})` } : {}),
          ...("numeric" in spec ? { fontVariantNumeric: spec.numeric } : {}),
        },
      ]),
    ),
  );
});

export default {
  content: ["./src/**/*.{ts,tsx}"],

  /**
   * Theme is an attribute, not a class: the root carries `data-theme`, so the
   * custom properties and the `dark:` variant switch on one thing. The root is
   * always stamped (`src/app/layout.tsx`); nothing falls back to the system
   * preference, because a fallback could only move one of those two.
   */
  darkMode: ["selector", '[data-theme="dark"]'],

  corePlugins: {
    /**
     * OFF, and load-bearing. This plugin emits a `.shadow-<colour>` utility for
     * every key in the palette — including `card`, which is also a shadow name.
     * Its rule is generated after `boxShadow`, so `.shadow-card` would end up
     * meaning "shadow coloured like the card surface" and the signed card
     * shadow would render as opaque white. Relay's shadows take their colour
     * from `--relay-shadow` and follow the theme; a per-element shadow colour
     * is off-doctrine anyway.
     */
    boxShadowColor: false,
  },

  theme: {
    /**
     * `colors`, `fontSize` and `boxShadow` REPLACE Tailwind's defaults rather
     * than extending them. The signed file says "one accent", "nothing
     * off-scale", and names exactly two shadows; leaving the stock palette,
     * the stock `text-xs … text-9xl` and the stock `shadow-sm … shadow-2xl`
     * in place would leave `bg-red-500`, `text-3xl` and `shadow-md` one
     * keystroke away, and a rule nothing enforces is not a rule. Anything
     * genuinely missing is added to the signed file first.
     */
    colors: {
      transparent: "transparent",
      current: "currentColor",
      inherit: "inherit",
      ...palette,
    },

    fontSize: scaleSizes,

    /**
     * `card` and `nav`, and nothing else — not even `shadow-none`. A card is
     * the only thing that carries a shadow (signed §3) and the floating nav
     * pill is the one exception, so there is nothing to turn off.
     */
    boxShadow: BOX_SHADOW,

    /**
     * Replacing `colors` also resets everything derived from it, and the
     * derived DEFAULTS are what a bare `border` or `ring-2` uses. Left alone
     * they fall back to Tailwind's own — `currentColor` for a border (so a
     * hairline paints in ink), and blue-500 for a focus ring. Both are stated
     * in the signed file, so both are set from the tokens here.
     */
    borderColor: ({ theme }) => ({ ...theme("colors"), DEFAULT: "var(--relay-line)" }),
    ringColor: ({ theme }) => ({ ...theme("colors"), DEFAULT: "var(--relay-action)" }),
    ringOffsetColor: ({ theme }) => ({ ...theme("colors"), DEFAULT: "var(--relay-ground)" }),

    /**
     * The one name the two systems fight over, separated by the property it
     * applies to. `text-muted` is the signed secondary text grey; `bg-muted`
     * is shadcn's soft surface, so its canonical `bg-muted text-muted-foreground`
     * pair renders correctly instead of grey on grey. Relay never wants
     * `bg-muted` — `muted` is a text colour in the signed table.
     */
    backgroundColor: ({ theme }) => ({ ...theme("colors"), muted: "hsl(var(--muted))" }),

    extend: {
      fontFamily: {
        // The variables are set by `next/font` in `src/app/layout.tsx`. The
        // fallbacks are repeated here on purpose: `next/font` bakes them into
        // the variable, and these cover the case where the variable is missing
        // entirely (a component rendered outside the root layout).
        sans: [`var(--font-sans)`, ...fonts.sans.fallback],
        mono: [`var(--font-mono)`, ...fonts.mono.fallback],
      },

      borderRadius: RADIUS,
      borderWidth: BORDER_WIDTH,
      backgroundImage: BACKGROUND_IMAGE,
      spacing: SPACING,
      minHeight: MIN_HEIGHT,
      maxWidth: MAX_WIDTH,
      gridTemplateColumns: GRID_TEMPLATE_COLUMNS,

      screens: {
        // Above this, the two-column layouts apply; below, single column.
        wide: `${layouts.singleColumnBelow}px`,
      },
    },
  },

  // `animate` is here so a later `shadcn add` renders correctly on arrival;
  // §22.8 still governs what may animate ("nothing animates unless it changed").
  plugins: [typeRoles, animate],
} satisfies Config;
