/**
 * The evidence line (signed tokens §4, slice 1 inventory: "EvidenceLine —
 * `soft` `radius.input`, tick in `action`, source in `muted`").
 *
 * One sentence on what the draft opened on, with where it came from and when
 * beside it. The tick is the one place outside a button that carries the
 * accent (§21: "on evidence ticks"). It is stroked in `currentColor` on a
 * `text-action` wrapper rather than in a hex, so it follows the theme and
 * the token discipline check in `tests/ui/shell.test.tsx` has nothing to
 * find.
 */
export function EvidenceLine({
  lead,
  text,
  source,
  date,
}: {
  /** "Opened on:" or "Why call:". */
  lead: string;
  text: string;
  source: string;
  date: string;
}) {
  return (
    <div className="mb-3.5 flex gap-2.5 rounded-input bg-soft px-3 py-2.5 text-13">
      <span aria-hidden className="mt-1 shrink-0 text-action">
        <svg width="14" height="14" viewBox="0 0 14 14">
          <path
            d="M2 7.5l3 3 7-7"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </span>
      <p className="text-ink">
        {lead} {text}{" "}
        <span className="text-muted">
          {source}, {date}
        </span>
      </p>
    </div>
  );
}
