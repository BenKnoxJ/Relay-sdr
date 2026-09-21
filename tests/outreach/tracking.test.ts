import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { nameFrom, toResearchBrief } from "@/lib/campaigns/brief";
import { outreachTrackingCopy } from "@/lib/copy/outreachTracking";
import { prisma } from "@/lib/db";
import { londonDay, toDbDate } from "@/lib/outreach/sequence";
import { createCampaign } from "@/lib/repo/campaigns";
import { OUTREACH_PHONE_SET, OUTREACH_TRACKED, OUTREACH_UNDONE, markStep } from "@/lib/repo/outreachTracking";
import { appRouter } from "@/server/api/root";
import type { TRPCContext } from "@/server/api/trpc";
import type { Session } from "@/server/auth/session";
import { ensureUser, type Actor } from "@/server/auth/upsertUser";

import { emptyAll, resetDatabase } from "../db/harness";
import { briefFields } from "../lib/campaignPacks";

/**
 * Tracking (Relay P4) on the real database, through the router: every write
 * lands one row and one Event, the server refuses what the fold says is not a
 * valid next action, nothing updates or deletes a row, and another org's or
 * another rep's person cannot be marked or read.
 */

vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: null }), currentUser: async () => null }));

beforeAll(async () => {
  await resetDatabase();
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await emptyAll();
});

function contextFor(session: Session): TRPCContext {
  let pending: Promise<Actor> | undefined;
  return { prisma, headers: new Headers(), session, actor: () => (pending ??= ensureUser(prisma, session)) };
}
const sessionOf = (clerkId: string, email: string): Session => ({ clerkId, profile: async () => ({ email, name: "Sam Carter" }) });
const rep = () => sessionOf("user_rep", "rep@example.test");
const colleague = () => sessionOf("user_colleague", "colleague@example.test");
const stranger = () => sessionOf("user_stranger", "stranger@other.test");
const caller = (session: Session) => appRouter.createCaller(contextFor(session));

async function refusal(promise: Promise<unknown>): Promise<{ code: string; message: string } | "ok"> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (error instanceof TRPCError) return { code: error.code, message: error.message };
    throw error;
  }
}

const TODAY = londonDay(new Date());

let serial = 0;

/** A campaign with `n` kept, revealed people, each with an Email 1 draft; started on `startOn` unless null. */
async function campaignWith(actor: Actor, n: number, startOn: string | null = TODAY): Promise<{ campaignId: string; people: string[] }> {
  const brief = toResearchBrief(briefFields());
  const { campaign } = await createCampaign(prisma, { orgId: actor.orgId, userId: actor.userId, startRequestId: randomUUID(), name: nameFrom(brief.who), brief: brief as Prisma.InputJsonObject });
  const job = await prisma.job.create({ data: { orgId: actor.orgId, ownerUserId: actor.userId, kind: "lead_gen", idempotencyKey: `test:${randomUUID()}`, input: {}, status: "done", campaignId: campaign.id, briefVersion: 1 } });
  const draftJob = await prisma.job.create({ data: { orgId: actor.orgId, ownerUserId: actor.userId, kind: "outreach_draft", idempotencyKey: `test:${randomUUID()}`, input: {}, status: "done", campaignId: campaign.id, briefVersion: 1 } });
  const people: string[] = [];
  for (let i = 0; i < n; i += 1) {
    serial += 1;
    const person = await prisma.person.create({ data: { orgId: actor.orgId, email: `p${serial}@firm${serial}.co.uk`, emailType: "work", name: `Person ${serial}` } });
    const row = await prisma.campaignPerson.create({
      data: {
        orgId: actor.orgId,
        campaignId: campaign.id,
        briefVersion: 1,
        jobId: job.id,
        provider: "lusha",
        providerId: `lusha-${serial}`,
        personId: person.id,
        status: "chosen",
        source: "bought",
        rank: serial,
        score: 80,
        whyPicked: "fits",
        companyKey: `firm${serial}`,
        preview: { name: `Person ${serial}` },
        review: "kept",
        reviewedAt: new Date(),
        reviewedByUserId: actor.userId,
        reveal: "revealed",
        revealedAt: new Date(),
        ...(startOn === null ? {} : { outreachStartOn: toDbDate(startOn) }),
      },
    });
    for (const [touch, attempt, body] of [["email1", 1, "First try."], ["email1", 2, "Second try."], ["call", 1, "Call script."]] as const) {
      await prisma.outreachDraft.create({
        data: { orgId: actor.orgId, campaignId: campaign.id, briefVersion: 1, campaignPersonId: row.id, ownerUserId: actor.userId, jobId: attempt === 2 ? job.id : draftJob.id, touch, attempt, state: "to_review", body, ask: "Worth a call?", opener: { ref: "x", kind: "role_pain" }, subject: touch === "call" ? null : "Hello", findings: [], advice: [], lookup: {}, generations: 1 },
      });
    }
    people.push(row.id);
  }
  return { campaignId: campaign.id, people };
}

