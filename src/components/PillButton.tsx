import { cn } from "@/lib/utils";

/**
 * The only button shape in Relay: a pill (signed direction D1, §21 "Shape").
 *
 * Three variants and one rule about them — `primary` is the filled violet, and
 * there is at most one per card (§21, "one accent … on one control per card").
 * `outline` is the violet-outlined secondary; `text` is the tertiary, which
 * carries no border and no horizontal padding so it sits flush in a row.
 *
 * The focus ring is not decoration and is not optional: the whole palette
 * routes through CSS variables, and Tailwind's own `--tw-ring-color` is
 * overridden to `--relay-action` in `tailwind.config.ts`, so `ring-2` is the
 * signed violet in both themes. `focus-visible` rather than `focus`, so a
 * mouse click does not leave a ring behind.
 *
 * No ring OFFSET, deliberately. An offset paints a band of
 * `ringOffsetColor.DEFAULT` — `--relay-ground` — between the element and the
 * ring, and these sit on `panel` as often as on `ground`, so the band would be
 * the wrong colour half the time and most visibly in dark.
 */
export type ButtonVariant = "primary" | "outline" | "text";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "border-transparent bg-action text-on-action",
  outline: "border-action bg-transparent text-action",
  text: "border-0 bg-transparent px-0 text-muted",
};

export function PillButton({
  variant = "primary",
  className,
  type = "button",
  ...props
}: { variant?: ButtonVariant } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex items-center justify-center rounded-pill border-control px-4 py-2 text-13 font-semibold",
        "focus-visible:outline-none focus-visible:ring-2",
        "disabled:opacity-50",
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}
