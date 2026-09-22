import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { campaignsCopy } from "@/lib/copy/campaigns";
import { draftItemOf } from "@/lib/outreach/view";
import { DraftRefused, MAX_VOICE_SAMPLES, REJECT_REASONS, approveDraft, rejectDraft, retryDraft, reviewQueue, saveVoice, voiceFor, voiceSampleSchema } from "@/lib/repo/outreach";
import { createTRPCRouter, repProcedure } from "@/server/api/trpc";

/**
 * Drafts (outreach v2 §9–§10, v2.1): the rep's own first emails waiting on
 * them, and their approve and reject. The org and owner are the session's,
 * never the input's; a draft that is not the rep's answers NOT_FOUND.
 * Approve makes a draft Ready to send. Nothing here sends anything.
 */

const draftId = z.string().min(1).max(100);

function refused(error: unknown): never {
  if (!(error instanceof DraftRefused)) throw error;
  if (error.refusal === "not_found") throw new TRPCError({ code: "NOT_FOUND" });
  if (error.refusal === "decided") throw new TRPCError({ code: "CONFLICT", message: campaignsCopy.changedSince });
  throw new TRPCError({ code: "BAD_REQUEST", message: campaignsCopy.cannotChange });
}

async function repName(ctx: { prisma: import("@prisma/client").PrismaClient; orgId: string; userId: string }): Promise<string> {
  const user = await ctx.prisma.user.findFirst({ where: { id: ctx.userId, orgId: ctx.orgId }, select: { name: true, email: true } });
  // The sign-off is the rep's own name; with none on record the card shows none, and the rep adds their own.
  return user?.name?.trim() ?? "";
}

export const draftsRouter = createTRPCRouter({
  /** The rep's drafts waiting on them, needs-you first, as the Inbox draws them. */
  queue: repProcedure.query(async ({ ctx }) => {
    const name = await repName(ctx);
    return { items: (await reviewQueue(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId })).map((draft) => draftItemOf(draft, name)) };
  }),

  /** Approve, with the rep's edit when they made one: Ready to send. */
  approve: repProcedure.input(z.object({ draftId, body: z.string().min(1).max(5000).optional() }).strict()).mutation(async ({ ctx, input }) => {
    try {
      const draft = await approveDraft(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId, draftId: input.draftId, ...(input.body === undefined ? {} : { body: input.body }) });
      return { id: draft.id };
    } catch (error) {
      refused(error);
    }
  }),

  /** Reject with a reason (§9). "Wrong angle" and "wrong fact" ask for another draft. */
  reject: repProcedure
    .input(z.object({ draftId, reason: z.enum(REJECT_REASONS), requestId: z.string().uuid() }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        const { draft, redraftJobId } = await rejectDraft(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId, ...input });
        return { id: draft.id, redrafting: redraftJobId !== null };
      } catch (error) {
        refused(error);
      }
    }),

  /** Try again on a draft that failed or is held (P5c): one more attempt, with no reason recorded. */
  retry: repProcedure.input(z.object({ draftId, requestId: z.string().uuid() }).strict()).mutation(async ({ ctx, input }) => {
    try {
      const { draft, redraftJobId } = await retryDraft(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId, ...input });
      return { id: draft.id, redrafting: redraftJobId !== null };
    } catch (error) {
      refused(error);
    }
  }),

  /** The rep's voice (master §15 v0): samples and "how I write". */
  voice: repProcedure.query(({ ctx }) => voiceFor(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId })),

  saveVoice: repProcedure
    .input(z.object({ samples: z.array(voiceSampleSchema).max(MAX_VOICE_SAMPLES), howIWrite: z.string().max(2000) }).strict())
    .mutation(({ ctx, input }) => saveVoice(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId, voice: input })),
});
