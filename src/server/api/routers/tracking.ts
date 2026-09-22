import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { outreachTrackingCopy } from "@/lib/copy/outreachTracking";
import { weekDays, weekStartOf } from "@/lib/outreach/calendar";
import { isIsoDate, londonDay } from "@/lib/outreach/sequence";
import { draftItemOf } from "@/lib/outreach/view";
import { draftsForCard } from "@/lib/repo/outreach";
import { sendOffersFor } from "@/lib/repo/outreachSend";
import { CALL_RESULTS, NOTE_MAX, OUTREACH_OUTCOMES, STEP_ACTIONS, channelOf, isStepId } from "@/lib/outreach/track";
import {
  TrackingRefused,
  addNote,
  calendarItems,
  campaignPeopleTracking,
  dueBetween,
  markStep,
  meetingBooked,
  personTracking,
  setOutcome,
  setPhone,
  undoEvent,
} from "@/lib/repo/outreachTracking";
import { createTRPCRouter, repProcedure } from "@/server/api/trpc";

/**
 * Tracking (Relay P4): what the rep recorded on each person's outreach, and
 * the reads P5's people list and drawer and P6's calendar are built on.
 *
 * Every write is on one of the rep's own people: the org and owner come from
 * the session (`ctx`), never from input, and a person who is not theirs
 * answers NOT_FOUND. The server decides what is a valid next action (the fold
 * in `src/lib/outreach/track.ts`); anything else is BAD_REQUEST with a line
 * from the copy file saying why.
 */

const id = z.string().min(1).max(100);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const note = z.string().max(NOTE_MAX);

function refused(error: unknown): never {
  if (!(error instanceof TrackingRefused)) throw error;
  const message: Record<Exclude<TrackingRefused["refusal"], "not_found">, string> = {
    not_allowed: outreachTrackingCopy.notAllowed,
    unknown_step: outreachTrackingCopy.unknownStep,
    call_result: outreachTrackingCopy.callResult,
    already_recorded: outreachTrackingCopy.alreadyRecorded,
    cannot_undo: outreachTrackingCopy.cannotUndo,
    undo_later_first: outreachTrackingCopy.undoLaterFirst,
    too_early: outreachTrackingCopy.tooEarly,
    not_started: outreachTrackingCopy.notStarted,
    not_approved: outreachTrackingCopy.notApproved,
    bad_date: outreachTrackingCopy.badDate,
    bad_range: outreachTrackingCopy.badRange,
    empty_note: outreachTrackingCopy.emptyNote,
    long_note: outreachTrackingCopy.longNote,
    bad_phone: outreachTrackingCopy.badPhone,
  };
  if (error.refusal === "not_found") throw new TRPCError({ code: "NOT_FOUND" });
  throw new TRPCError({ code: "BAD_REQUEST", message: message[error.refusal] });
}

async function refusing<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    refused(error);
  }
}

const today = () => londonDay(new Date());

