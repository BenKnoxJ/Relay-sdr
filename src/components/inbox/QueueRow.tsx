import { Chip } from "@/components/Chip";
import { inboxCopy } from "@/lib/copy/inbox";
import type { QueueItem } from "@/lib/fixtures/inbox";
import { initialsFor } from "@/lib/shell";
import { cn } from "@/lib/utils";

/**
 * One row of the queue (signed tokens §4, slice 1 inventory: "Row — avatar,
 * name, context, one-word mono state"; mock section 2, `.row`).
 *
 * The row is a button, because the whole of it is the click target and the
 * only thing clicking it does is select. `aria-current` marks the selected one
 * rather than a class alone, so a screen reader hears which card is open and
 * a test can ask the same question the rep's eyes answer.
 *
 * The one word on the right is what the row wants from the rep: `label` on a
 * reply, `today` on a call, the send day on a draft. A draft that needs the
 * rep carries the warn chip there instead, and its reason in the context line
 * (§23.1b, "Needs you").
 */

/** The one grey line under the name. */
export function contextOf(item: QueueItem): string {
  switch (item.kind) {
    case "reply":
      return `"${item.message[0] ?? ""}"`;
    case "call":
      return `${inboxCopy.dayCall}${inboxCopy.join}${item.person.company}`;
    case "draft":
      return item.needsYou === null
        ? `${inboxCopy.email} ${item.ordinal} ${inboxCopy.of} ${item.total}${inboxCopy.join}${item.person.company}`
        : `${inboxCopy.needsYouLead}${inboxCopy.join}${inboxCopy.needsYouReason[item.needsYou]}`;
  }
}

/** The one word of state on the right, or null when the row carries the warn chip instead. */
export function stateOf(item: QueueItem): string | null {
  switch (item.kind) {
    case "reply":
      return inboxCopy.stateLabel;
    case "call":
      return inboxCopy.stateToday;
    case "draft":
      return item.needsYou === null ? item.sends.day : null;
  }
}

export function QueueRow({
  item,
  selected,
  onSelect,
}: {
  item: QueueItem;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const needsYou = item.kind === "draft" && item.needsYou !== null;
  const state = stateOf(item);

  return (
    <li>
      <button
        type="button"
        data-testid="queue-row"
        data-queue-row={item.id}
        data-kind={item.kind}
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(item.id)}
        className={cn(
          "flex min-h-row w-full items-center gap-3 border-t border-line px-row-x py-row-y text-left",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset",
          "transition-colors duration-micro ease-standard",
          selected ? "bg-soft" : "hover:bg-ground",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "grid h-8 w-8 shrink-0 place-items-center rounded-pill border border-line bg-ground text-11 font-semibold",
            needsYou ? "text-warn" : "text-muted",
          )}
        >
          {initialsFor(item.person.name, item.person.email ?? "")}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-13 font-semibold text-ink">{item.person.name}</span>
          <span className="block truncate text-12 text-muted">{contextOf(item)}</span>
        </span>
        {state === null ? (
          <Chip tone="warn">{inboxCopy.needsYou}</Chip>
        ) : (
          <span className="type-mono shrink-0 text-11 text-muted">{state}</span>
        )}
      </button>
    </li>
  );
}