const actorOf = (session: Session) => ensureUser(prisma, session);

describe("writes", () => {
  it("markStep writes one row and one Event, in the rep's org, and the fold moves on", async () => {
    const actor = await actorOf(rep());
    const { campaignId, people } = await campaignWith(actor, 1);
    const marked = await caller(rep()).tracking.markStep({ personId: people[0]!, step: "email1", kind: "sent" });
    expect(marked).toMatchObject({ kind: "sent", step: "email1", happenedOn: TODAY, campaignId });

    const rows = await prisma.outreachEvent.findMany({ where: { campaignPersonId: people[0] } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ orgId: actor.orgId, campaignId, byUserId: actor.userId, kind: "sent", step: "email1" });
    const events = await prisma.event.findMany({ where: { orgId: actor.orgId, kind: OUTREACH_TRACKED } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ campaignId, actorUserId: actor.userId, after: expect.objectContaining({ id: rows[0]!.id, campaignPersonId: people[0] }) });

    const view = await caller(rep()).tracking.personTracking({ personId: people[0]! });
    expect(view.tracking.steps.find((step) => step.id === "email1")).toMatchObject({ state: "done", doneOn: TODAY, nextActions: ["replied", "bounced"] });
  });

  it("refuses what is not a valid next action, with a plain reason, and writes nothing", async () => {
    const actor = await actorOf(rep());
    const { people } = await campaignWith(actor, 1);
    const me = caller(rep());
    expect(await refusal(me.tracking.markStep({ personId: people[0]!, step: "email1", kind: "replied" }))).toEqual({ code: "BAD_REQUEST", message: outreachTrackingCopy.notAllowed });
    expect(await refusal(me.tracking.markStep({ personId: people[0]!, step: "call1", kind: "done" }))).toEqual({ code: "BAD_REQUEST", message: outreachTrackingCopy.callResult });
    expect(await refusal(me.tracking.markStep({ personId: people[0]!, step: "nope", kind: "sent" }))).toEqual({ code: "BAD_REQUEST", message: outreachTrackingCopy.unknownStep });
    expect(await refusal(me.tracking.markStep({ personId: people[0]!, step: "email1", kind: "sent", on: "2999-01-01" }))).toEqual({ code: "BAD_REQUEST", message: outreachTrackingCopy.badDate });
    await me.tracking.markStep({ personId: people[0]!, step: "email1", kind: "sent" });
    expect(await refusal(me.tracking.markStep({ personId: people[0]!, step: "email1", kind: "sent" }))).toEqual({ code: "BAD_REQUEST", message: outreachTrackingCopy.notAllowed });
    expect(await prisma.outreachEvent.count()).toBe(1);
    expect(await prisma.event.count({ where: { kind: OUTREACH_TRACKED } })).toBe(1);
  });

  it("refuses a step mark before the person is started, but takes a note", async () => {
    const actor = await actorOf(rep());
    const { people } = await campaignWith(actor, 1, null);
    expect(await refusal(caller(rep()).tracking.markStep({ personId: people[0]!, step: "email1", kind: "sent" }))).toEqual({ code: "BAD_REQUEST", message: outreachTrackingCopy.notStarted });
    expect(await refusal(caller(rep()).tracking.addNote({ personId: people[0]!, text: "Met at the conference." }))).toBe("ok");
  });

  it("a call with its result and a note, a reply that skips the rest, a meeting and an outcome", async () => {
    const actor = await actorOf(rep());
    const { campaignId, people } = await campaignWith(actor, 1);
    const me = caller(rep());
    const personId = people[0]!;
    await me.tracking.markStep({ personId, step: "call1", kind: "done", callResult: "spoke", note: "Asked for an email." });
    await me.tracking.markStep({ personId, step: "email1", kind: "sent" });
    await me.tracking.markStep({ personId, step: "email1", kind: "replied" });
    await me.tracking.meetingBooked({ personId, note: "Thursday at 10." });
    await me.tracking.setOutcome({ personId, outcome: "closed" });
    expect(await refusal(me.tracking.setOutcome({ personId, outcome: "not_interested" }))).toEqual({ code: "BAD_REQUEST", message: outreachTrackingCopy.alreadyRecorded });

    const view = await me.tracking.personTracking({ personId });
    expect(view.status).toBe("closed");
    expect(view.tracking.steps.find((step) => step.id === "call1")).toMatchObject({ state: "done", callResult: "spoke" });
    expect(view.tracking.steps.filter((step) => step.state === "skipped").map((step) => step.id)).toEqual(["li_connect", "email2", "li_dm", "call2", "li_dm2", "breakup"]);
    expect(view.notes.map((n) => n.note)).toEqual(["Thursday at 10.", "Asked for an email."]);
    // The stored draft per step: the latest attempt; both calls read the one call script.
    expect(view.drafts.email1).toMatchObject({ attempt: 2, body: "Second try." });
    expect(view.drafts.call1).toMatchObject({ body: "Call script." });
    expect(view.drafts.call2).toMatchObject({ body: "Call script." });
    expect(view.drafts.email2).toBeNull();

    const list = await me.tracking.campaignPeopleTracking({ campaignId });
    expect(list.rows[0]).toMatchObject({ campaignPersonId: personId, status: "closed", progress: { done: 2, total: 8 }, nextDue: null, lastActivityOn: TODAY });
    expect(list.counts).toEqual({ peopleStarted: 1, emailsSent: 1, connectsSent: 0, connectsAccepted: 0, replies: 1, callsDone: 1, meetings: 1 });
  });

  it("undo appends an undo row, reverses exactly that row, and cannot be done twice", async () => {
    const actor = await actorOf(rep());
    const { people } = await campaignWith(actor, 1);
    const me = caller(rep());
    const personId = people[0]!;
    const sent = await me.tracking.markStep({ personId, step: "email1", kind: "sent" });
    const replied = await me.tracking.markStep({ personId, step: "email1", kind: "replied" });
    expect(await refusal(me.tracking.undo({ eventId: sent.id }))).toEqual({ code: "BAD_REQUEST", message: outreachTrackingCopy.undoLaterFirst });
    const undo = await me.tracking.undo({ eventId: replied.id });
    expect(undo.kind).toBe("undo");
    expect(await refusal(me.tracking.undo({ eventId: replied.id }))).toEqual({ code: "BAD_REQUEST", message: outreachTrackingCopy.cannotUndo });
    expect(await refusal(me.tracking.undo({ eventId: undo.id }))).toEqual({ code: "BAD_REQUEST", message: outreachTrackingCopy.cannotUndo });

    const view = await me.tracking.personTracking({ personId });
    expect(view.status).toBe("in_sequence");
    expect(view.events.map((event) => [event.kind, event.undone])).toEqual([["sent", false], ["replied", true], ["undo", false]]);
    expect(await prisma.event.count({ where: { kind: OUTREACH_UNDONE } })).toBe(1);
    // The original rows are untouched.
    expect(await prisma.outreachEvent.findUnique({ where: { id: replied.id } })).toMatchObject({ kind: "replied", undoesEventId: null });
  });

  it("setPhone sets and clears the number with its Event, and refuses one that is not a number", async () => {
    const actor = await actorOf(rep());
    const { people } = await campaignWith(actor, 1);
    const me = caller(rep());
    expect(await me.tracking.setPhone({ personId: people[0]!, phone: " +44 20 7946 0000 " })).toEqual({ phone: "+44 20 7946 0000" });
    expect(await refusal(me.tracking.setPhone({ personId: people[0]!, phone: "call me" }))).toEqual({ code: "BAD_REQUEST", message: outreachTrackingCopy.badPhone });
    expect(await me.tracking.setPhone({ personId: people[0]!, phone: "" })).toEqual({ phone: null });
    const events = await prisma.event.findMany({ where: { kind: OUTREACH_PHONE_SET }, orderBy: { at: "asc" } });
    expect(events.map((event) => [event.before, event.after])).toEqual([
      [{ campaignPersonId: people[0], phone: null }, { campaignPersonId: people[0], phone: "+44 20 7946 0000" }],
      [{ campaignPersonId: people[0], phone: "+44 20 7946 0000" }, { campaignPersonId: people[0], phone: null }],
    ]);
  });

  it("two concurrent marks of the same step: one lands, the other is refused", async () => {
    const actor = await actorOf(rep());
    const { people } = await campaignWith(actor, 1);
    const both = await Promise.allSettled([0, 1].map(() => markStep(prisma, { orgId: actor.orgId, userId: actor.userId, campaignPersonId: people[0]!, step: "email1", kind: "sent" })));
    expect(both.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await prisma.outreachEvent.count()).toBe(1);
  });
});

