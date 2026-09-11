import { Card } from "@/components/Card";
import { inboxCopy, type CallOutcome } from "@/lib/copy/inbox";
import type { CallItem } from "@/lib/fixtures/inbox";

import { EvidenceLine } from "./EvidenceLine";
import { OutcomeRow } from "./OutcomeRow";
import { WhoLine } from "./WhoLine";

/**
 * The call card (master doc §23.1b; mock section 2c).
 *
 * Who, the number large and in mono, the two-line "why call" with its source,
 * and one job: log the outcome. The rep dials from their own phone in the
 * pilot, so the number is text to read and not a link to press.
 *
 * "Why call" is two lines because it is two things: what the thread did
 * (opened twice, no reply) and what the call touch's talking point says to
 * open with and ask, which is the signed outreach output for a call
 * (`callDraftSchema`). The source is the opener's, resolved through the
 * fixture pack the same way the draft card's evidence line is.
 *
 * `text-20` for the number: the mock draws it at 22, which is not on the
 * signed nine-size scale, and 20 is the nearest size the scale has.
 */
export function CallCard({
  item,
  onLog,
}: {
  item: CallItem;
  onLog: (id: string, outcome: CallOutcome, notes?: string) => void;
}) {
  const { talkingPoint } = item.draft;

  return (
    <Card>
      <WhoLine person={item.person} aside={inboxCopy.dayCallSmall} />

      <p data-testid="call-number" className="type-mono mb-3 text-20 text-ink">
        {item.phone}
      </p>

      <EvidenceLine
        lead={inboxCopy.whyCall}
        text={`${item.context} ${talkingPoint.openingLine} ${talkingPoint.oneQuestion}`}
        source={item.opener.source}
        date={item.opener.date}
      />

      <h3 className="type-label mb-2 text-12">{inboxCopy.logOutcome}</h3>
      <OutcomeRow onChoose={(outcome, notes) => onLog(item.id, outcome, notes)} />
    </Card>
  );
}
