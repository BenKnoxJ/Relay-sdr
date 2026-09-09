import { REJECT_REASONS, inboxCopy, type RejectReason } from "@/lib/copy/inbox";

/**
 * Reject is one of four reasons (master doc §23.1b), drawn as the mock draws
 * them: a row of chips under a dashed rule (section 2a, "Reject opens:").
 *
 * The reasons are the signed vocabulary in `REJECT_REASONS`, iterated rather
 * than written out, so a fifth reason cannot appear here without appearing
 * there first. Each chip names the consequence in its `title` so a rep who
 * hovers sees what the reason does before choosing it; the same sentence is
 * read back on the status line once they have (`Inbox`), which is where a
 * keyboard or a touch reads it.
 *
 * Buttons styled as chips rather than `Chip`s made clickable: `Chip` is a
 * span and a span that acts on click is a control nobody can reach by
 * keyboard.
 */
export function RejectMenu({ onChoose }: { onChoose: (reason: RejectReason) => void }) {
  return (
    <div
      role="group"
      aria-label={inboxCopy.rejectWhy}
      className="mt-3.5 flex flex-wrap items-center gap-chips border-t border-dashed border-line pt-3"
    >
      <span className="text-12 text-muted">{inboxCopy.rejectWhy}</span>
      {REJECT_REASONS.map((reason) => (
        <button
          key={reason}
          type="button"
          data-testid="reject-reason"
          title={inboxCopy.rejectConsequence[reason]}
          onClick={() => onChoose(reason)}
          className="inline-flex items-center rounded-pill border border-line bg-ground px-2.5 py-0.5 text-12 font-medium text-muted transition-colors duration-micro ease-standard hover:text-ink focus-visible:outline-none focus-visible:ring-2"
        >
          {inboxCopy.rejectReason[reason]}
        </button>
      ))}
    </div>
  );
}