describe("append-only", () => {
  it("the table refuses an UPDATE and a DELETE", async () => {
    const actor = await actorOf(rep());
    const { people } = await campaignWith(actor, 1);
    const sent = await caller(rep()).tracking.markStep({ personId: people[0]!, step: "email1", kind: "sent" });
    await expect(prisma.$executeRaw`UPDATE outreach_events SET note = 'x' WHERE id = ${sent.id}`).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`DELETE FROM outreach_events WHERE id = ${sent.id}`).rejects.toThrow(/append-only/);
    expect(await prisma.outreachEvent.findUnique({ where: { id: sent.id } })).toMatchObject({ note: null });
  });
});

describe("reads", () => {
  it("dueBetween lists open steps across the rep's campaigns; a paused campaign adds nothing", async () => {
    const actor = await actorOf(rep());
    const running = await campaignWith(actor, 1);
    const paused = await campaignWith(actor, 1);
    await prisma.campaign.update({ where: { id: paused.campaignId }, data: { outreachPausedAt: new Date() } });
    await caller(rep()).tracking.markStep({ personId: running.people[0]!, step: "email1", kind: "sent" });
    const { items } = await caller(rep()).tracking.dueBetween({ from: TODAY, to: TODAY });
    expect(items.every((item) => item.campaignId === running.campaignId)).toBe(true);
    expect(items.map((item) => item.step)).not.toContain("email1");
    const wide = await caller(rep()).tracking.dueBetween({ from: "2026-01-01", to: "2026-03-31" });
    expect(wide.items.some((item) => item.campaignId === paused.campaignId)).toBe(false);
    expect(await refusal(caller(rep()).tracking.dueBetween({ from: "2026-01-01", to: "2026-12-31" }))).toEqual({ code: "BAD_REQUEST", message: outreachTrackingCopy.badRange });
    const pausedList = await caller(rep()).tracking.campaignPeopleTracking({ campaignId: paused.campaignId });
    expect(pausedList).toMatchObject({ paused: true, rows: [{ nextDue: null }] });
  });
});

