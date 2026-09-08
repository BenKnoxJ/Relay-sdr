/**
 * Generates `src/app/tokens.css` from `src/lib/tokens.ts`.
 *
 * The stylesheet is a build artefact that happens to be checked in: it is read
 * by PostCSS, which cannot import TypeScript, so the token values have to
 * arrive as literal CSS. Generating it is what stops the CSS and the signed
 * token file drifting apart.
 *
 * Only the custom properties are generated. `src/app/globals.css` imports this
 * file and is hand-editable on purpose: it is what `components.json` points
 * the shadcn CLI at, and `shadcn add` writes into that file. If the generated
 * half were the same file, an `add` would either break the build or be wiped
 * by the next regeneration.
 *
 * Two guards, deliberately not one:
 *   - `npm run tokens:css` writes the file (what a developer runs after
 *     editing a token).
 *   - `npm run tokens:check` re-renders and compares, and is wired to
 *     `prebuild`, so a build fails on drift.
 *   - `tests/ui/tokens.test.ts` makes the same comparison, so `npm run check`
 *     and CI catch it too.
 *
 * `prebuild` deliberately CHECKS rather than WRITES. A prebuild that rewrote
 * the file would repair drift silently, and every later gate — including the
 * test — would then be comparing the CSS against itself.
 */

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { kebab } from "../src/lib/theme-keys";
import { colors, radius, themes, type Theme } from "../src/lib/tokens";

export const TOKENS_CSS_PATH = "src/app/tokens.css";

/** Repository root, from this file's own location. */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The CSS custom property carrying a Relay colour token.
 *
 * `kebab` comes from `theme-keys.ts` rather than being re-written here: that
 * file's Tailwind class names and these variable names have to agree exactly
 * (`bg-warn-bg` reads `--relay-warn-bg`), and two copies of the rule would
 * agree only until one of them was edited.
 */
export function cssVar(name: string): string {
  return `--relay-${kebab(name)}`;
}

/**
 * shadcn/ui addresses its colours as `hsl(var(--background))`, so its
 * variables have to be bare `H S% L%` triplets rather than the raw values the
 * Relay tokens carry. Converting here — from the same source — is what makes a
 * later `shadcn add` inherit the signed look instead of shipping its own
 * palette.
 */
export function hexToHslTriplet(hex: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (match === null) {
    throw new Error(
      `Only six-digit hex converts to an HSL triplet; received ${hex}. ` +
        `A non-hex token (rgba, gradient) must not be mapped onto a shadcn variable.`,
    );
  }
  const n = parseInt(match[1] as string, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255) as [
    number,
    number,
    number,
  ];

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;

  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }

  const round = (v: number) => Math.round(v * 10) / 10;
  return `${round(h)} ${round(s * 100)}% ${round(l * 100)}%`;
}

/**
 * shadcn's variable names, each pointing at the Relay token it takes its value
 * from. Mapped once, here, so the mapping is reviewable in one place.
 *
 * `destructive` has no counterpart: the signed file has no destructive colour,
 * only the semantic `warn`. It is mapped to `warn` so a shadcn component that
 * references it renders in Relay's palette rather than shadcn's default red —
 * flagged for design sign-off, not a decision taken here.
 */
export const SHADCN_MAP = {
  background: "ground",
  foreground: "ink",
  card: "panel",
  "card-foreground": "ink",
  popover: "panel",
  "popover-foreground": "ink",
  primary: "action",
  "primary-foreground": "onAction",
  secondary: "soft",
  "secondary-foreground": "ink",
  muted: "soft",
  "muted-foreground": "muted",
  accent: "soft",
  "accent-foreground": "action",
  destructive: "warn",
  "destructive-foreground": "onAction",
  border: "line",
  input: "line",
  ring: "action",
} as const;

