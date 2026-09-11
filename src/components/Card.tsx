import { cn } from "@/lib/utils";

/**
 * A panel. The one thing in Relay that carries a shadow (signed tokens §3).
 *
 * Signed spec, from `design/relay-tokens.md`: 16px radius (`rounded-card`),
 * 1px hairline, `panel` surface, 22px padding (`p-card`), `0 6px 24px` in the
 * theme's shadow colour (`shadow-card`). Nothing here is written as a value —
 * every class resolves through `tailwind.config.ts` to `src/lib/tokens.ts`.
 *
 * `label` is the small uppercase section label the signed mock puts at the top
 * of a card ("Where to go", "This campaign"). It renders as a real heading
 * rather than a styled div: it is the only heading a card has, and a page of
 * cards with no headings is a page a screen reader reads as one block.
 *
 * `aside` is the small mono line the signed Settings mock puts at the right of
 * a card's heading ("7 emails · Saved", section 5). It sits beside the heading
 * and outside it, so the heading's name stays the label alone.
 */
export function Card({
  label,
  aside,
  className,
  children,
}: {
  label?: string;
  aside?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <section className={cn("rounded-card border border-line bg-panel p-card shadow-card", className)}>
      {label === undefined ? null : aside === undefined ? (
        <h2 className="type-label mb-2.5">{label}</h2>
      ) : (
        <div className="mb-2.5 flex items-center justify-between gap-3">
          <h2 className="type-label">{label}</h2>
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}
