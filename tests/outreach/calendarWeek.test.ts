import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { nameFrom, toResearchBrief } from "@/lib/campaigns/brief";
import { outreachTrackingCopy } from "@/lib/copy/outreachTracking";
import { prisma } from "@/lib/db";
import { buildWeek, weekDays, weekStartOf } from "@/lib/outreach/calendar";
import { addCalendarDays, londonDay, stepDueDates, stepState, toDbDate } from "@/lib/outreach/sequence";
import { createCampaign } from "@/lib/repo/campaigns";
import { appRouter } from "@/server/api/root";
import type { TRPCContext } from "@/server/api/trpc";
import type { Session } from "@/server/auth/session";
import { ensureUser, type Actor } from "@/server/auth/upsertUser";

import { emptyAll, resetDatabase } from "../db/harness";
import { briefFields } from "../lib/campaignPacks";

/**
 * The calendar's read (Relay P6) on the real database, through the router:
 * what is due comes from P3's dates and P4's fold, overdue steps come however
 * old, a paused campaign adds nothing and is counted, emails needing approval
 * are marked, and another rep sees none of it.
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
const actorOf = (session: Session) => ensureUser(prisma, session);

const TODAY = londonDay(new Date());
const WEEK = weekStartOf(TODAY);
const FRIDAY = weekDays(WEEK)[4]!;

let serial = 0;

/** A campaign with one kept, revealed person per start day; Email 1 has an approved draft. */
async function campaignWith(actor: Actor, name: string, starts: string[]): Promise<{ campaignId: string; people: string[] }> {
  const brief = toResearchBrief(briefFields());
  const { campaign } = await createCampaign(prisma, { orgId: actor.orgId, userId: actor.userId, startRequestId: randomUUID(), name: nameFrom(brief.who), brief: brief as Prisma.InputJsonObject });
  await prisma.campaign.update({ where: { id: campaign.id }, data: { name } });
  const job = await prisma.job.create({ data: { orgId: actor.orgId, ownerUserId: actor.userId, kind: "lead_gen", idempotencyKey: `test:${randomUUID()}`, input: {}, status: "done", campaignId: campaign.id, briefVersion: 1 } });
  const people: string[] = [];
  for (const startOn of starts) {
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
        preview: { name: `Person ${serial}`, company: `Firm ${serial}` },
        review: "kept",
        reviewedAt: new Date(),
        reviewedByUserId: actor.userId,
        reveal: "revealed",
        revealedAt: new Date(),
        outreachStartOn: toDbDate(startOn),
      },
    });
    // One draft per job and touch: a sequence job per person, as the worker writes them.
    const draftJob = await prisma.job.create({ data: { orgId: actor.orgId, ownerUserId: actor.userId, kind: "outreach_draft", idempotencyKey: `test:${randomUUID()}`, input: {}, status: "done", campaignId: campaign.id, briefVersion: 1 } });
    for (const [touch, state] of [["email1", "approved"], ["email2", "to_review"]] as const) {
      await prisma.outreachDraft.create({
        data: { orgId: actor.orgId, campaignId: campaign.id, briefVersion: 1, campaignPersonId: row.id, ownerUserId: actor.userId, jobId: draftJob.id, touch, attempt: 1, state, ...(state === "approved" ? { decidedAt: new Date(), decidedByUserId: actor.userId } : {}), body: "Hello.", ask: "Worth a call?", opener: { ref: "x", kind: "role_pain" }, subject: "Hello", findings: [], advice: [], lookup: {}, generations: 1 },
      });
    }
    people.push(row.id);
  }
  return { campaignId: campaign.id, people };
}

/** What P3 and P4 say is open for a person started on `startOn` with nothing recorded, up to Friday. */
const expected = (startOn: string) =>
  stepDueDates(startOn)
    .filter((step) => step.due !== null && step.due <= FRIDAY)
    .map((step) => ({ step: step.id, due: step.due, state: stepState(step.due, { today: TODAY, paused: false }) }));

