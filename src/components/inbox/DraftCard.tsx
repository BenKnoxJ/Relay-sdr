"use client";

import { useId, useState } from "react";

import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { PillButton } from "@/components/PillButton";
import { inboxCopy, type RejectReason } from "@/lib/copy/inbox";
import type { DraftItem } from "@/lib/fixtures/inbox";

import { EvidenceLine } from "./EvidenceLine";
import { RejectMenu } from "./RejectMenu";
import { WhoLine } from "./WhoLine";

/**
 * The draft card (master doc §23.1b; mock section 2a).
 *
 * Who, the evidence line, subject, body, three chips, and Approve / Edit /
 * Reject. It renders the signed outreach output and nothing else
 * (`agents/outreach/output.schema.ts`): a message draft is a subject and a
 * body; a call draft is a talking point in three lines. Both shapes are the
 * contract's own, so a live outreach agent's output lands here unchanged.
 *
 * Edit is inline (§23.1b): the body becomes a box, Done puts it back, and
 * Approve sends whatever the box holds. Reject opens the four reasons under a
 * dashed rule and the card stays until one is chosen.
 *
 * A draft that needs the rep is the same card with the reason above the body
 * (mock 2a's note): it is still a draft to approve or reject, it has just
 * been read by nobody yet.
 *
 * One primary button per card (§21): Approve. Edit is the outline and Reject
 * the text variant, and the reason chips are chips.
 */
export function DraftCard({
  item,
  onApprove,
  onReject,
}: {
  item: DraftItem;
  onApprove: (id: string, body?: string) => void;
  onReject: (id: string, reason: RejectReason) => void;
}) {
  const { draft } = item;
  const [editing, setEditing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [body, setBody] = useState(draft.kind === "message" ? draft.body : "");
  const edited = draft.kind === "message" && body !== draft.body;
  const bodyId = useId();

  return (
    <Card>
      <WhoLine
        person={item.person}
        aside={`${inboxCopy.email} ${item.ordinal} ${inboxCopy.of} ${item.total}`}
      />

      <EvidenceLine
        lead={inboxCopy.openedOn}
        text={item.opener.text}
        source={item.opener.source}
        date={item.opener.date}
      />

      {item.needsYou === null ? null : (
        <p data-testid="needs-you-reason" className="mb-3 text-13 text-warn">
          {inboxCopy.needsYouLead}
          {inboxCopy.join}
          {inboxCopy.needsYouReason[item.needsYou]}. {inboxCopy.needsYouCard}
        </p>
      )}

      {draft.kind === "message" ? (
        <>
          {draft.subject === undefined ? null : (
            <p className="mb-1.5 text-15 font-semibold text-ink">{draft.subject}</p>
          )}
          {editing ? (
            <>
              <label className="sr-only" htmlFor={bodyId}>
                {inboxCopy.bodyField}
              </label>
              <textarea
                id={bodyId}
                value={body}
                rows={6}
                onChange={(event) => setBody(event.currentTarget.value)}
                className="type-body-large mb-4 w-full resize-y rounded-input border-control border-line bg-ground px-3.5 py-2.5 text-ink outline-none focus-visible:ring-2"
              />
            </>
          ) : (
            <div data-testid="draft-body" className="type-body-large mb-4 max-w-measure">
              {body.split(/\n{2,}/).map((paragraph, index) => (
                <p key={index} className="mb-2 last:mb-0">
                  {paragraph}
                </p>
              ))}
            </div>
          )}
        </>
      ) : (
        <dl data-testid="draft-talking-point" className="type-body mb-4 grid max-w-measure gap-1.5">
          <Line label={inboxCopy.openWith} text={draft.talkingPoint.openingLine} />
          <Line label={inboxCopy.thenAsk} text={draft.talkingPoint.oneQuestion} />
          <Line label={inboxCopy.listenFor} text={draft.talkingPoint.listenFor} />
        </dl>
      )}

      <div className="mb-4 flex flex-wrap gap-chips">
        {item.emailFound ? (
          <Chip tone="ok">{inboxCopy.emailFound}</Chip>
        ) : (
          <Chip>{inboxCopy.noEmailYet}</Chip>
        )}
        <Chip>
          {inboxCopy.fitLabel} {inboxCopy.fit[item.fit]}
        </Chip>
        <Chip>
          {inboxCopy.sends} {item.sends.day} {item.sends.time}
        </Chip>
      </div>

      <div className="flex items-center gap-2.5">
        <PillButton onClick={() => onApprove(item.id, edited ? body : undefined)}>
          {inboxCopy.approve}
        </PillButton>
        {draft.kind === "message" ? (
          <PillButton variant="outline" onClick={() => setEditing((now) => !now)}>
            {editing ? inboxCopy.editDone : inboxCopy.edit}
          </PillButton>
        ) : null}
        <PillButton
          variant="text"
          aria-expanded={rejecting}
          onClick={() => setRejecting((now) => !now)}
          className="ml-auto"
        >
          {inboxCopy.reject}
        </PillButton>
      </div>

      {rejecting ? <RejectMenu onChoose={(reason) => onReject(item.id, reason)} /> : null}
    </Card>
  );
}

/** One line of a call draft's talking point: a quiet label and the words. */
function Line({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex gap-2.5">
      <dt className="type-label w-24 shrink-0 pt-0.5 text-11">{label}</dt>
      <dd className="m-0 text-ink">{text}</dd>
    </div>
  );
}
