import type { OutreachSend, Prisma, PrismaClient } from "@prisma/client";

import { EMAIL_TOUCHES } from "../../../agents/outreach/input.schema";
import { firstNameOf, previewFields } from "@/lib/outreach/adapter";
import { OPT_OUT_LINE } from "@/lib/outreach/envelope";
import { emailHtml, lookOf, sanitizeSignature, EMAIL_FONT_SIZE_MAX, EMAIL_FONT_SIZE_MIN, SIGNATURE_MAX, isEmailFont, type EmailLook } from "@/lib/outreach/emailHtml";
import { FIRST_EMAIL, SEND_STALE_MS, isEmailStep, sendOffer, type SendOffer } from "@/lib/outreach/send";
import { fromDbDate, londonDay, toDbDate, type IsoDate, type StepId } from "@/lib/outreach/sequence";
import { checkEvent, isStepId, touchOf, trackPerson, type PersonTracking, type TrackedStep } from "@/lib/outreach/track";
import { SEND_SCOPE } from "@/lib/services/graphMail/auth";
import { SentButUnverifiedError, ServiceError, type ConnectedAccountRef, type GraphMailService, type MailState } from "@/lib/services/types";

import { getMailbox, refFor } from "./connections";
import { mutate } from "./mutate";
import { TrackingRefused, historyOf, lockPerson, markStep } from "./outreachTracking";

/**
 * Sending an approved email from the rep's mailbox (Relay P7).
 *
 * No scheduler: a send happens when the rep presses Send on an approved email
 * step that is due, on a running campaign, with a mailbox connected. Every one
 * of those is checked here, on the server, under the person's lock, by the
 * same `sendOffer` that draws the button, so a screen that is out of date (or
 * a hand-made request) cannot send what the rules refuse.
 *
 * Once, and only once:
 *
 *   1. An `outreach_sends` row is written BEFORE Microsoft is called. Its
 *      unique key (org, person, step) is the double-press guard: a second
 *      press finds the row and does not send.
 *   2. The mailbox's draft id is stored on the row as soon as there is one.
 *   3. A send whose outcome is unclear (`SentButUnverifiedError`, or a press
 *      that died half-way) is settled by reading that draft back
 *      (`getMessage`): gone out means sent, still a draft means not sent, and
 *      not found means Relay cannot tell, so it says so and sends nothing.
 *      Nothing is ever sent again on the strength of not knowing.
 *
 * Emails 2 and 3 are replies in Email 1's thread (`createReply` on the sent
 * Email 1). Before either, the thread is read for a reply; if there is one the
 * email is not sent and the person is marked replied (P4's event).
 *
 * The org and the rep come from the session; a person who is not on one of
 * the rep's campaigns is `not_found`.
 */

export const SEND_CLAIMED = "outreach.send_claimed" as const;
export const SEND_DRAFTED = "outreach.send_drafted" as const;
export const EMAIL_SENT = "outreach.email_sent" as const;
export const SEND_NOT_SENT = "outreach.send_not_sent" as const;
export const EMAIL_LOOK_SAVED = "rep.email_look_saved" as const;

type Db = PrismaClient | Prisma.TransactionClient;
type Tx = Prisma.TransactionClient;
type Owner = { orgId: string; userId: string };

export type SendRefusal = Exclude<SendOffer["kind"], "send" | "unverified" | "sending"> | "not_found";

export class SendRefused extends Error {
  constructor(readonly refusal: SendRefusal) {
    super(`send refused: ${refusal}`);
    this.name = "SendRefused";
  }
}

export type SendResult =
  /** It went, and the step is marked sent. */
  | { outcome: "sent" }
  /** They replied: nothing was sent, and the person is marked replied. */
  | { outcome: "replied" }
  /** Another press is sending it now. */
  | { outcome: "sending" }
  /** It may have gone and Relay cannot tell: the rep checks Sent Items. */
  | { outcome: "unverified" }
  /** It did not go. `mailbox` means the mailbox needs connecting again. */
  | { outcome: "failed"; reason: "mailbox" | "provider" };

// ---- The mailbox and today's count ----------------------------------------

/** A mailbox that may send: connected, healthy, and consented to sending. */
async function sendingMailbox(db: Db, owner: Owner): Promise<ConnectedAccountRef | null> {
  const account = await getMailbox(db as PrismaClient, owner);
  if (account === null || account.status !== "healthy" || !account.scopes.includes(SEND_SCOPE)) return null;
  return refFor(account);
}

