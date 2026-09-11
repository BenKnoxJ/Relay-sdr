import { PillButton } from "@/components/PillButton";
import { REPLY_LABELS, inboxCopy, type ReplyLabel } from "@/lib/copy/inbox";

/**
 * The four labels a reply can take (master doc §23.1b): warm, later, no,
 * stop. Iterated from the signed vocabulary rather than written out, so the
 * row and the data model's enum cannot disagree.
 *
 * Warm is the primary and the other three are outlines: one accent on one
 * control per card (§21), and warm is the label the card exists to catch.
 */
export function LabelRow({ onChoose }: { onChoose: (label: ReplyLabel) => void }) {
  return (
    <div role="group" aria-label={inboxCopy.labelThis} className="flex flex-wrap gap-chips">
      {REPLY_LABELS.map((label, index) => (
        <PillButton
          key={label}
          data-testid="reply-label"
          variant={index === 0 ? "primary" : "outline"}
          onClick={() => onChoose(label)}
        >
          {inboxCopy.replyLabel[label]}
        </PillButton>
      ))}
    </div>
  );
}
