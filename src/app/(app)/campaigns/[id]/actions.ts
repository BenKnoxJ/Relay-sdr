"use server";

import { TRPCError } from "@trpc/server";

import type { ChangeTarget, RetrySubmission, StartResult, StartSubmission, WidenSubmission } from "@/lib/campaigns/start";
import { campaignsCopy, startCopy } from "@/lib/copy/campaigns";
import { isRefusal, serverCaller } from "@/server/api/caller";

/**
 * What the campaign page and Edit brief submit to: the campaigns router's
 * three changes, through the same `repProcedure` a browser would reach.
 *
 * Each returns the campaign to go back to, or a line to show. Only a line the
 * router took from the copy file is ever returned; a fault is thrown, never
 * shown to a rep as though it were copy.
 */

const LINES: readonly string[] = [campaignsCopy.changedSince, campaignsCopy.cannotChange, campaignsCopy.briefUnchanged, startCopy.cannotStart];

async function answered(change: () => Promise<{ id: string }>): Promise<StartResult> {
  try {
    return await change();
  } catch (error) {
    if (isRefusal(error)) return { error: error.message };
    if (error instanceof TRPCError) {
      if (error.code === "NOT_FOUND") return { error: campaignsCopy.cannotChange };
      if (error.code === "CONFLICT" || error.code === "BAD_REQUEST") {
        // A BAD_REQUEST from input parsing carries zod's words, not ours.
        return { error: LINES.includes(error.message) ? error.message : campaignsCopy.cannotChange };
      }
    }
    throw error;
  }
}

/** A stop's chosen option. */
export async function widenResearch(submission: WidenSubmission): Promise<StartResult> {
  return answered(async () =>
    (await serverCaller()).campaigns.widen({
      campaignId: submission.campaignId,
      fromBriefVersion: submission.briefVersion,
      optionIndex: submission.optionIndex,
      requestId: submission.requestId,
    }),
  );
}

/** Try again on research that failed. */
export async function retryResearch(submission: RetrySubmission): Promise<StartResult> {
  return answered(async () =>
    (await serverCaller()).campaigns.retry({
      campaignId: submission.campaignId,
      briefVersion: submission.briefVersion,
      requestId: submission.requestId,
    }),
  );
}

/**
 * Edit brief's press. The campaign and version are bound by the edit page
 * (`editBrief.bind(null, target)`), so Start's card submits exactly what it
 * submits on Start. Bound arguments travel through the browser like any
 * other, which is why the router checks them again: ownership, and the
 * version against the campaign's own.
 */
export async function editBrief(target: ChangeTarget, submission: StartSubmission): Promise<StartResult> {
  return answered(async () =>
    (await serverCaller()).campaigns.editBrief({
      campaignId: target.campaignId,
      fromBriefVersion: target.briefVersion,
      requestId: submission.startRequestId,
      brief: submission.brief,
    }),
  );
}
