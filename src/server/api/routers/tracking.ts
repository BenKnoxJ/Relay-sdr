import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { outreachTrackingCopy } from "@/lib/copy/outreachTracking";
import { londonDay } from "@/lib/outreach/sequence";
import { CALL_RESULTS, NOTE_MAX, OUTREACH_OUTCOMES, STEP_ACTIONS } from "@/lib/outreach/track";
import {
  TrackingRefused,
  addNote,
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

  /** One person in full: steps, a draft per step, every mark, and the notes. */
  personTracking: repProcedure.input(z.object({ personId: id }).strict()).query(async ({ ctx, input }) => {
    const view = await personTracking(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId, campaignPersonId: input.personId, today: today() });
    if (view === null) throw new TRPCError({ code: "NOT_FOUND" });
    return view;
  }),

  /** Open steps due between two days (both included) across the rep's campaigns, for the calendar. */
  dueBetween: repProcedure
    .input(z.object({ from: day, to: day }).strict())
    .query(({ ctx, input }) => refusing(dueBetween(ctx.prisma, { orgId: ctx.orgId, userId: ctx.userId, ...input, today: today() }).then((items) => ({ items })))),
});