describe("org and owner scoping", () => {
  it("another org's rep, and a colleague in the same org, can neither mark nor read the rep's people", async () => {
    const actor = await actorOf(rep());
    const { campaignId, people } = await campaignWith(actor, 1);
    const personId = people[0]!;
    const sent = await caller(rep()).tracking.markStep({ personId, step: "email1", kind: "sent" });
    await actorOf(colleague());
    await actorOf(stranger());
    for (const session of [stranger(), colleague()]) {
      const them = caller(session);
      for (const attempt of [
        () => them.tracking.markStep({ personId, step: "li_connect", kind: "sent" }),
        () => them.tracking.undo({ eventId: sent.id }),
        () => them.tracking.addNote({ personId, text: "x" }),
        () => them.tracking.setOutcome({ personId, outcome: "closed" }),
        () => them.tracking.meetingBooked({ personId }),
        () => them.tracking.setPhone({ personId, phone: "0123" }),
        () => them.tracking.campaignPeopleTracking({ campaignId }),
        () => them.tracking.personTracking({ personId }),
      ]) {
        expect(await refusal(attempt())).toEqual({ code: "NOT_FOUND", message: "NOT_FOUND" });
      }
      expect((await them.tracking.dueBetween({ from: TODAY, to: TODAY })).items).toEqual([]);
    }
    expect(await prisma.outreachEvent.count()).toBe(1);
    expect(await prisma.campaignPerson.findUnique({ where: { id: personId }, select: { phone: true } })).toEqual({ phone: null });
  });

  it("the org and owner come from the session: input cannot name them", async () => {
    const actor = await actorOf(rep());
    const { people } = await campaignWith(actor, 1);
    const withOrg = { personId: people[0]!, step: "email1", kind: "sent", orgId: "other" } as unknown as Parameters<ReturnType<typeof caller>["tracking"]["markStep"]>[0];
    expect(await refusal(caller(rep()).tracking.markStep(withOrg))).toMatchObject({ code: "BAD_REQUEST" });
  });
});