export const trackingRouter = createTRPCRouter({
  /** Mark a step: sent, accepted, declined, replied, bounced, or a call done with how it went. */
  markStep: repProcedure
    .input(z.object({ personId: id, step: z.string().min(1).max(40), kind: z.enum(STEP_ACTIONS), callResult: z.enum(CALL_RESULTS).optional(), note: note.optional(), on: day.optional() }).strict())
    .mutation(({ ctx, input }) => {
      const { personId, ...rest } = input;
      return refusing(markStep(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId, campaignPersonId: personId, ...rest }));
    }),

  /** Undo one mark, note, meeting or outcome. */
  undo: repProcedure.input(z.object({ eventId: id }).strict()).mutation(({ ctx, input }) => refusing(undoEvent(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId, eventId: input.eventId }))),

  addNote: repProcedure
    .input(z.object({ personId: id, text: note.min(1) }).strict())
    .mutation(({ ctx, input }) => refusing(addNote(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId, campaignPersonId: input.personId, text: input.text }))),

  setOutcome: repProcedure
    .input(z.object({ personId: id, outcome: z.enum(OUTREACH_OUTCOMES), note: note.optional() }).strict())
    .mutation(({ ctx, input }) => {
      const { personId, ...rest } = input;
      return refusing(setOutcome(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId, campaignPersonId: personId, ...rest }));
    }),

  meetingBooked: repProcedure
    .input(z.object({ personId: id, on: day.optional(), note: note.optional() }).strict())
    .mutation(({ ctx, input }) => {
      const { personId, ...rest } = input;
      return refusing(meetingBooked(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId, campaignPersonId: personId, ...rest }));
    }),

  /** Set the person's phone number; an empty one clears it. */
  setPhone: repProcedure
    .input(z.object({ personId: id, phone: z.string().max(60) }).strict())
    .mutation(({ ctx, input }) => refusing(setPhone(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId, campaignPersonId: input.personId, phone: input.phone }))),

  /** One campaign's people as the list draws them, with the campaign's counts. */
  campaignPeopleTracking: repProcedure.input(z.object({ campaignId: id }).strict()).query(async ({ ctx, input }) => {
    const view = await campaignPeopleTracking(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId, campaignId: input.campaignId, today: today() });
    if (view === null) throw new TRPCError({ code: "NOT_FOUND" });
    return view;
  }),

  /**
   * One person in full: steps, a draft per step, every mark, and the notes.
   * Each email step's draft also comes as the Inbox's card (`emailCards`),
   * built by the same `draftItemOf`, so there is one place for that card.
   */
  personTracking: repProcedure.input(z.object({ personId: id }).strict()).query(async ({ ctx, input }) => {
    const view = await personTracking(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId, campaignPersonId: input.personId, today: today() });
    if (view === null) throw new TRPCError({ code: "NOT_FOUND" });
    const emailDraftIds = Object.entries(view.drafts).flatMap(([step, draft]) => (draft !== null && isStepId(step) && channelOf(step) === "email" ? [draft.id] : []));
    const rows = await draftsForCard(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId, ids: emailDraftIds });
    const repName = (await ctx.prisma.user.findFirst({ where: { id: ctx.userId, orgId: ctx.orgId }, select: { name: true } }))?.name?.trim() ?? "";
    const cards = new Map(rows.map((row) => [row.id, draftItemOf(row, repName)]));
    const emailCards = Object.fromEntries(Object.entries(view.drafts).flatMap(([step, draft]) => (draft !== null && cards.has(draft.id) ? [[step, cards.get(draft.id)!]] : [])));
    // What each email step's Send button says (P7): read on the server by the same rule the send itself checks.
    const sendOffers = await sendOffersFor(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId, campaignPersonId: input.personId });
    return { ...view, emailCards, sendOffers };
  }),

  /** Open steps due between two days (both included) across the rep's campaigns, for the calendar. */
  dueBetween: repProcedure
    .input(z.object({ from: day, to: day }).strict())
    .query(({ ctx, input }) => refusing(dueBetween(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId, ...input, today: today() }).then((items) => ({ items })))),

  /**
   * The calendar's week (P6): the Monday of the week `week` falls in, every
   * open step due up to its Friday or today, whichever is later (overdue ones
   * however old), and which of the rep's campaigns are running or paused.
   */
  calendarWeek: repProcedure.input(z.object({ week: day }).strict()).query(async ({ ctx, input }) => {
    if (!isIsoDate(input.week)) refused(new TrackingRefused("bad_range"));
    const monday = weekStartOf(input.week);
    // Up to the later of Friday and today: Overdue holds everything overdue, whichever week is open.
    const friday = weekDays(monday)[4]!;
    const now = today();
    const view = await refusing(calendarItems(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId, to: friday > now ? friday : now, today: now }));
    return { week: monday, ...view };
  }),
});
