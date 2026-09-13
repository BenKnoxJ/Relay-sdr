import { TRPCError } from "@trpc/server";

import type { Campaign, CampaignResearchPage, CampaignSummary } from "@/lib/campaigns/types";
import { serverCaller } from "@/server/api/caller";

/**
 * The Campaigns screens' data: the seam the pages were written against,
 * now backed by the campaigns router over the real session.
 *
 * Three calls and nothing else, so a page changes by one import and no
 * component learns where a campaign comes from.
 */

export async function listCampaigns(): Promise<{ campaigns: CampaignSummary[]; counts: { running: number; done: number } }> {
  return (await serverCaller()).campaigns.list();
}

/** One of the rep's own campaigns, or null: not theirs and not there are the same answer. */
export async function getCampaign(id: string): Promise<Campaign | null> {
  try {
    return await (await serverCaller()).campaigns.get({ id });
  } catch (error) {
    if (error instanceof TRPCError && error.code === "NOT_FOUND") return null;
    throw error;
  }
}

/** One of the rep's own campaigns with its research read whole (task 19), or null: not theirs and not there are the same answer. */
export async function getCampaignResearch(id: string): Promise<CampaignResearchPage | null> {
  try {
    return await (await serverCaller()).campaigns.research({ id });
  } catch (error) {
    if (error instanceof TRPCError && error.code === "NOT_FOUND") return null;
    throw error;
  }
}
