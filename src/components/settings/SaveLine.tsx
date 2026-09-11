import { cn } from "@/lib/utils";

/**
 * The quiet line beside a Settings card's heading: "Saved", "Removed", or the
 * one plain sentence saying why nothing was saved (master doc §23.1f, "saves
 * on blur with a quiet 'Saved'"; the mock's `h4 .saved`).
 *
 * Always mounted, as `DailyCapField` explains: a `role="status"` that appears
 * at the same moment as its text is often not announced at all. `lead` is the
 * count the Your voice card keeps in front of it ("7 emails"), which is not
 * live and so sits outside the region.
 */
export function SaveLine({ lead, line }: { lead?: string; line: string | null }) {
  return (
    <span className="type-mono max-w-measure text-right text-11 font-medium text-muted">
      {lead === undefined ? null : <span>{lead}</span>}
      <span role="status" className={cn(line === null && lead !== undefined ? "sr-only" : undefined)}>
        {line === null ? null : lead === undefined ? line : ` · ${line}`}
      </span>
    </span>
  );
}

/** The one field look on the page: the mock's `.box`, in the tokens. */
export const FIELD =
  "type-body w-full rounded-input border-control border-line bg-ground px-3 py-2 text-ink outline-none focus-visible:ring-2";
