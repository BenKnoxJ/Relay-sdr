import { Chip } from "./Chip";
import { EvidenceLine } from "./EvidenceLine";
import { PillButton } from "./PillButton";

import { draftCopy } from "@/lib/copy/draft";
import { cn } from "@/lib/utils";

import type { Item } from "../../agents/research/output.schema";
import type { MessageDraft } from "../../agents/outreach/output.schema";

/**
 * The draft, on the right of the Inbox (signed mock §2a).
 *
 * Read-only. The three buttons are drawn because they are part of the screen
 * being judged — a draft card without them is not the card a rep approves from
 * — and they are `disabled` here rather than absent. Slice 1 gives them their
 * actions; the bench must never be a way to send email.
 *
 * `draft` is `MessageDraft`, inferred from the outreach agent's own output
 * schema, and `opener` is the `Item` the draft's `opener.ref` points at. The
 * component does not resolve that reference itself: the item lives in the
 * agent's INPUT (the lookup, or the pain in the pack), and a component that
 * went looking for it would need the whole input to render one line.
 */
export function DraftCard({
  draft,
  who,
  note,
  opener,
  openerProblem,
  chips = [],
  className,
}: {
  draft: MessageDraft;
  /** "Daniel Okoro · Operations Director, Kestrel Couriers". */
  who: string;
  /** "Email 1 of 3". */
  note?: string;
  /** What the opener was built on, or null when there was no usable fact. */
  opener: Item | null;
  /**
   * Set when the opener names something that is not in the lookup or the pack.
   *
   * Distinct from `opener: null`, which is the ordinary "no usable fact about
   * this person, so open on the pain" case. A dangling reference is a defect in
   * the draft, and drawing the two the same way would let it pass as a clean
   * card.
   */
  openerProblem?: string;
  /** The state chips under the body: found, fit, when it sends. */
  chips?: string[];
  className?: string;
}) {
  return (
    <div className={cn("rounded-card border border-line bg-panel p-card shadow-card", className)}>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <b className="type-name">{who}</b>
        {note === undefined ? null : <span className="type-mono text-12 text-muted">{note}</span>}
      </div>

      {openerProblem !== undefined ? (
        <p className="type-small mb-3 text-warn">{openerProblem}</p>
      ) : opener === null ? (
        <p className="type-small mb-3 text-muted">{draftCopy.noPersonFact}</p>
      ) : (
        <EvidenceLine item={opener} label={draftCopy.openedOn} className="mb-3" />
      )}

      {draft.subject === undefined ? null : (
        <p className="type-name mb-2 text-16">{draft.subject}</p>
      )}

      {/* Split on blank lines, so the model's paragraphs are the reader's
          paragraphs. Rendered as text and never as markup: a draft is a
          stranger's prose arriving from a provider. */}
      <div className="type-body-large mb-3.5">
        {draft.body
          .split(/\n\s*\n/)
          .map((paragraph) => paragraph.trim())
          .filter((paragraph) => paragraph !== "")
          .map((paragraph, index) => (
            <p key={index} className="mb-2.5 last:mb-0">
              {paragraph}
            </p>
          ))}
      </div>

      {chips.length === 0 ? null : (
        <div className="mb-3.5 flex flex-wrap gap-chips">
          {chips.map((chip) => (
            <Chip key={chip}>{chip}</Chip>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-chips">
        <PillButton disabled>{draftCopy.approve}</PillButton>
        <PillButton variant="outline" disabled>
          {draftCopy.edit}
        </PillButton>
        <PillButton variant="text" disabled>
          {draftCopy.reject}
        </PillButton>
      </div>
    </div>
  );
}
