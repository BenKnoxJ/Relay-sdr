import { type Prisma } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { BriefRefusedError, briefFieldsSchema, nameFrom, toResearchBrief, type ResearchBrief } from "@/lib/campaigns/brief";
import { listCounts, summaryRowOf, toCampaign, toCampaignResearch } from "@/lib/campaigns/view";
import { campaignsCopy, startCopy } from "@/lib/copy/campaigns";
import { leadGenSetup } from "@/lib/leadgen/setup";
import {
  CampaignChangeRefused,
  confirmCampaign,
  confirmReveal,
  createCampaign,
  editCampaignBrief,
  getCampaignForOwner,
  rerunPeople,
  retryResearch,
  retryReveal,
  reviewPeople,
  widenCampaign,
  type ChangeResult,
} from "@/lib/repo/campaigns";
import { campaignSummariesForOwner } from "@/lib/repo/campaignSummary";
import { campaignActivityFor } from "@/lib/repo/campaignActivity";
import { activityOf } from "@/lib/campaigns/activity";
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
/** A research play's id, as the campaign page names it (an m16 candidate id). */
const candidateId = z.string().min(1).max(200);

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
    case "research_not_ready":
      throw new TRPCError({ code: "BAD_REQUEST", message: campaignsCopy.cannotChange });
    case "not_available":
      throw new TRPCError({ code: "BAD_REQUEST", message: campaignsCopy.confirmNotAvailable });
    case "no_ranked_group":
      throw new TRPCError({ code: "BAD_REQUEST", message: campaignsCopy.confirmNoGroup });
    case "no_recipe":
      throw new TRPCError({ code: "BAD_REQUEST", message: campaignsCopy.confirmNoRecipe });
    case "unknown_candidate":
      throw new TRPCError({ code: "BAD_REQUEST", message: campaignsCopy.confirmUnknownPlay });
    case "over_cap":
      throw new TRPCError({ code: "BAD_REQUEST", message: campaignsCopy.confirmOverCap });
    case "balance_unavailable":
      throw new TRPCError({ code: "BAD_REQUEST", message: campaignsCopy.confirmBalanceUnavailable });
    case "nothing_to_reveal":
      throw new TRPCError({ code: "BAD_REQUEST", message: campaignsCopy.revealNothing });
    case "estimate_changed":
      throw new TRPCError({ code: "CONFLICT", message: campaignsCopy.revealChanged });
    case "reveal_over_balance":
      throw new TRPCError({ code: "BAD_REQUEST", message: campaignsCopy.revealOverBalance });
  }
}

