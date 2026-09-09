import { cn } from "@/lib/utils";

/**
 * The line at the top of every page: the title, and one quiet note on the
 * right (signed mock, `.hd`).
 *
 * The note is always mono, because everything on the right of that line in the
 * signed screens is a count, a date or a state — "Mon 7 Sep", "1 call · 3
 * drafts", "nothing waiting" — and the signed §2 table puts all four in IBM
 * Plex Mono with tabular figures.
 *
 * The title is the page's `h1` and there is exactly one per page.
 */
export function PageHeader({
  title,
  note,
  className,
}: {
  title: string;
  note?: string;
  className?: string;
}) {
  return (
    <header className={cn("mb-grid flex items-baseline justify-between gap-3", className)}>
      <h1 className="type-display">{title}</h1>
      {note === undefined ? null : <p className="type-mono text-13 text-muted">{note}</p>}
    </header>
  );
}
