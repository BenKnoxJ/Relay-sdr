import { cn } from "@/lib/utils";

/**
 * One card of the plan (signed tokens §4, signed mock §3b-ii).
 *
 * "The plan cards are the research surface. Each opens to everything the pack
 * holds for it… Cards are views over the pack's items, not a second summary, so
 * the plan never drifts from the research."
 *
 * Two states, as the signed inventory has it: collapsed is two lines and a
 * `▸ n items` note; open is the item list. The bench renders both, and the
 * read-only version has no toggle — `open` is a prop, because slice 1 owns the
 * interaction and this component should not grow one it will have to give back.
 *
 * Deliberately NOT schema-typed. A plan card is a shell around five different
 * shapes — pains, an archetype summary, the hook, seed firms, the unknowns —
 * and a prop type that was the union of all five would be a type nothing in the
 * pack actually has. The schema-typed components are the ones that render a
 * pack's own values: `ItemLine`, `EvidenceLine`, `Row`, `DraftCard`. This is a
 * layout primitive, like `Card`.
 *
 * `dashed` is the unknowns card, which the mock draws with a dashed border
 * because it is the one card that contains no findings.
 */
export function PlanCard({
  title,
  summary,
  note,
  dashed = false,
  open = false,
  className,
  children,
}: {
  title: string;
  /** The two-line collapsed body. */
  summary?: string;
  /** The right-hand or footer note: `▸ 6 firms · recipe`, `▾ 7 of 7 shown`. */
  note?: string;
  dashed?: boolean;
  open?: boolean;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <section
      data-open={open ? "" : undefined}
      className={cn(
        "rounded-input border border-line bg-panel p-4",
        dashed ? "border-dashed" : null,
        className,
      )}
    >
      {/* Where the note sits is the mock's, not a preference: the open card
          carries it on the title line ("▾ 7 of 7 shown"), and a collapsed one
          carries it under the summary as the last of its two lines
          ("▸ 6 firms · recipe"). */}
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="type-name text-14">{title}</h3>
        {open && note !== undefined ? <span className="text-12 text-muted">{note}</span> : null}
      </div>
      {summary === undefined ? null : <p className="type-small mt-1 text-muted">{summary}</p>}
      {!open && note !== undefined ? <p className="mt-1.5 text-12 text-muted">{note}</p> : null}
      {open ? <div className="mt-2">{children}</div> : null}
    </section>
  );
}