const EMAIL_STEPS: StepId[] = ["email1", "email2", "breakup"];

/**
 * Emails this mailbox sent today (London), from the sent events that still
 * stand, plus today's sends under way or unsettled, so two presses at once
 * cannot both take the last place under the cap. Only today's: a send left
 * unverified yesterday is not one of today's thirty.
 */
export async function sentToday(db: Db, owner: Owner, today: IsoDate): Promise<number> {
  const [sent, underWay] = await Promise.all([
    db.outreachEvent.count({ where: { orgId: owner.orgId, byUserId: owner.userId, kind: "sent", step: { in: EMAIL_STEPS }, happenedOn: toDbDate(today), undoneBy: { is: null } } }),
    db.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM outreach_sends
       WHERE org_id = ${owner.orgId} AND by_user_id = ${owner.userId} AND state IN ('sending', 'unverified')
         AND (claimed_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/London')::date = ${toDbDate(today)}::date`,
  ]);
  return sent + (underWay[0]?.n ?? 0);
}

// ---- Reading what a step needs ---------------------------------------------

type ApprovedDraft = { subject: string | null; body: string };

/** The approved draft for a touch: the latest approved attempt. */
async function approvedDraft(db: Db, orgId: string, campaignPersonId: string, step: StepId): Promise<ApprovedDraft | null> {
  const draft = await db.outreachDraft.findFirst({
    where: { orgId, campaignPersonId, touch: touchOf(step), state: "approved" },
    select: { subject: true, body: true, editedBody: true },
    orderBy: { attempt: "desc" },
  });
  const body = draft?.editedBody ?? draft?.body ?? null;
  return draft === null || body === null ? null : { subject: draft.subject, body };
}

/**
 * The row as the offer reads it. Staleness is wall-clock time since the row
 * last moved, not the "today" a caller may pass: it asks whether a press has
 * died, which is a question about the process, not the calendar.
 */
const rowFacts = (row: Pick<OutreachSend, "state" | "updatedAt"> | null) =>
  row === null ? null : { state: row.state, stale: row.state === "sending" && Date.now() - row.updatedAt.getTime() > SEND_STALE_MS };

/** Email 1's send row when it went from this mailbox: the thread Emails 2 and 3 reply in. */
const threadOf = (rows: ReadonlyArray<Pick<OutreachSend, "step" | "state" | "messageId" | "conversationId">>) => {
  const first = rows.find((row) => row.step === FIRST_EMAIL && row.state === "sent" && row.messageId !== null && row.conversationId !== null);
  return first === undefined ? null : { messageId: first.messageId!, conversationId: first.conversationId! };
};

type Plan = {
  campaignId: string;
  to: string;
  greeting: string;
  signOff: string;
  step: TrackedStep;
  tracking: PersonTracking;
  draft: ApprovedDraft | null;
  row: OutreachSend | null;
  thread: { messageId: string; conversationId: string } | null;
  mailbox: ConnectedAccountRef | null;
  offer: SendOffer;
};

/** Everything a send reads, and the offer it adds up to. Null when the person is not the rep's. */
async function planFor(db: Db, input: Owner & { campaignPersonId: string; step: StepId; now: Date }): Promise<Plan | null> {
  const person = await db.campaignPerson.findFirst({
    where: { id: input.campaignPersonId, orgId: input.orgId, status: "chosen", review: "kept", personId: { not: null }, campaign: { ownerUserId: input.userId } },
    select: { id: true, campaignId: true, outreachStartOn: true, preview: true, person: { select: { email: true } }, campaign: { select: { outreachPausedAt: true } } },
  });
  if (person === null) return null;
  const today = londonDay(input.now);
  const paused = person.campaign.outreachPausedAt !== null;
  const startOn = person.outreachStartOn === null ? null : fromDbDate(person.outreachStartOn);
  const tracking = trackPerson({ startOn, events: await historyOf(db, input.orgId, person.id), today, paused });
  const step = tracking.steps.find((candidate) => candidate.id === input.step)!;
  const [draft, rows, mailbox, count, user] = await Promise.all([
    approvedDraft(db, input.orgId, person.id, input.step),
    db.outreachSend.findMany({ where: { orgId: input.orgId, campaignPersonId: person.id } }),
    sendingMailbox(db, input),
    sentToday(db, input, today),
    db.user.findFirst({ where: { id: input.userId, orgId: input.orgId }, select: { name: true } }),
  ]);
  const row = rows.find((candidate) => candidate.step === input.step) ?? null;
  const thread = threadOf(rows);
  // No address, nothing to send to (a revealed person always has one; this is the belt to that brace).
  const offer: SendOffer = !person.person?.email ? { kind: "none" } : sendOffer({
    step,
    draftState: draft === null ? null : "approved",
    paused,
    mailbox: mailbox !== null,
    sentToday: count,
    row: rowFacts(row),
    threadReady: thread !== null,
    today,
  });
  return {
    campaignId: person.campaignId,
    to: person.person?.email ?? "",
    // The card's envelope (outreach v2.1 §4), exactly: `draftItemOf` builds it the same way.
    greeting: `Hi ${firstNameOf(previewFields(person.preview).name)},`,
    signOff: firstNameOf(user?.name?.trim() ?? ""),
    step,
    tracking,
    draft,
    row,
    thread,
    mailbox,
    offer,
  };
}

/** The offer for each email step of one of the rep's people, for the drawer. */
export async function sendOffersFor(db: Db, input: Owner & { campaignPersonId: string; now?: Date }): Promise<Partial<Record<StepId, SendOffer>>> {
  const now = input.now ?? new Date();
  const offers: Partial<Record<StepId, SendOffer>> = {};
  for (const step of EMAIL_STEPS) {
    const plan = await planFor(db, { ...input, step, now });
    if (plan === null) return {};
    offers[step] = plan.offer;
  }
  return offers;
}

export type ReadyItem = {
  campaignId: string;
  campaignName: string;
  campaignPersonId: string;
  name: string;
  company: string;
  step: StepId;
  due: IsoDate;
  subject: string | null;
  offer: SendOffer;
};

/**
 * Approved emails on the rep's running campaigns that are not sent yet, due
 * first, with what the Send button says for each: the Inbox's "Ready to send".
 */
export async function readyToSend(db: PrismaClient, owner: Owner & { now?: Date }): Promise<{ items: ReadyItem[]; sentToday: number; mailbox: boolean }> {
  const now = owner.now ?? new Date();
  const today = londonDay(now);
  const approved = await db.outreachDraft.findMany({
    where: { orgId: owner.orgId, ownerUserId: owner.userId, touch: { in: [...EMAIL_TOUCHES] }, state: "approved", campaign: { outreachPausedAt: null }, campaignPerson: { outreachStartOn: { not: null } } },
    select: { campaignPersonId: true, touch: true, subject: true, campaign: { select: { id: true, name: true } }, campaignPerson: { select: { preview: true } } },
    orderBy: { attempt: "desc" },
    take: 500,
  });
  const seen = new Set<string>();
  const items: ReadyItem[] = [];
  for (const draft of approved) {
    const step = EMAIL_STEPS.find((candidate) => touchOf(candidate) === draft.touch);
    const key = `${draft.campaignPersonId}:${draft.touch}`;
    if (step === undefined || seen.has(key)) continue;
    seen.add(key);
    const plan = await planFor(db, { ...owner, campaignPersonId: draft.campaignPersonId, step, now });
    if (plan === null || plan.offer.kind === "none" || plan.step.due === null) continue;
    const preview = previewFields(draft.campaignPerson.preview);
    items.push({ campaignId: draft.campaign.id, campaignName: draft.campaign.name, campaignPersonId: draft.campaignPersonId, name: preview.name, company: preview.company, step, due: plan.step.due, subject: draft.subject, offer: plan.offer });
  }
  items.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : EMAIL_STEPS.indexOf(a.step) - EMAIL_STEPS.indexOf(b.step)));
  return { items, sentToday: await sentToday(db, owner, today), mailbox: (await sendingMailbox(db, owner)) !== null };
}

