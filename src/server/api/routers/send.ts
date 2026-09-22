import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { emailLookCopy, sendCopy } from "@/lib/copy/send";
import { EMAIL_FONT_NAMES, EMAIL_FONT_SIZE_MAX, EMAIL_FONT_SIZE_MIN, sanitizeSignature, type EmailFont } from "@/lib/outreach/emailHtml";
import { connectionHooks } from "@/lib/repo/connections";
import { LookRefused, SendRefused, emailLookOf, previewEmail, readyToSend, saveEmailLook, sendEmail } from "@/lib/repo/outreachSend";
import { services } from "@/lib/services";
import { createTRPCRouter, repProcedure } from "@/server/api/trpc";

/**
 * Sending approved emails from the rep's Outlook, and how they look (Relay P7).
 *
 * Every write is the rep's own: the org and the rep come from the session
 * (`ctx`), never from input. Whether an email may go is decided in
 * `src/lib/repo/outreachSend.ts` under the person's lock, not here and not on
 * the screen; this router turns its refusals into a line from the copy file.
 */

const id = z.string().min(1).max(100);
/** A pasted signature before sanitising: generous, because Outlook's HTML is verbose. */
const pasted = z.string().max(200_000);
const look = z.object({ font: z.enum(EMAIL_FONT_NAMES as [EmailFont, ...EmailFont[]]), fontSize: z.number().int().min(EMAIL_FONT_SIZE_MIN).max(EMAIL_FONT_SIZE_MAX), signature: pasted }).strict();

async function repName(ctx: { prisma: import("@prisma/client").PrismaClient; orgId: string; userId: string }): Promise<string> {
  return (await ctx.prisma.user.findFirst({ where: { id: ctx.userId, orgId: ctx.orgId }, select: { name: true } }))?.name?.trim() ?? "";
}

export const sendRouter = createTRPCRouter({
  /** Send one approved, due email step from the rep's mailbox. */
  email: repProcedure.input(z.object({ personId: id, step: z.string().min(1).max(40) }).strict()).mutation(async ({ ctx, input }) => {
    try {
      return await sendEmail(ctx.prisma, services(connectionHooks(ctx.prisma)).graphMail, { orgId: ctx.orgId, userId: ctx.userId, campaignPersonId: input.personId, step: input.step });
    } catch (error) {
      if (!(error instanceof SendRefused)) throw error;
      if (error.refusal === "not_found") throw new TRPCError({ code: "NOT_FOUND" });
      throw new TRPCError({ code: "BAD_REQUEST", message: sendCopy.refused[error.refusal] });
    }
  }),

  /** Approved emails not sent yet on the rep's running campaigns, due first: the Inbox's "Ready to send". */
  ready: repProcedure.query(({ ctx }) => readyToSend(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId })),

  /** The rep's font, size and signature, with a sample email in them. */
  look: repProcedure.query(async ({ ctx }) => {
    const saved = await emailLookOf(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId });
    return { look: saved, preview: previewEmail(saved, await repName(ctx)) };
  }),

  /** The sample email for a look not saved yet: the live preview. The signature is sanitised here, as it is on save. */
  preview: repProcedure.input(look).query(async ({ ctx, input }) => {
    const draft = { font: input.font, fontSize: input.fontSize, signature: sanitizeSignature(input.signature) };
    return { preview: previewEmail(draft, await repName(ctx)) };
  }),

  /** A pasted signature as it would be stored. */
  cleanSignature: repProcedure.input(z.object({ signature: pasted }).strict()).query(({ input }) => ({ signature: sanitizeSignature(input.signature) })),

  saveLook: repProcedure.input(look).mutation(async ({ ctx, input }) => {
    try {
      const saved = await saveEmailLook(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId, ...input });
      return { look: saved, preview: previewEmail(saved, await repName(ctx)) };
    } catch (error) {
      if (!(error instanceof LookRefused)) throw error;
      throw new TRPCError({ code: "BAD_REQUEST", message: emailLookCopy.refused[error.refusal] });
    }
  }),
});
