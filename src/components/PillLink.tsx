import Link from "next/link";

import { cn } from "@/lib/utils";

import type { ButtonVariant } from "./PillButton";

/**
 * A link drawn as the pill (final MVP pass): the same three variants and
 * the same classes as `PillButton`, for the one case a page's header action
 * is a place to go rather than a thing to do (Edit brief). One shape for
 * every control, whichever element it has to be.
 */
const VARIANTS: Record<ButtonVariant, string> = {
  primary: "border-transparent bg-action text-on-action",
  outline: "border-action bg-transparent text-action",
  text: "border-0 bg-transparent px-0 text-muted",
};

export function PillLink({ variant = "primary", className, ...props }: { variant?: ButtonVariant } & React.ComponentProps<typeof Link>) {
  return (
    <Link
      className={cn(
        "inline-flex items-center justify-center rounded-pill border-control px-4 py-2 text-13 font-semibold",
        "focus-visible:outline-none focus-visible:ring-2",
        "transition-opacity duration-micro ease-standard hover:opacity-90 active:opacity-80",
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}
