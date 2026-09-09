import { cn } from "@/lib/utils";

import type { Item } from "../../agents/research/output.schema";

import { sourceLine } from "./ItemLine";

/**
 * The one fact an opener was built on, with a tick and its source (signed
 * tokens §4, signed mock §2a `.ev`).
 *
 * Same schema-typed prop as `ItemLine`, and for the same reason: the thing an
 * outreach draft opens on is an `Item` from the research contract — the
 * outreach definition says so in as many words — so the component takes that
 * type and no other.
 *
 * `label` is a caller's word ("Opened on:") rather than a fixed string, because
 * the same line carries a different lead-in on the reply and call cards in
 * slice 1 and the shape is what is shared.
 */
export function EvidenceLine({
  item,
  label,
  className,
}: {
  item: Item;
  label: string;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start gap-2 rounded-input bg-soft px-3 py-2.5", className)}>
      {/* Stroked in currentColor so the tick follows the theme, like every
          other drawing in this component set. */}
      <svg
        width="14"
        height="14"
        viewBox="0 0 14 14"
        aria-hidden="true"
        className="mt-1 shrink-0 text-action"
      >
        <path
          d="M2 7.5l3 3 7-7"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
      <span className="type-small">
        {label} {item.text}
        <em className="ml-1 not-italic text-muted">{sourceLine(item)}</em>
      </span>
    </div>
  );
}
