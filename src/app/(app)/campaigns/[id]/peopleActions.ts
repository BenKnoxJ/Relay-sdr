"use server";

import { randomUUID } from "node:crypto";

import { TRPCError } from "@trpc/server";

import { campaignsCopy } from "@/lib/copy/campaigns";
import { outreachPeopleCopy } from "@/lib/copy/outreachPeople";
import { outreachTrackingCopy } from "@/lib/copy/outreachTracking";
import type { CallResult, OutreachOutcome, StepAction } from "@/lib/outreach/track";
import { isRefusal, serverCaller } from "@/server/api/caller";

/**
 * What the People tab and the person drawer submit to (Relay P5): P4's
 * tracking procedures and the Inbox's approve and reject, through the same
 * `repProcedure` a browser would reach. Nothing here decides what is allowed;
 * the server's fold does, and a refusal comes back as its line.
 *
 * Each answers `{ ok: true }` or a line to show. Only a line the router took
 * from a copy file is ever returned; a fault is thrown, never shown to a rep
 * as though it were copy.
 */

export type PeopleActionResult = { ok: true } | { error: string };

const LINES: ReadonlySet<string> = new Set<string>([...Object.values(outreachTrackingCopy), campaignsCopy.changedSince, campaignsCopy.cannotChange]);

async function answered(change: () => Promise<unknown>): Promise<PeopleActionResult> {
  try {
    await change();
    return { ok: true };
  } catch (error) {
    if (isRefusal(error)) return { error: error.message };
    if (error instanceof TRPCError && (error.code === "BAD_REQUEST" || error.code === "CONFLICT" || error.code === "NOT_FOUND")) {
      return { error: LINES.has(error.message) ? error.message : outreachPeopleCopy.cannotChange };
    }
    throw error;
  }
}

export async function markStepAction(input: { personId: string; step: string; kind: StepAction; callResult?: CallResult; note?: string }): Promise<PeopleActionResult> {
  return answered(async () => (await serverCaller()).tracking.markStep(input));
}

export async function undoAction(input: { eventId: string }): Promise<PeopleActionResult> {
  return answered(async () => (await serverCaller()).tracking.undo(input));
}

export async function addNoteAction(input: { personId: string; text: string }): Promise<PeopleActionResult> {
  return answered(async () => (await serverCaller()).tracking.addNote(input));
}

export async function setOutcomeAction(input: { personId: string; outcome: OutreachOutcome }): Promise<PeopleActionResult> {
  return answered(async () => (await serverCaller()).tracking.setOutcome(input));
}

export async function meetingBookedAction(input: { personId: string }): Promise<PeopleActionResult> {
  return answered(async () => (await serverCaller()).tracking.meetingBooked(input));
}

export async function setPhoneAction(input: { personId: string; phone: string }): Promise<PeopleActionResult> {
  return answered(async () => (await serverCaller()).tracking.setPhone(input));
}

/** Approve an email, with the rep's edit when they made one: the Inbox's own approve. */
export async function approveDraftAction(input: { draftId: string; body?: string }): Promise<PeopleActionResult> {
  return answered(async () => (await serverCaller()).drafts.approve(input));
}

/** Reject an email with a reason: the Inbox's own reject. */
export async function rejectDraftAction(input: { draftId: string; reason: "wrong_angle" | "wrong_person" | "wrong_fact" | "not_now" }): Promise<PeopleActionResult> {
  return answered(async () => (await serverCaller()).drafts.reject({ ...input, requestId: randomUUID() }));
}

/**
 * Try again on a draft that failed or is held as Needs you: the existing
 * single-draft redraft, which is a reject that asks for another attempt.
 */
export async function tryAgainAction(input: { draftId: string }): Promise<PeopleActionResult> {
  return answered(async () => (await serverCaller()).drafts.reject({ draftId: input.draftId, reason: "wrong_angle", requestId: randomUUID() }));
}
