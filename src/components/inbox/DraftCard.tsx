"use client";

import { useId, useState } from "react";

import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { PillButton } from "@/components/PillButton";
import { useUnsaved } from "@/components/people/unsaved";
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
  deciding = null,
}: {
  item: DraftItem;
  onApprove: (id: string, body?: string) => void;
  onReject: (id: string, reason: RejectReason) => void;
  /** The decision on its way to the server for this draft: the card holds still and the pressed button says so. */
  deciding?: "approve" | "reject" | null;
}) {
  const { draft } = item;
  const [editing, setEditing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [body, setBody] = useState(draft.kind === "message" ? draft.body : "");
  const edited = draft.kind === "message" && body !== draft.body;
  // In the person drawer, an edit not yet approved is unsaved words (P5c); in the Inbox nothing listens.
  useUnsaved(`draft:${item.id}`, edited);
  const bodyId = useId();
  const busy = deciding !== null;

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

      {/* Rubric row 3: a real draft on the role problem says there was no usable fact about the person or firm. */}
      {item.envelope !== undefined && item.opener.kind === "role_pain" ? (
        <p data-testid="no-person-fact" className="type-small -mt-2 mb-2 text-muted">
          {inboxCopy.noPersonFact}
        </p>
      ) : null}

      {item.campaignName === undefined ? null : (
        <p data-testid="draft-campaign" className="type-small mb-2 text-muted">
          {inboxCopy.fromCampaign} {item.campaignName}
        </p>
      )}

      {item.needsYou === null ? null : (
        <p data-testid="needs-you-reason" className="mb-3 text-13 text-warn">
          {inboxCopy.needsYouLead}
          {inboxCopy.join}
          {inboxCopy.needsYouReason[item.needsYou]}. {item.written === false ? inboxCopy.notWrittenCard : inboxCopy.needsYouCard}
        </p>
      )}

      {/* The reason above is the one warning; what the checks found is its detail, so it reads neutral. */}
      {item.findings === undefined || item.findings.length === 0 ? null : (
        <div data-testid="draft-findings" className="mb-3 rounded-input border border-line px-3 py-2">
          <p className="type-label text-muted">{inboxCopy.findingsLead}</p>
          <ul className="type-small list-disc pl-4 text-muted">
            {item.findings.map((finding) => (
              <li key={finding}>{finding}</li>
            ))}
          </ul>
        </div>
      )}

      {item.written === false ? null : draft.kind === "message" ? (
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
              {/* Relay's envelope around the written body (outreach v2.1 §4): the rep sees the email as it would read. */}
              {item.envelope === undefined ? null : <p data-testid="draft-greeting" className="mb-2">{item.envelope.greeting}</p>}
              {body.split(/\n{2,}/).map((paragraph, index) => (
                <p key={index} className="mb-2 last:mb-0">
                  {paragraph}
                </p>
              ))}
              {item.envelope === undefined || item.envelope.signOff === "" ? null : <p data-testid="draft-signoff" className="mt-2">{item.envelope.signOff}</p>}
              {/* The signature and the opt-out go out with every email (M2): the rep sends by hand, so they read what they will send. */}
              {item.envelope === undefined || item.envelope.signature === "" ? null : (
                <p data-testid="draft-signature" className="mt-2 whitespace-pre-line text-muted">
                  {item.envelope.signature}
                </p>
              )}
              {item.envelope === undefined ? null : (
                <p data-testid="draft-optout" className="mt-2 text-muted">
                  {item.envelope.optOut}
                </p>
              )}
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
        <Chip>{item.sends === null ? inboxCopy.nothingSentYet : `${inboxCopy.sends} ${item.sends.day} ${item.sends.time}`}</Chip>
      </div>

      {item.advice === undefined || item.advice.length === 0 ? null : (
        <p data-testid="draft-advice" className="type-small mb-3 text-muted">
          {inboxCopy.adviceLead} {item.advice.join(" ")}
        </p>
      )}

      <div className="flex items-center gap-2.5">
        {item.written === false ? null : (
          <PillButton disabled={busy} onClick={() => onApprove(item.id, edited ? body : undefined)}>
            {deciding === "approve" ? inboxCopy.approving : inboxCopy.approve}
          </PillButton>
        )}
        {draft.kind === "message" && item.written !== false ? (
          <PillButton variant="outline" disabled={busy} onClick={() => setEditing((now) => !now)}>
            {editing ? inboxCopy.editDone : inboxCopy.edit}
          </PillButton>
        ) : null}
        <PillButton
          variant="text"
          aria-expanded={rejecting}
          disabled={busy}
          onClick={() => setRejecting((now) => !now)}
          className="ml-auto"
        >
          {deciding === "reject" ? inboxCopy.rejecting : inboxCopy.reject}
        </PillButton>
      </div>

      {rejecting ? <RejectMenu disabled={busy} onChoose={(reason) => onReject(item.id, reason)} /> : null}
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
