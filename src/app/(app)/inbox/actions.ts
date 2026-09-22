"use server";

import { randomUUID } from "node:crypto";

import { TRPCError } from "@trpc/server";

import { inboxCopy, type RejectReason } from "@/lib/copy/inbox";
import { sendCopy } from "@/lib/copy/send";
import { sendNoteOf } from "@/lib/outreach/sendResult";
import type { Ready, SendFromInbox } from "@/components/inbox/ReadyToSend";
import type { Queue } from "@/lib/fixtures/inbox";
import { isRefusal, serverCaller } from "@/server/api/caller";

/**
 * What the Inbox's draft card submits to (outreach v2.1): approve and reject
 * through the drafts router, and the queue as the server now holds it.
 * Approve makes a draft Ready to send; nothing is sent.
 */

export async function liveQueue(): Promise<Queue> {
  const { items } = await (await serverCaller()).drafts.queue();
  return { items, counts: { replies: 0, calls: 0, drafts: items.length } };
}

async function answered(change: () => Promise<unknown>): Promise<Queue | { error: string }> {
  try {
    await change();
    return await liveQueue();
  } catch (error) {
    if (isRefusal(error)) return { error: error.message };
    if (error instanceof TRPCError && (error.code === "CONFLICT" || error.code === "NOT_FOUND" || error.code === "BAD_REQUEST")) {
      return { error: error.code === "CONFLICT" ? inboxCopy.alreadyDecided : inboxCopy.cannotDecide };
    }
    throw error;
  }
}

export async function approveDraft(id: string, body?: string): Promise<Queue | { error: string }> {
  return answered(async () => (await serverCaller()).drafts.approve({ draftId: id, ...(body === undefined ? {} : { body }) }));
}

export async function rejectDraft(id: string, reason: RejectReason): Promise<Queue | { error: string }> {
  return answered(async () => (await serverCaller()).drafts.reject({ draftId: id, reason, requestId: randomUUID() }));
}

/** Approved emails not sent yet, due first, with each one's Send offer (Relay P7). */
export async function readyToSend(): Promise<Ready> {
  return (await serverCaller()).send.ready();
}

/** Send one from the Inbox's ready list, and hand back the list as it now stands. */
export const sendFromInbox: SendFromInbox = async (input) => {
  const refusals: ReadonlySet<string> = new Set(Object.values(sendCopy.refused));
  try {
    const note = sendNoteOf(await (await serverCaller()).send.email(input));
    return { ready: await readyToSend(), ...note };
  } catch (error) {
    if (error instanceof TRPCError && (error.code === "BAD_REQUEST" || error.code === "NOT_FOUND")) {
      return { error: refusals.has(error.message) ? error.message : sendCopy.refused.none };
    }
    throw error;
  }
};