function themeBlock(theme: Theme, indent: string): string {
  const palette = colors[theme];
  const lines: string[] = [];

  lines.push(`${indent}color-scheme: ${theme};`);
  for (const [name, value] of Object.entries(palette)) {
    lines.push(`${indent}${cssVar(name)}: ${value};`);
  }

  lines.push("");
  lines.push(`${indent}/* shadcn/ui, taking its values from the tokens above. */`);
  for (const [shadcnName, tokenName] of Object.entries(SHADCN_MAP)) {
    const value = palette[tokenName as keyof typeof palette];
    lines.push(`${indent}--${shadcnName}: ${hexToHslTriplet(value)};`);
  }
  lines.push(`${indent}--radius: ${radius.card}px;`);

  return lines.join("\n");
}

export function renderTokensCss(): string {
  const [light, dark] = themes;

  return `/* GENERATED FILE — do not edit by hand.
 *
 * Source:      src/lib/tokens.ts
 * Design:      products/relay/design/relay-tokens.md (v1.1, signed 2026-09-08)
 * Regenerate:  npm run tokens:css
 * Verify:      npm run tokens:check   (also enforced by tests/ui/tokens.test.ts)
 *
 * Edit the tokens, not this file. Any hand edit is reverted by the next
 * regeneration and fails the build before that. Hand-written CSS — including
 * anything the shadcn CLI adds — belongs in src/app/globals.css, which imports
 * this file.
 */

/* ${light} is the pilot default (signed file §5, rule 5). */
:root {
${themeBlock(light, "  ")}
}

/* The root is ALWAYS stamped with a theme — see src/app/layout.tsx. There is
 * deliberately no \`prefers-color-scheme\` fallback here: Tailwind's \`dark:\`
 * variant is bound to this same attribute, so a palette that could switch
 * without the attribute switching would put the custom properties in one theme
 * and every \`dark:\` utility in the other. One switch, not two. */
:root[data-theme="${dark}"] {
${themeBlock(dark, "  ")}
}
`;
}

function main(): void {
  const target = path.join(repoRoot, TOKENS_CSS_PATH);
  const rendered = renderTokensCss();

  if (process.argv.includes("--check")) {
    const onDisk = readFileSync(target, "utf8");
    if (onDisk === rendered) {
      console.log(`${TOKENS_CSS_PATH} matches src/lib/tokens.ts.`);
      return;
    }
    console.error(
      `${TOKENS_CSS_PATH} has drifted from src/lib/tokens.ts. Run \`npm run tokens:css\` and commit the result.`,
    );
    process.exit(1);
  }

  writeFileSync(target, rendered);
  console.log(`Wrote ${TOKENS_CSS_PATH} from src/lib/tokens.ts.`);
}

/**
 * Only when run as a script: the test imports `renderTokensCss` from here.
 *
 * Both sides are resolved through `realpath`, not just `path.resolve`.
 * `import.meta.url` is already symlink-resolved, so comparing it against a raw
 * `argv[1]` makes the two differ whenever the script is reached through a
 * symlink — and the failure is silent in the worst direction: `main()` never
 * runs, nothing is printed, and `--check` exits 0, so the `prebuild` drift
 * gate reports success without having compared anything.
 *
 * Which is why a `realpath` that THROWS may not be swallowed into "not the
 * entry point" either: that is the same silent pass by a different route — an
 * I/O error on the resolve would leave `--check` exiting 0 having compared
 * nothing. Once there is a script path to resolve, the only way to skip
 * `main()` is two resolves that both succeeded and disagreed; a resolve that
 * failed exits 2, because "could not tell" is not "no".
 */
const realpathOrExit = (target: string): string => {
  try {
    return realpathSync(target);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(
      `Could not resolve ${target} to decide whether this is the entry point, ` +
        `so nothing was done to ${TOKENS_CSS_PATH} — it was neither checked ` +
        `nor written: ${reason}`,
    );
    process.exit(2);
  }
};

/**
 * The one branch that skips `main()` without resolving anything: `argv[1]` is
 * undefined only when the process has no script path at all (`node -e`, the
 * REPL), which is a definite "imported, not run" rather than a failure to find
 * out. Nothing is swallowed here — there is nothing to swallow.
 */
if (process.argv[1] !== undefined) {
  if (realpathOrExit(process.argv[1]) === realpathOrExit(fileURLToPath(import.meta.url))) {
    main();
  }
}
