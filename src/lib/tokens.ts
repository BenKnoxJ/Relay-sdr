/**
 * Relay design tokens — the single source for every colour, size, radius and
 * space in the product.
 *
 * Transcribed from the SIGNED design system file:
 *   `products/relay/design/relay-tokens.md`, v1.0, signed by Benny-san
 *   2026-09-08 (master doc §21, LOCKED).
 *
 * Rules for this file:
 *
 *  - It is data. No computed values, no imports, no logic. Everything is
 *    `as const` so a wrong value is a type error at the use site rather than a
 *    silent restyle.
 *  - Nothing else in the repository may hard-code a colour, a radius or a font
 *    size. `tailwind.config.ts` reads this file; `src/app/globals.css` is
 *    GENERATED from it by `scripts/tokens-css.ts`; components read the Tailwind
 *    classes. That is the whole chain, and `tests/ui/tokens.test.ts` holds it
 *    to the signed values.
 *  - Changing a value here is changing the signed design. It needs Benny-san's
 *    sign-off on the design file first, then this file, then the fixture in
 *    `tests/ui/tokens.test.ts`.
 *
 * Where the signed table gives more than one value for a role ("400/500",
 * "11–12", "16 (button labels 14)"), this file carries an array with the
 * primary value FIRST and the secondary use after it.
 */

export const themes = ["light", "dark"] as const;
export type Theme = (typeof themes)[number];

/**
 * Colour — signed file §1.
 *
 * One accent. Violet is the action colour and appears on one control per card
 * and on evidence ticks. The gradient lives in the wordmark and a page-title
 * phrase only. Orange is not a second accent; teal is not used. Semantic
 * `warn` is separate from the accent and does not count as one.
 */
export const colors = {
  light: {
    /** page background, under the dot grid */
    ground: "#F7F7FB",
    /** cards, nav */
    panel: "#FFFFFF",
    /** text, headings */
    ink: "#272F4A",
    /** secondary text, labels, mono counts */
    muted: "#6B7280",
    /** hairlines, borders */
    line: "#E6E8EF",
    /** primary button, active nav underline, ticks, count badge */
    action: "#804EE7",
    /** text on `action` */
    onAction: "#FFFFFF",
    /** selected row, evidence line background, ok chip background */
    soft: "#F1EBFD",
    /** needs-you, paused, stopped */
    warn: "#B45309",
    /** warn chip and banner background */
    warnBg: "#FFF4E5",
    /** dot-grid mark */
    dot: "rgba(39,47,74,.10)",
    /** card shadow colour */
    shadow: "rgba(39,47,74,.08)",
    /** wordmark, one page-title phrase per page, nothing else */
    gradient: "linear-gradient(90deg,#7B5CFF 0%,#B055C8 45%,#FD910C 100%)",
  },
  dark: {
    ground: "#13141C",
    panel: "#1B1D28",
    ink: "#ECEEF5",
    muted: "#9AA0B3",
    line: "#2A2D3C",
    action: "#A07CF5",
    /**
     * SIGNED as `#FFFFFF`, and white on `#A07CF5` measures 3.13:1 — below the
     * 4.5:1 floor the same signed file demands. The signed value is kept here
     * rather than quietly corrected; the shortfall is pinned by an explicit
     * test in `tests/ui/tokens.test.ts` so it can neither widen nor be
     * silently "fixed". See that test for the recommendation awaiting
     * sign-off.
     */
    onAction: "#FFFFFF",
    soft: "#2A2340",
    warn: "#F5B04C",
    warnBg: "#3A2A12",
    dot: "rgba(236,238,245,.07)",
    shadow: "rgba(0,0,0,.35)",
    /** "same" in the signed table — the gradient does not change with theme. */
    gradient: "linear-gradient(90deg,#7B5CFF 0%,#B055C8 45%,#FD910C 100%)",
  },
} as const;

/** Every colour token name, in signed-table order. */
export const colorNames = [
  "ground",
  "panel",
  "ink",
  "muted",
  "line",
  "action",
  "onAction",
  "soft",
  "warn",
  "warnBg",
  "dot",
  "shadow",
  "gradient",
] as const;

export type ColorName = (typeof colorNames)[number];

/**
 * The dot grid — signed file §1, last line.
 * `radial-gradient(dot 1px, transparent 1px)` at 22px, on `ground` only.
 */
export const dotGrid = { dotSize: 1, tile: 22 } as const;

/**
 * Type — signed file §2. Sizes are px; the Tailwind layer converts to rem so
 * the browser's own text-size setting still moves the page.
 */
