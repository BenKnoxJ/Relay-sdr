import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

import { scale } from "@/lib/tokens";
import {
  BACKGROUND_IMAGE_KEYS,
  BORDER_WIDTH_KEYS,
  BOX_SHADOW_KEYS,
  MAX_WIDTH_KEYS,
  MIN_HEIGHT_KEYS,
  RADIUS_KEYS,
  SPACING_KEYS,
  TRANSITION_DURATION_KEYS,
  TRANSITION_TIMING_KEYS,
  TYPE_ROLE_KEYS,
} from "@/lib/theme-keys";

/**
 * tailwind-merge resolves conflicting Tailwind classes, but only for classes
 * it recognises. Every scale this config adds has to be declared here or the
 * conflict is missed and BOTH classes survive — at which point the winner is
 * whichever rule the stylesheet happens to emit last, not the caller's.
 *
 * The failure is quiet in both directions. Unknown `text-*` is read as a text
 * COLOUR, so `text-14 text-ink` collapses to `text-ink` and the size vanishes;
 * unknown `p-card` is not read at all, so `cn("p-card", "p-4")` keeps both and
 * the override loses. Hence the theme scales below rather than a hand-picked
 * few class groups.
 */
// The generic declares the one class group that is not a Tailwind default.
const twMerge = extendTailwindMerge<"relay-type">({
  extend: {
    theme: {
      // Feeds every padding, margin, gap, space and inset group at once.
      spacing: [...SPACING_KEYS],
      borderRadius: [...RADIUS_KEYS],
      borderWidth: [...BORDER_WIDTH_KEYS],
    },
    classGroups: {
      "font-size": [{ text: scale.map(String) }],
      "bg-image": [{ bg: [...BACKGROUND_IMAGE_KEYS] }],
      shadow: [{ shadow: [...BOX_SHADOW_KEYS] }],
      "min-h": [{ "min-h": [...MIN_HEIGHT_KEYS] }],
      "max-w": [{ "max-w": [...MAX_WIDTH_KEYS] }],
      // The type roles are components, and two of them on one element is a
      // conflict like any other.
      "relay-type": [{ type: TYPE_ROLE_KEYS }],
      // tailwind-merge reads a duration as a number and an ease as one of its
      // four stock names, so `duration-micro` and `ease-standard` are invisible
      // to it and survive a conflict with the class meant to override them.
      duration: [{ duration: [...TRANSITION_DURATION_KEYS] }],
      ease: [{ ease: [...TRANSITION_TIMING_KEYS] }],
    },
  },
});

/**
 * The class-name helper every shadcn/ui component imports. `clsx` handles the
 * conditionals; `tailwind-merge` resolves the conflicts, so a caller's
 * `bg-panel` beats a component's default `bg-ground` instead of both landing
 * in the class list and the stylesheet order deciding.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
