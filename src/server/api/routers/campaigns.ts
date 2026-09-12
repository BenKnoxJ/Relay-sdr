import { type Prisma } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { BriefRefusedError, briefFieldsSchema, nameFrom, toResearchBrief, type ResearchBrief } from "@/lib/campaigns/brief";
import { listCounts, toCampaign, toSummary } from "@/lib/campaigns/view";
import { campaignsCopy, startCopy } from "@/lib/copy/campaigns";
import {
  CampaignChangeRefused,
  createCampaign,
  editCampaignBrief,
  getCampaignForOwner,
  listCampaignsForOwner,
  retryResearch,
  widenCampaign,
  type ChangeResult,
} from "@/lib/repo/campaigns";
import { createTRPCRouter, repProcedure } from "@/server/api/trpc";

/**
 * Campaigns: start one, list the rep's own, read one.
 *
 * The rep sees their own campaigns and nothing else: "own" is the campaign's
 * org and owner, both from the session (`ctx`), never from input. A campaign
 * the caller cannot see answers NOT_FOUND, never FORBIDDEN, so an id is not an
 * oracle for what another rep holds.
 *
 * What comes back is the screen's own shape (`Campaign`), built on the server:
 * the research pack is parsed and turned into plan cards here, so zod and the
 * research contract never reach the browser.
 *
 * Widen, Edit brief and Try again (orchestrator A1, items 4 to 6) each name
 * the brief version the rep was looking at and a request id their page minted
 * once. A refusal comes back as a code and a line from the copy file: CONFLICT
 * when the campaign has moved on from what the page showed, BAD_REQUEST for a
 * change that cannot be made, NOT_FOUND for a campaign that is not the rep's.
 */

const campaignId = z.string().min(1).max(100);
const briefVersion = z.number().int().min(1).max(1_000_000);
const requestId = z.string().uuid();

/** A refused change as the code and line a page can show; anything else is a fault and is rethrown. */
function asRefusal(error: unknown): never {
  if (!(error instanceof CampaignChangeRefused)) throw error;
  switch (error.refusal) {
    case "not_found":
      throw new TRPCError({ code: "NOT_FOUND" });
    case "version_behind":
    case "wrong_state":
    case "request_reused":
      throw new TRPCError({ code: "CONFLICT", message: campaignsCopy.changedSince });
    case "unchanged":
      throw new TRPCError({ code: "BAD_REQUEST", message: campaignsCopy.briefUnchanged });
    case "version_ahead":
    case "bad_option":
      throw new TRPCError({ code: "BAD_REQUEST", message: campaignsCopy.cannotChange });
  }
}

async function refusing(change: Promise<ChangeResult>): Promise<{ id: string }> {
  try {
    return { id: (await change).campaign.id };
  } catch (error) {
    asRefusal(error);
  }
}
export const campaignsRouter = createTRPCRouter({
  /**
   * Start: the campaign, its Event and its first research job, in one
   * transaction. A repeated `startRequestId` is the same press, and returns
   * the campaign the first one made.
   */
  create: repProcedure
    .input(z.object({ startRequestId: z.string().uuid(), brief: briefFieldsSchema }).strict())
    .mutation(async ({ ctx, input }) => {
      let brief: ResearchBrief;
      try {
        brief = toResearchBrief(input.brief);
      } catch (error) {
        if (error instanceof BriefRefusedError || error instanceof z.ZodError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: startCopy.cannotStart });
        }
        throw error;
      }
      const { campaign } = await createCampaign(ctx.prisma, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        startRequestId: input.startRequestId,
        name: nameFrom(brief.who),
        brief: brief as Prisma.InputJsonObject,
      });
      return { id: campaign.id };
    }),

  /** Widen (A1, item 4): one of the stop's options, by position, as the next brief version. */
  widen: repProcedure
    .input(z.object({ campaignId, fromBriefVersion: briefVersion, optionIndex: z.number().int().min(0).max(2), requestId }).strict())
    .mutation(({ ctx, input }) =>
      refusing(widenCampaign(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId, ...input })),
    ),

  /** Edit brief (A1, item 5): Start's card, checked as Start checks it, as the next brief version. */
  editBrief: repProcedure
    .input(z.object({ campaignId, fromBriefVersion: briefVersion, requestId, brief: briefFieldsSchema }).strict())
    .mutation(async ({ ctx, input }) => {
      let brief: ResearchBrief;
      try {
        brief = toResearchBrief(input.brief);
      } catch (error) {
        if (error instanceof BriefRefusedError || error instanceof z.ZodError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: startCopy.cannotStart });
        }
        throw error;
      }
      return refusing(
        editCampaignBrief(ctx.prisma, {
          orgId: ctx.orgId,
          userId: ctx.userId,
          campaignId: input.campaignId,
          fromBriefVersion: input.fromBriefVersion,
          requestId: input.requestId,
          brief,
        }),
      );
    }),

  /** Try again (A1, item 6): the failed research job, back on the queue, at the same brief version. */
  retry: repProcedure
    .input(z.object({ campaignId, briefVersion, requestId }).strict())
    .mutation(({ ctx, input }) => refusing(retryResearch(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId, ...input }))),

  list: repProcedure.query(async ({ ctx }) => {
    const campaigns = (await listCampaignsForOwner(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId })).map(toCampaign);
    return { campaigns: campaigns.map(toSummary), counts: listCounts(campaigns) };
  }),

  get: repProcedure.input(z.object({ id: campaignId }).strict()).query(async ({ ctx, input }) => {
    const record = await getCampaignForOwner(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId, id: input.id });
    if (record === null) throw new TRPCError({ code: "NOT_FOUND" });
    return toCampaign(record);
  }),
});