/** How finding people is set up here, as the screens need it: nothing about the provider itself. */
function leadGenOptions() {
  const setup = leadGenSetup();
  return { available: setup !== null, searchCreditCap: setup?.searchCreditCap ?? null, sample: setup?.sample ?? false };
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

  /**
   * Confirm plan (lead gen v2.1 §6; orchestrator A2): the frozen handoff, the
   * lawful-basis record and the one lead gen job, from the version on screen.
   * `candidateId` names the play the rep chose (lead gen v2.3); left out,
   * research's top-ranked play is confirmed, as before.
   */
  confirm: repProcedure
    .input(z.object({ campaignId, fromBriefVersion: briefVersion, requestId, candidateId: candidateId.optional() }).strict())
    .mutation(({ ctx, input }) =>
      refusing(confirmCampaign(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId, ...input, setup: leadGenSetup() })),
    ),

  /** Try again on finding people, from Needs you (v2.1 §11). */
  retryPeople: repProcedure
    .input(z.object({ campaignId, briefVersion, requestId }).strict())
    .mutation(({ ctx, input }) => refusing(rerunPeople(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId, ...input }))),

  /** Search with the industry the rep chose, from a Needs you's own choices (v2.1 §5). */
  chooseIndustry: repProcedure
    .input(z.object({ campaignId, briefVersion, requestId, term: z.string().min(1).max(500), label: z.string().min(1).max(200) }).strict())
    .mutation(({ ctx, input }) =>
      refusing(
        rerunPeople(ctx.prisma, {
          orgId: ctx.orgId,
          userId: ctx.userId,
          campaignId: input.campaignId,
          briefVersion: input.briefVersion,
          requestId: input.requestId,
          choice: { term: input.term, label: input.label },
        }),
      ),
    ),

  /**
   * Keep or drop before Reveal (v2.2 §9a): one person, or everyone chosen at
   * that person's account. Setting a decision is its own repeat, so no
   * request id is needed; the version guard still refuses a stale page.
   */
  reviewPeople: repProcedure
    .input(
      z
        .object({
          campaignId,
          briefVersion,
          personId: z.string().min(1).max(100),
          scope: z.enum(["person", "account", "selected"]),
          /** With `selected`: the ticked people, at most a page's worth. */
          personIds: z.array(z.string().min(1).max(100)).max(200).optional(),
          decision: z.enum(["kept", "dropped"]),
        })
        .strict()
        .refine((input) => input.scope !== "selected" || (input.personIds?.length ?? 0) > 0, { message: "selected needs personIds" }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return { id: (await reviewPeople(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId, ...input })).campaign.id };
      } catch (error) {
        asRefusal(error);
      }
    }),

  /**
   * Reveal emails (lead gen v2.1 §6; v2.2 §9a): the second spend approval, for
   * the kept people only, with the figures the page showed. Different figures
   * are refused, never quietly bought; a repeated request id is the same press.
   */
  revealEmails: repProcedure
    .input(
      z
        .object({
          campaignId,
          briefVersion,
          requestId,
          expected: z.object({ toReveal: z.number().int().min(0).max(50), known: z.number().int().min(0).max(50), maxCredits: z.number().int().min(0).max(10_000) }).strict(),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return { id: (await confirmReveal(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId, ...input, setup: leadGenSetup() })).campaign.id };
      } catch (error) {
        // Its own words where revealing is not set up; every other refusal as the other changes say it.
        if (error instanceof CampaignChangeRefused && error.refusal === "not_available") throw new TRPCError({ code: "BAD_REQUEST", message: campaignsCopy.revealNotAvailable });
        asRefusal(error);
      }
    }),

  /**
   * Try again on Reveal emails: only a reveal that failed before any request
   * left Relay, so nothing can have been charged (product-truth foundation).
   */
  retryReveal: repProcedure
    .input(z.object({ campaignId, briefVersion, requestId }).strict())
    .mutation(({ ctx, input }) => refusing(retryReveal(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId, ...input }))),

  /**
   * The rep's campaigns for Home and Campaigns: each row carries its summary
   * facts (stage, what needs the rep, counts, spend), read in a fixed number
   * of queries without loading any research pack, person or org-wide record.
   */
  list: repProcedure.query(async ({ ctx }) => {
    const options = leadGenOptions();
    const rows = await campaignSummariesForOwner(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId }, { leadGenAvailable: options.available });
    const campaigns = rows.map(({ campaign, input }) => summaryRowOf(campaign, input));
    return { campaigns, counts: listCounts(campaigns) };
  }),

  get: repProcedure.input(z.object({ id: campaignId }).strict()).query(async ({ ctx, input }) => {
    const record = await getCampaignForOwner(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId, id: input.id });
    if (record === null) throw new TRPCError({ code: "NOT_FOUND" });
    // The page's Activity tab reads the same feed as `activity`, in one round trip with the campaign.
    const rows = await campaignActivityFor(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId, campaignId: input.id });
    return { ...toCampaign(record, leadGenOptions()), activity: activityOf(rows ?? [], ctx.userId) };
  }),

  /**
   * What has happened on one of the rep's own campaigns, newest first, in
   * their words, from its Events (convergence audit §J). NOT_FOUND for a
   * campaign that is not theirs.
   */
  activity: repProcedure
    .input(z.object({ id: campaignId, limit: z.number().int().min(1).max(50).optional() }).strict())
    .query(async ({ ctx, input }) => {
      const rows = await campaignActivityFor(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId, campaignId: input.id, ...(input.limit === undefined ? {} : { limit: input.limit }) });
      if (rows === null) throw new TRPCError({ code: "NOT_FOUND" });
      return { entries: activityOf(rows, ctx.userId) };
    }),

  /** What Relay learned (task 19): one of the rep's own campaigns, with its finished research read whole. */
  research: repProcedure.input(z.object({ id: campaignId }).strict()).query(async ({ ctx, input }) => {
    const record = await getCampaignForOwner(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId, id: input.id });
    if (record === null) throw new TRPCError({ code: "NOT_FOUND" });
    return toCampaignResearch(record);
  }),
});
