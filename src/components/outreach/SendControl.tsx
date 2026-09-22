"use client";

import Link from "next/link";

import { PillButton } from "@/components/PillButton";
import { sendCopy } from "@/lib/copy/send";
import type { SendOffer } from "@/lib/outreach/send";
import { dayLabel } from "@/lib/outreach/sequence";

/**
 * Where an approved email's Send button goes (Relay P7), in the person drawer
 * and the Inbox's ready list alike.
 *
 * It draws the server's offer and nothing else: whether the email may go is
 * decided on the server, under a lock, by the same rule. Before the due day
 * the button reads "Send from {day}" and does nothing; without a mailbox the
 * rep is sent to Settings; paused, over the cap, or with Email 1 sent by hand,
 * a line says why. A send that may have gone offers only a check.
 */
export function SendControl({ offer, busy, onSend }: { offer: SendOffer; busy: boolean; onSend: () => void }) {
  switch (offer.kind) {
    case "none":
      return null;
    case "send":
      return (
        <PillButton data-testid="send-email" className="w-fit" disabled={busy} onClick={onSend}>
          {busy ? sendCopy.sending : sendCopy.send}
        </PillButton>
      );
    case "not_due":
      return (
        <PillButton data-testid="send-from" className="w-fit" disabled>
          {sendCopy.sendFrom} {dayLabel(offer.from)}
        </PillButton>
      );
    case "no_mailbox":
      return (
        <Link href="/settings" data-testid="send-connect" className="type-small w-fit rounded-input text-action underline outline-none focus-visible:ring-2">
          {sendCopy.connect}
        </Link>
      );
    case "cap":
      return (
        <div className="flex flex-wrap items-center gap-2">
          <PillButton data-testid="send-capped" className="w-fit" disabled>
            {sendCopy.send}
          </PillButton>
          <span data-testid="send-cap-note" className="type-small text-muted">
            {offer.cap} {sendCopy.capNote}
          </span>
        </div>
      );
    case "paused":
      return <p data-testid="send-paused" className="type-small text-muted">{sendCopy.paused}</p>;
    case "by_hand":
      return <p data-testid="send-by-hand" className="type-small text-muted">{sendCopy.byHand}</p>;
    case "sending":
      return (
        <PillButton data-testid="send-sending" className="w-fit" disabled>
          {sendCopy.sending}
        </PillButton>
      );
    case "unverified":
      return (
        <div className="grid gap-1.5">
          <p data-testid="send-unverified" className="type-small text-warn">
            {sendCopy.unverifiedNote}
          </p>
          <PillButton variant="outline" data-testid="send-check" className="w-fit" disabled={busy} onClick={onSend}>
            {busy ? sendCopy.checking : sendCopy.checkIt}
          </PillButton>
        </div>
      );
  }
}