/**
 * Weights are strings because `next/font/google` types its `weight` option as
 * a union of string literals; `as const` on this object is what lets the list
 * be passed straight through instead of being written out a second time in
 * `src/app/layout.tsx`. They are the weights the signed §2 table uses and no
 * more — every extra weight is another font file on the critical path.
 */
export const fonts = {
  sans: {
    name: "Poppins",
    weights: ["400", "500", "600", "700"],
    fallback: ["system-ui", "sans-serif"],
  },
  mono: {
    name: "IBM Plex Mono",
    weights: ["400", "500"],
    fallback: ["ui-monospace", "monospace"],
  },
} as const;

export const type = {
  /** page titles */
  display: {
    family: "sans",
    weight: 700,
    size: 24,
    lineHeight: 1.15,
    letterSpacing: "-0.015em",
  },
  /** card titles, empty-state titles */
  heading: {
    family: "sans",
    weight: 700,
    size: 20,
    lineHeight: 1.2,
    letterSpacing: null,
  },
  /** person name lines; button labels at the secondary size */
  name: {
    family: "sans",
    weight: 600,
    size: [16, 14],
    lineHeight: 1.3,
    letterSpacing: null,
  },
  /** drafts, descriptions */
  body: {
    family: "sans",
    weight: 400,
    size: 14,
    lineHeight: 1.6,
    letterSpacing: null,
  },
  /** draft body inside the approve card */
  bodyLarge: {
    family: "sans",
    weight: 400,
    size: 15,
    lineHeight: 1.55,
    letterSpacing: null,
  },
  /** row context; chips at the secondary size */
  small: {
    family: "sans",
    weight: [400, 500],
    size: [13, 12],
    lineHeight: 1.5,
    letterSpacing: null,
  },
  /** section labels inside cards */
  label: {
    family: "sans",
    weight: 600,
    size: [11, 12],
    lineHeight: null,
    letterSpacing: "0.1em",
    transform: "uppercase",
    color: "muted",
  },
  /** counts, dates, times, phone numbers, one-word states */
  mono: {
    family: "mono",
    weight: [400, 500],
    size: [11, 12, 13],
    lineHeight: null,
    letterSpacing: null,
    numeric: "tabular-nums",
  },
  /** the "where to go" counts on Home */
  monoBig: {
    family: "mono",
    weight: 500,
    size: 26,
    lineHeight: null,
    letterSpacing: null,
    numeric: "tabular-nums",
  },
} as const;

/**
 * The type scale — signed file §2, "Nothing off-scale."
 *
 * `type.monoBig` is 26 and therefore off this scale. That is a contradiction
 * inside the signed file, not a transcription slip; it is carried faithfully
 * and pinned by a test rather than resolved here.
 */
export const scale = [11, 12, 13, 14, 15, 16, 20, 24] as const;

/** Body text max width — signed file §2, last line. */
export const bodyMaxWidth = "65ch";

/** Shape and space — signed file §3. */
export const radius = {
  /** cards */
  card: 16,
  /** text boxes, evidence line, panels inside cards */
  input: 12,
  /** buttons, chips, nav, the brief box, count badge */
  pill: 999,
  /** outer app frame (mock only) */
  frame: 18,
} as const;

export const space = {
  /** 22 on approve and plan cards, 18 on rail cards */
  padCard: [22, 18],
  /** list rows: vertical, then horizontal */
  padRow: { y: [11, 14], x: 20 },
  /** queue and people rows */
  rowHeight: [48, 52],
  /** between cards */
  gapGrid: 16,
  /** between chips and buttons */
  gapChips: 8,
} as const;

/**
 * Shadow geometry — signed file §3. The colour is the `shadow` token, applied
 * by `tailwind.config.ts` as a CSS variable so it follows the theme.
 */
export const shadow = {
  /** cards only, never on rows or chips */
  card: "0 6px 24px",
  /** the floating nav pill */
  nav: "0 4px 18px",
} as const;

/** Borders — signed file §3. 1px hairline everywhere; inputs 1.5px. */
export const border = { hairline: 1, input: 1.5 } as const;

/** Layouts — signed file §3, last line. Single column under 820px. */
export const layouts = {
  home: "1.5fr 1fr",
  inbox: "340px 1fr",
  campaign: "1.4fr 1fr",
  singleColumnBelow: 820,
} as const;

export const tokens = {
  themes,
  colors,
  colorNames,
  dotGrid,
  fonts,
  type,
  scale,
  bodyMaxWidth,
  radius,
  space,
  shadow,
  border,
  layouts,
} as const;
