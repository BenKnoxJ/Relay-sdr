/**
 * The Tailwind projection of the signed tokens: which class name carries which
 * token.
 *
 * The VALUES all come from `src/lib/tokens.ts` (the signed §21 file) — nothing
 * is written out here, only referenced. What this file decides is NAMES:
 * `space.padCard[0]` becomes `p-card`, `space.padRow.y[1]` becomes
 * `py-row-y-loose`.
 *
 * That projection has two consumers — `tailwind.config.ts`, which emits the
 * classes, and `src/lib/utils.ts`, which must declare the same scales to
 * tailwind-merge or `cn()` silently stops resolving conflicts between them.
 * Two hand-kept lists would drift, and the drift is invisible: the classes
 * still compile, they just stop overriding each other. Hence one map here,
 * with the keys derived from it rather than repeated.
 */

// Relative, not the `@/` alias: `tailwind.config.ts` imports this file, and
// Tailwind loads its config through jiti, which does not know the alias.
import { bodyMaxWidth, border, layouts, motion, radius, shadows, space, type } from "./tokens";

export const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

const px = (n: number) => `${n}px`;

/** Named spacings: padding, margin, gap, inset — one scale feeds them all. */
export const SPACING = {
  card: px(space.padCard[0]),
  "card-rail": px(space.padCard[1]),
  "row-y": px(space.padRow.y[0]),
  "row-y-loose": px(space.padRow.y[1]),
  "row-x": px(space.padRow.x),
  grid: px(space.gapGrid),
  chips: px(space.gapChips),
} as const;

/** The signed radii, plus the three shadcn derives from its own `--radius`. */
export const RADIUS = {
  ...(Object.fromEntries(Object.entries(radius).map(([k, v]) => [kebab(k), px(v)])) as Record<
    string,
    string
  >),
  lg: "var(--radius)",
  md: "calc(var(--radius) - 4px)",
  sm: "calc(var(--radius) - 8px)",
};

/**
 * `control` rather than the signed file's word "inputs": `input` is already
 * shadcn's border COLOUR, and one `border-input` cannot mean both a width and
 * a colour.
 */
export const BORDER_WIDTH = {
  hairline: px(border.hairline),
  control: px(border.input),
} as const;

/**
 * Geometry from the tokens; the colour follows the theme via the variable.
 *
 * These two are the WHOLE `boxShadow` scale — `tailwind.config.ts` sets it at
 * theme level, not in `extend`, so `shadow-md` and the rest of Tailwind's
 * stock ramp do not compile. Same argument as `colors` and `fontSize`: the
 * signed file names two shadows, and a third one a keystroke away is a rule
 * nothing enforces.
 */
export const BOX_SHADOW = {
  card: `${shadows.card} var(--relay-shadow)`,
  nav: `${shadows.nav} var(--relay-shadow)`,
} as const;

export const MIN_HEIGHT = {
  row: px(space.rowHeight[0]),
  "row-tall": px(space.rowHeight[1]),
} as const;

export const MAX_WIDTH = { measure: bodyMaxWidth } as const;

/** The one sanctioned use of the gradient. */
export const BACKGROUND_IMAGE = { wordmark: "var(--relay-gradient)" } as const;

export const GRID_TEMPLATE_COLUMNS = {
  home: layouts.home,
  inbox: layouts.inbox,
  campaign: layouts.campaign,
} as const;

/**
 * The one named duration and the one named curve (`motion` in the tokens).
 *
 * `extend`, not a replacement, unlike `colors`/`fontSize`/`boxShadow`: those
 * three are ramps the signed file closes, and motion is not in the signed file
 * at all. Closing Tailwind's own duration ramp here would be this file
 * inventing a rule the design has not made.
 */
export const TRANSITION_DURATION = { micro: `${motion.micro}ms` } as const;
export const TRANSITION_TIMING = { standard: motion.standard } as const;

/** `.type-display`, `.type-mono-big`, … — one per signed §2 role. */
export const TYPE_ROLE_KEYS = Object.keys(type).map(kebab);

/**
 * Not paint colours: exposing them as `bg-gradient` / `text-shadow` would
 * invite exactly the misuse the signed file forbids ("the gradient lives in
 * the wordmark and a page-title phrase only").
 */
export const NON_PAINT_COLORS = ["gradient", "dot", "shadow"] as const;

/**
 * shadcn/ui's colour names, so a later `shadcn add` renders in Relay's palette
 * instead of shipping unstyled. The values come from the same tokens — see
 * `SHADCN_MAP` in `scripts/tokens-css.ts`.
 *
 * One name collides. shadcn means a SURFACE by `muted`; the signed file means
 * the secondary TEXT colour, and `text-muted` is used throughout §2 and §4.
 * Both meanings are kept, separated by the property they apply to:
 * `text-muted` is the signed grey (from `colors`), while `bg-muted` is
 * shadcn's soft surface (from the `backgroundColor` override in
 * `tailwind.config.ts`). Relay never wants `bg-muted` — `muted` is a text
 * colour in the signed table — so nothing is lost, and shadcn's canonical
 * `bg-muted text-muted-foreground` pair renders correctly.
 */
export const SHADCN_COLOR_KEYS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
  "border",
  "input",
  "ring",
] as const;

export const SPACING_KEYS = Object.keys(SPACING);
export const RADIUS_KEYS = Object.keys(RADIUS);
export const BORDER_WIDTH_KEYS = Object.keys(BORDER_WIDTH);
export const BOX_SHADOW_KEYS = Object.keys(BOX_SHADOW);
export const MIN_HEIGHT_KEYS = Object.keys(MIN_HEIGHT);
export const MAX_WIDTH_KEYS = Object.keys(MAX_WIDTH);
export const BACKGROUND_IMAGE_KEYS = Object.keys(BACKGROUND_IMAGE);
export const TRANSITION_DURATION_KEYS = Object.keys(TRANSITION_DURATION);
export const TRANSITION_TIMING_KEYS = Object.keys(TRANSITION_TIMING);
