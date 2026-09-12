"use server";

import { TRPCError } from "@trpc/server";

import type { StartResult, StartSubmission } from "@/lib/campaigns/start";
import { startCopy } from "@/lib/copy/campaigns";
import { isRefusal, serverCaller } from "@/server/api/caller";

/**
 * What Start's button submits to: the campaign, its Event and its research
 * job, through the same router and `repProcedure` a browser would reach.
 *
 * Returns the campaign to go to, or a line to show under the button. Only a
 * refusal's own message or a line from the copy file is ever returned: a
 * fault is thrown, never shown to a rep as though it were copy.
 */
export async function startCampaign(submission: StartSubmission): Promise<StartResult> {
  try {
    const caller = await serverCaller();
    // A tRPC procedure named `create`, not Prisma: the write itself is
    // `createCampaign` in src/lib/repo, which the procedure calls.
    // eslint-disable-next-line no-restricted-syntax
    const { id } = await caller.campaigns.create(submission);
    return { id };
  } catch (error) {
    if (isRefusal(error)) return { error: error.message };
    if (error instanceof TRPCError && error.code === "BAD_REQUEST") return { error: startCopy.cannotStart };
    throw error;
  }
}
