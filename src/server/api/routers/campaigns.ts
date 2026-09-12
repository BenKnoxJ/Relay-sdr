import { type Prisma } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { BriefRefusedError, briefFieldsSchema, nameFrom, toResearchBrief, type ResearchBrief } from "@/lib/campaigns/brief";
import { listCounts, toCampaign, toSummary } from "@/lib/campaigns/view";
import { startCopy } from "@/lib/copy/campaigns";
import { createCampaign, getCampaignForOwner, listCampaignsForOwner } from "@/lib/repo/campaigns";
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
 */
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

  list: repProcedure.query(async ({ ctx }) => {
    const campaigns = (await listCampaignsForOwner(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId })).map(toCampaign);
    return { campaigns: campaigns.map(toSummary), counts: listCounts(campaigns) };
  }),

  get: repProcedure.input(z.object({ id: z.string().min(1).max(100) }).strict()).query(async ({ ctx, input }) => {
    const record = await getCampaignForOwner(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId, id: input.id });
    if (record === null) throw new TRPCError({ code: "NOT_FOUND" });
    return toCampaign(record);
  }),
});
