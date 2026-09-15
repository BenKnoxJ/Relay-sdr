import { cn } from "@/lib/utils";

/**
 * A small pressable word that is either chosen or not (final MVP pass):
 * Keep and Drop on a person, a play in the comparison, a filter. Quiet until
 * chosen, because a page of choices must not be a wall of filled buttons;
 * chosen, it is the one accent. `aria-pressed` carries the state.
 */
export function ToggleChip({
  pressed,
  className,
  type = "button",
  ...props
}: { pressed: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      aria-pressed={pressed}
      className={cn(
        "type-small inline-flex min-h-7 items-center rounded-pill border px-2.5 font-semibold transition-colors duration-micro ease-standard focus-visible:outline-none focus-visible:ring-2 disabled:opacity-60",
        pressed ? "border-transparent bg-action text-on-action" : "border-line bg-transparent text-muted hover:text-ink",
        className,
      )}
      {...props}
    />
  );
}