describe("calendarWeek", () => {
  it("lists every open step up to Friday from P3's dates, overdue however old, for two batches", async () => {
    const actor = await actorOf(rep());
    const old = addCalendarDays(TODAY, -140); // further back than dueBetween's 92-day range
    const recent = WEEK;
    const { campaignId, people } = await campaignWith(actor, "Logistics", [old, recent]);
    const view = await caller(rep()).tracking.calendarWeek({ week: TODAY });
    expect(view.week).toBe(WEEK);
    expect(view.campaigns).toEqual([{ id: campaignId, name: "Logistics" }]);
    expect(view.pausedCampaigns).toBe(0);
    const of = (personId: string) => view.items.filter((item) => item.campaignPersonId === personId).map(({ step, due, state }) => ({ step, due, state }));
    const sortByDue = <T extends { due: string | null; step: string }>(rows: T[]) => [...rows].sort((a, b) => (a.due! < b.due! ? -1 : a.due! > b.due! ? 1 : 0));
    expect(sortByDue(of(people[0]!))).toEqual(sortByDue(expected(old)));
    expect(sortByDue(of(people[1]!))).toEqual(sortByDue(expected(recent)));
    expect(view.items.find((item) => item.campaignPersonId === people[0])).toMatchObject({ campaignName: "Logistics", company: expect.stringMatching(/^Firm /), name: expect.stringMatching(/^Person /) });
  });

  it("an earlier week still lists everything overdue today, not only what was due by its Friday", async () => {
    const actor = await actorOf(rep());
    const { people } = await campaignWith(actor, "Logistics", [addCalendarDays(WEEK, -21)]);
    const earlier = await caller(rep()).tracking.calendarWeek({ week: addCalendarDays(WEEK, -14) });
    const now = await caller(rep()).tracking.calendarWeek({ week: TODAY });
    const overdue = (view: typeof now) => view.items.filter((item) => item.campaignPersonId === people[0] && item.state === "overdue").map((item) => item.step);
    expect(overdue(earlier)).toEqual(overdue(now));
  });

  it("marks an email needing approval, and drops a step once it is marked done", async () => {
    const actor = await actorOf(rep());
    const { people } = await campaignWith(actor, "Logistics", [addCalendarDays(TODAY, -30)]);
    const personId = people[0]!;
    const before = await caller(rep()).tracking.calendarWeek({ week: TODAY });
    const step = (id: string) => before.items.find((item) => item.campaignPersonId === personId && item.step === id);
    expect(step("email1")).toMatchObject({ needsApproval: false });
    expect(step("email2")).toMatchObject({ needsApproval: true });
    expect(step("breakup")).toMatchObject({ needsApproval: true });
    expect(step("call1")).toMatchObject({ needsApproval: false });

    await caller(rep()).tracking.markStep({ personId, step: "email1", kind: "sent" });
    const after = await caller(rep()).tracking.calendarWeek({ week: TODAY });
    expect(after.items.some((item) => item.campaignPersonId === personId && item.step === "email1")).toBe(false);
  });

  it("a paused campaign adds nothing and is counted; one never started is neither", async () => {
    const actor = await actorOf(rep());
    const running = await campaignWith(actor, "Running", [WEEK]);
    const paused = await campaignWith(actor, "Paused", [WEEK]);
    await prisma.campaign.update({ where: { id: paused.campaignId }, data: { outreachPausedAt: new Date() } });
    const brief = toResearchBrief(briefFields());
    await createCampaign(prisma, { orgId: actor.orgId, userId: actor.userId, startRequestId: randomUUID(), name: "Not started", brief: brief as Prisma.InputJsonObject });

    const view = await caller(rep()).tracking.calendarWeek({ week: TODAY });
    expect(view.items.every((item) => item.campaignId === running.campaignId)).toBe(true);
    expect(view.items.length).toBeGreaterThan(0);
    expect(view.campaigns).toEqual([{ id: running.campaignId, name: "Running" }]);
    expect(view.pausedCampaigns).toBe(1);
    const week = buildWeek(view.items, { today: TODAY, week: view.week, filter: { campaign: paused.campaignId, channel: null } });
    expect(week.empty).toBe(true);
  });

  it("another org's rep, and a colleague in the same org, see nothing of the rep's", async () => {
    const actor = await actorOf(rep());
    await campaignWith(actor, "Logistics", [WEEK]);
    await actorOf(colleague());
    await actorOf(stranger());
    for (const session of [stranger(), colleague()]) {
      expect(await caller(session).tracking.calendarWeek({ week: TODAY })).toEqual({ week: WEEK, items: [], campaigns: [], pausedCampaigns: 0 });
    }
  });

  it("refuses a day that is not one", async () => {
    await actorOf(rep());
    try {
      await caller(rep()).tracking.calendarWeek({ week: "2026-02-30" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TRPCError);
      expect((error as TRPCError).message).toBe(outreachTrackingCopy.badRange);
    }
  });
});