// ---- The send ---------------------------------------------------------------

export type SendEmailInput = Owner & { campaignPersonId: string; step: string; now?: () => Date };

/** Serialise one rep's claims, so the cap is counted with no other claim in between. */
async function lockSender(tx: Tx, userId: string): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`relay-send:${userId}`}))::text`;
}

type Claimed = { row: OutreachSend; plan: Plan; resumed: boolean };

/**
 * Claim the send under the person's lock and the sender's: re-read
 * everything, refuse unless the offer is `send` (a fresh send, or a retry of
 * a failed one) or `unverified` (a check of one that may have gone), and write
 * or take over the row. "sending" when another press holds it.
 */
async function claim(db: PrismaClient, input: SendEmailInput & { step: StepId }): Promise<Claimed | "sending"> {
  const now = (input.now ?? (() => new Date()))();
  return mutate(db, {
    orgId: input.orgId,
    actor: { kind: "user", userId: input.userId },
    kind: SEND_CLAIMED,
    campaignId: (result: Claimed | "sending") => (result === "sending" ? null : result.plan.campaignId),
    after: (result: Claimed | "sending") => (result === "sending" ? { campaignPersonId: input.campaignPersonId, step: input.step, sending: true } : { campaignPersonId: input.campaignPersonId, step: input.step, resumed: result.resumed }),
    apply: async (tx) => {
      const locked = await lockPerson(tx, input);
      if (locked === null) throw new SendRefused("not_found");
      await lockSender(tx, input.userId);
      const plan = await planFor(tx, { ...input, now });
      if (plan === null) throw new SendRefused("not_found");
      const { offer, row } = plan;
      if (offer.kind === "sending") return "sending";
      if (offer.kind === "unverified" && row !== null) {
        const taken = await tx.outreachSend.update({ where: { id: row.id }, data: { state: "sending", claimedAt: now } });
        return { row: taken, plan, resumed: true };
      }
      if (offer.kind !== "send") throw new SendRefused(offer.kind === "unverified" ? "none" : offer.kind);
      // A failed row is known not to have gone: it is taken over, keeping its draft id for the check below.
      const taken =
        row !== null
          ? await tx.outreachSend.update({ where: { id: row.id }, data: { state: "sending", failure: null, byUserId: input.userId, claimedAt: now } })
          : await tx.outreachSend.create({ data: { orgId: input.orgId, campaignId: plan.campaignId, campaignPersonId: locked.id, step: input.step, byUserId: input.userId, state: "sending", claimedAt: now } });
      return { row: taken, plan, resumed: row !== null };
    },
  });
}

/** Record where a claimed send got to. Only the row changes; the Event says what happened. */
type Settled = { state?: "unverified" | "failed"; graphDraftId?: string | null; failure?: string };

async function settle(db: PrismaClient, input: SendEmailInput, row: OutreachSend, data: Settled, kind: typeof SEND_DRAFTED | typeof SEND_NOT_SENT): Promise<OutreachSend> {
  return mutate(db, {
    orgId: input.orgId,
    actor: { kind: "user", userId: input.userId },
    kind,
    campaignId: row.campaignId,
    after: { sendId: row.id, step: row.step, campaignPersonId: row.campaignPersonId, state: data.state ?? row.state, failure: data.failure ?? null, drafted: (data.graphDraftId ?? row.graphDraftId) !== null },
    apply: (tx) => tx.outreachSend.update({ where: { id: row.id }, data }),
  });
}

/**
 * It went: the row carries the ids, and the step gets P4's `sent` event, in
 * one transaction under the person's lock. If the rep marked it sent by hand
 * in the meantime, the fold refuses a second mark and only the row changes.
 */
async function finish(db: PrismaClient, input: SendEmailInput, row: OutreachSend, ids: { id: string; internetMessageId: string; conversationId: string }, now: Date): Promise<SendResult> {
  const happenedOn = londonDay(now);
  await mutate(db, {
    orgId: input.orgId,
    actor: { kind: "user", userId: input.userId },
    kind: EMAIL_SENT,
    campaignId: row.campaignId,
    after: { sendId: row.id, step: row.step, campaignPersonId: row.campaignPersonId, messageId: ids.id, conversationId: ids.conversationId, happenedOn },
    apply: async (tx) => {
      const locked = await lockPerson(tx, input);
      await tx.outreachSend.update({ where: { id: row.id }, data: { state: "sent", messageId: ids.id, internetMessageId: ids.internetMessageId || null, conversationId: ids.conversationId, sentAt: now, failure: null } });
      if (locked === null) return;
      const proposed = { step: row.step as StepId, kind: "sent" as const, outcome: null, callResult: null, note: null, happenedOn, undoesEventId: null };
      if (checkEvent(await historyOf(tx, input.orgId, locked.id), proposed, { startOn: locked.startOn }) !== null) return;
      await tx.outreachEvent.create({ data: { orgId: input.orgId, campaignId: locked.campaignId, campaignPersonId: locked.id, step: row.step, kind: "sent", happenedOn: toDbDate(happenedOn), byUserId: input.userId } });
    },
  });
  return { outcome: "sent" };
}

/** A refusal from Microsoft that means the mailbox needs connecting again, or anything else. */
const reasonOf = (error: unknown): "mailbox" | "provider" => (error instanceof ServiceError && (error.status === 401 || error.status === 403) ? "mailbox" : "provider");
const codeOf = (error: unknown): string => (error instanceof ServiceError ? `${error.status}${error.code ? `:${error.code}` : ""}` : "error").slice(0, 80);

/**
 * The thread has a reply: mark it on the latest email that went (P4's
 * `replied`), and send nothing. A person already marked replied is left as is.
 */
async function markReplied(db: PrismaClient, input: SendEmailInput, plan: Plan, now: Date): Promise<SendResult> {
  const answered = [...plan.tracking.steps].reverse().find((step) => isEmailStep(step.id) && step.doneOn !== null && step.nextActions.includes("replied"));
  if (answered !== undefined) {
    try {
      await markStep(db, { orgId: input.orgId, userId: input.userId, campaignPersonId: input.campaignPersonId, step: answered.id, kind: "replied", now: () => now });
    } catch (error) {
      if (!(error instanceof TrackingRefused)) throw error;
    }
  }
  return { outcome: "replied" };
}

/**
 * Send one approved, due email step from the rep's mailbox. Refusals (not
 * due, paused, no mailbox, over the cap, not the rep's) throw `SendRefused`;
 * everything that happened at Microsoft comes back as a `SendResult`.
 */
export async function sendEmail(db: PrismaClient, mail: GraphMailService, input: SendEmailInput): Promise<SendResult> {
  const clock = input.now ?? (() => new Date());
  if (!isStepId(input.step) || !isEmailStep(input.step)) throw new SendRefused("none");
  const step = input.step;

  // The reply check comes before the claim: it only reads, and a reply found
  // means no row is written. The claim below reads everything again.
  const before = await planFor(db, { ...input, step, now: clock() });
  if (before === null) throw new SendRefused("not_found");
  if (before.offer.kind === "sending") return { outcome: "sending" };
  if (before.offer.kind !== "send" && before.offer.kind !== "unverified") throw new SendRefused(before.offer.kind);
  if (before.offer.kind === "send" && step !== FIRST_EMAIL && before.thread !== null && before.mailbox !== null) {
    let replied: boolean;
    try {
      replied = await mail.conversationHasReply(before.mailbox, before.thread.conversationId, before.thread.messageId);
    } catch (error) {
      return { outcome: "failed", reason: reasonOf(error) };
    }
    if (replied) return markReplied(db, { ...input, step }, before, clock());
  }

  const claimed = await claim(db, { ...input, step });
  if (claimed === "sending") return { outcome: "sending" };
  const { plan } = claimed;
  let row = claimed.row;
  const account = plan.mailbox;
  if (account === null) {
    await settle(db, input, row, { state: row.graphDraftId === null ? "failed" : "unverified", failure: "no_mailbox" }, SEND_NOT_SENT);
    return { outcome: "failed", reason: "mailbox" };
  }

  // A draft from an earlier press is read back before anything is sent: gone
  // out means this one is done. When checking a send that may have gone
  // (`unverified`), that is all this press does: still a draft means it did
  // not go and the rep presses Send again, through every check; not found
  // means nobody can say, and nothing is sent. When retrying a failed send,
  // its draft goes if it is still a draft, and a new one is made if it is gone.
  const checking = plan.offer.kind === "unverified";
  if (row.graphDraftId !== null) {
    let state: MailState;
    try {
      state = await mail.getMessage(account, row.graphDraftId);
    } catch (error) {
      await settle(db, input, row, { state: "unverified", failure: codeOf(error) }, SEND_NOT_SENT);
      return { outcome: "unverified" };
    }
    if (state.notFound !== true && !state.isDraft) return finish(db, input, row, state, clock());
    if (checking) {
      // Still a draft is only proof it did not go once Microsoft has had time
      // to finish a send it may have accepted: until the row is stale, it stays unverified.
      const settled = plan.row !== null && Date.now() - plan.row.updatedAt.getTime() > SEND_STALE_MS;
      if (state.notFound === true || !settled) {
        await settle(db, input, row, { state: "unverified", failure: state.notFound === true ? "draft_not_found" : "still_a_draft" }, SEND_NOT_SENT);
        return { outcome: "unverified" };
      }
      await settle(db, input, row, { state: "failed", failure: "not_sent" }, SEND_NOT_SENT);
      return { outcome: "failed", reason: "provider" };
    }
    if (state.notFound === true) row = await settle(db, input, row, { graphDraftId: null }, SEND_DRAFTED);
  } else if (checking) {
    // Taken over with no draft recorded: with no draft, nothing could have been sent.
    await settle(db, input, row, { state: "failed", failure: "not_sent" }, SEND_NOT_SENT);
    return { outcome: "failed", reason: "provider" };
  }

  if (row.graphDraftId === null) {
    const draft = plan.draft!;
    const look = await emailLookOf(db, input);
    const html = emailHtml({ greeting: plan.greeting, body: draft.body, signOff: plan.signOff, optOut: OPT_OUT_LINE }, look);
    try {
      const created =
        step === FIRST_EMAIL
          ? await mail.createDraft(account, { to: plan.to, subject: draft.subject ?? "", html })
          : await mail.createReply(account, plan.thread!.messageId, { to: plan.to, html });
      row = await settle(db, input, row, { graphDraftId: created.id }, SEND_DRAFTED);
    } catch (error) {
      await settle(db, input, row, { state: "failed", failure: codeOf(error) }, SEND_NOT_SENT);
      return { outcome: "failed", reason: reasonOf(error) };
    }
  }

  try {
    const ids = await mail.send(account, row.graphDraftId!);
    return finish(db, input, row, ids, clock());
  } catch (error) {
    if (!(error instanceof SentButUnverifiedError)) {
      await settle(db, input, row, { state: "failed", failure: codeOf(error) }, SEND_NOT_SENT);
      return { outcome: "failed", reason: reasonOf(error) };
    }
    // Microsoft may have taken it. Read the draft back once; never send it again to find out.
    // Still a draft here is not proof: a send Microsoft accepted can take a
    // moment to leave Drafts, so it stays unverified until a later check,
    // once the row is stale, can say it did not go.
    await settle(db, input, row, { state: "unverified", failure: codeOf(error) }, SEND_NOT_SENT);
    let state: MailState;
    try {
      state = await mail.getMessage(account, row.graphDraftId!);
    } catch {
      return { outcome: "unverified" };
    }
    if (state.notFound !== true && !state.isDraft) return finish(db, input, row, state, clock());
    return { outcome: "unverified" };
  }
}

// ---- The look ----------------------------------------------------------------

/** The rep's font, size and signature, or the defaults (Aptos 11, no signature). */
export async function emailLookOf(db: Db, owner: Owner): Promise<EmailLook> {
  const user = await db.user.findFirst({ where: { id: owner.userId, orgId: owner.orgId }, select: { emailFont: true, emailFontSize: true, emailSignature: true } });
  return user === null ? lookOf({ emailFont: "", emailFontSize: 0, emailSignature: "" }) : lookOf(user);
}

export class LookRefused extends Error {
  constructor(readonly refusal: "bad_font" | "bad_size" | "long_signature") {
    super(`email look refused: ${refusal}`);
    this.name = "LookRefused";
  }
}

/** Save the rep's font, size and signature. The signature is sanitised before it is stored. */
export async function saveEmailLook(db: PrismaClient, input: Owner & { font: string; fontSize: number; signature: string }): Promise<EmailLook> {
  if (!isEmailFont(input.font)) throw new LookRefused("bad_font");
  if (!Number.isInteger(input.fontSize) || input.fontSize < EMAIL_FONT_SIZE_MIN || input.fontSize > EMAIL_FONT_SIZE_MAX) throw new LookRefused("bad_size");
  const signature = sanitizeSignature(input.signature);
  if (signature.length > SIGNATURE_MAX) throw new LookRefused("long_signature");
  const look: EmailLook = { font: input.font, fontSize: input.fontSize, signature };
  await mutate(db, {
    orgId: input.orgId,
    actor: { kind: "user", userId: input.userId },
    kind: EMAIL_LOOK_SAVED,
    // The signature is the rep's own words and contact details; the Event records that it changed, not what it says.
    after: { font: look.font, fontSize: look.fontSize, signatureLength: look.signature.length },
    apply: (tx) => tx.user.updateMany({ where: { id: input.userId, orgId: input.orgId }, data: { emailFont: look.font, emailFontSize: look.fontSize, emailSignature: look.signature } }),
  });
  return look;
}

/** The email as it would be sent for a sample person, for Settings' preview. */
export function previewEmail(look: EmailLook, repName: string): string {
  return emailHtml(
    {
      greeting: "Hi Alex,",
      body: "This is how your emails from Relay will look: your font and size, one line between paragraphs, then your signature.\n\nWould it be worth a short call next week?",
      signOff: firstNameOf(repName.trim()),
    },
    look,
  );
}
