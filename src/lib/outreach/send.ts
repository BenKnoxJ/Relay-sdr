import type { IsoDate, StepId } from "./sequence";
import { channelOf, type TrackedStep } from "./track";

/**
 * Whether an email step can be sent from the rep's mailbox now, and if not,
 * what the rep sees instead (Relay P7).
 *
 * Pure: the caller reads the facts, this decides. The same function draws the
 * button and is the server's check: `sendEmail` reads the facts again under
 * the person's lock and refuses anything but `send` (or the finishing of a
 * send already under way), so no path sends on the strength of a screen.
 *
 * No scheduler: an email goes when the rep presses Send on or after its due
 * day. Before that the button reads "Send from {date}" and does nothing.
 */

/** Sends per mailbox per day, counted from today's sent emails. */
export const SEND_DAILY_CAP = 30;

/** How long a send may sit half-done before the next press checks the mailbox and takes it over. */
export const SEND_STALE_MS = 2 * 60_000;

export type SendRowState = "sending" | "sent" | "unverified" | "failed";

export type SendOffer =
  /** Press to send. */
  | { kind: "send" }
  /** Approved, but not due yet: "Send from {date}". */
  | { kind: "not_due"; from: IsoDate }
  /** The campaign is paused: nothing sends. */
  | { kind: "paused" }
  /** No mailbox that can send: "Connect your mailbox to send". */
  | { kind: "no_mailbox" }
  /** Today's cap is reached. */
  | { kind: "cap"; cap: number }
  /** A follow-up whose Email 1 went by hand: there is no thread in the mailbox to reply in. */
  | { kind: "by_hand" }
  /** A press is sending it now. */
  | { kind: "sending" }
  /** It may have gone: the next press checks the mailbox before anything else. */
  | { kind: "unverified" }
  /** Nothing to offer: not an email, already done or skipped, or not approved yet. */
  | { kind: "none" };

export type SendFacts = {
  step: Pick<TrackedStep, "id" | "due" | "nextActions">;
  /** The state of the step's draft (the approved attempt if there is one), or null for none. */
  draftState: string | null;
  paused: boolean;
  /** A connected mailbox that may send. */
  mailbox: boolean;
  /** Emails sent from this mailbox today, and sends under way. */
  sentToday: number;
  /** This step's send row, if a press has already claimed it. */
  row: { state: SendRowState; stale: boolean } | null;
  /** For a follow-up: Email 1 went from this mailbox and its thread is known. */
  threadReady: boolean;
  today: IsoDate;
};

/** The email steps, and the one that starts the thread the others reply in. */
export const FIRST_EMAIL: StepId = "email1";
export const isEmailStep = (step: StepId): boolean => channelOf(step) === "email";

export function sendOffer(facts: SendFacts): SendOffer {
  if (!isEmailStep(facts.step.id)) return { kind: "none" };
  const row = facts.row;
  // Marked sent (by this path or by hand), replied, skipped: nothing to send or check.
  if (row?.state === "sent" || !facts.step.nextActions.includes("sent")) return { kind: "none" };
  // A send that may have gone is checked, never sent again blind: the press
  // behind "unverified" only reads the mailbox. A failed one is known not to
  // have gone, so it is offered like a fresh send, and the send path still
  // reads its draft back before sending it.
  if (row !== null && (row.state === "unverified" || (row.state === "sending" && row.stale))) return facts.mailbox ? { kind: "unverified" } : { kind: "no_mailbox" };
  if (row?.state === "sending") return { kind: "sending" };
  if (facts.draftState !== "approved") return { kind: "none" };
  if (facts.paused) return { kind: "paused" };
  if (!facts.mailbox) return { kind: "no_mailbox" };
  if (facts.step.due === null) return { kind: "none" };
  if (facts.step.due > facts.today) return { kind: "not_due", from: facts.step.due };
  if (facts.step.id !== FIRST_EMAIL && !facts.threadReady) return { kind: "by_hand" };
  if (facts.sentToday >= SEND_DAILY_CAP) return { kind: "cap", cap: SEND_DAILY_CAP };
  return { kind: "send" };
}
