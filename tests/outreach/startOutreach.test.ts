import { randomUUID } from "node:crypto";

import type { OutreachDraftState, Prisma } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { nameFrom, toResearchBrief } from "@/lib/campaigns/brief";
import { nextWorkingDay } from "@/lib/outreach/sequence";
import { outreachStartCopy } from "@/lib/copy/outreachStart";
import { prisma } from "@/lib/db";
import { createCampaign } from "@/lib/repo/campaigns";
import { OUTREACH_PAUSED, OUTREACH_RESUMED, OUTREACH_STARTED, outreachStatusFor, setOutreachPaused, startOutreach } from "@/lib/repo/outreachStart";
import { appRouter } from "@/server/api/root";
import type { TRPCContext } from "@/server/api/trpc";
import type { Session } from "@/server/auth/session";
import { ensureUser, type Actor } from "@/server/auth/upsertUser";

import { emptyAll, resetDatabase } from "../db/harness";
import { briefFields } from "../lib/campaignPacks";

/**
 * Start outreach, Pause and Resume (Relay P3) on the real database. The
 * drafts-ready state is put in directly: what is under test is who gets a
 * start day, that a day once set never moves, that every write has its Event,
 * and that another org or rep cannot reach any of it.
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

// A Monday afternoon in London: today is Mon 21 Sep, the next working day Tue 22 Sep.
const MONDAY = () => new Date("2026-09-21T14:00:00Z");

type PersonSpec = { review?: "kept" | "dropped" | "pending"; reveal?: "revealed" | "known" | "no_email" | null; draft?: OutreachDraftState | null };

/** A campaign whose people are as described, each with an Email 1 draft in the given state (or none). */
async function campaignWith(actor: Actor, specs: PersonSpec[]): Promise<{ campaignId: string; people: string[] }> {
  const brief = toResearchBrief(briefFields());
  const { campaign } = await createCampaign(prisma, { orgId: actor.orgId, userId: actor.userId, startRequestId: randomUUID(), name: nameFrom(brief.who), brief: brief as Prisma.InputJsonObject });
  return { campaignId: campaign.id, people: await addPeople(actor, campaign.id, specs) };
}

let serial = 0;

/** People added to a campaign, as a later lead gen batch would (P5b). */
async function addPeople(actor: Actor, campaignId: string, specs: PersonSpec[]): Promise<string[]> {
  const job = await prisma.job.create({ data: { orgId: actor.orgId, ownerUserId: actor.userId, kind: "lead_gen", idempotencyKey: `test:${randomUUID()}`, input: {}, status: "done", campaignId, briefVersion: 1 } });
  const ids: string[] = [];
  for (const spec of specs) {
    serial += 1;
    const person = await prisma.person.create({ data: { orgId: actor.orgId, email: `p${serial}@firm${serial}.co.uk`, emailType: "work", name: `Person ${serial}` } });
    const reveal = spec.reveal === undefined ? "revealed" : spec.reveal;
    const row = await prisma.campaignPerson.create({
      data: {
        orgId: actor.orgId,
        campaignId,
        briefVersion: 1,
        jobId: job.id,
        provider: "lusha",
        providerId: `lusha-${serial}`,
        personId: reveal === "revealed" || reveal === "known" ? person.id : null,
        status: "chosen",
        source: "bought",
        rank: serial,
        score: 80,
        whyPicked: "fits",
        companyKey: `firm${serial}`,
        preview: { name: `Person ${serial}` },
        review: spec.review ?? "kept",
        ...(spec.review === "pending" ? {} : { reviewedAt: new Date(), reviewedByUserId: actor.userId }),
        reveal,
        ...(reveal === null ? {} : { revealedAt: new Date() }),
      },
    });
    const state = spec.draft === undefined ? "to_review" : spec.draft;
    if (state !== null) {
      const draftJob = await prisma.job.create({ data: { orgId: actor.orgId, ownerUserId: actor.userId, kind: "outreach_draft", idempotencyKey: `test:${randomUUID()}`, input: {}, status: "done", campaignId, briefVersion: 1 } });
      const written = state === "failed" ? {} : { body: "Hello.", ask: "Worth a call?", opener: { ref: "x", kind: "role_pain" } };
      const decided = state === "approved" || state === "rejected" ? { decidedAt: new Date(), decidedByUserId: actor.userId, ...(state === "rejected" ? { rejectReason: "not_now" } : {}) } : {};
      await prisma.outreachDraft.create({
        data: { orgId: actor.orgId, campaignId, briefVersion: 1, campaignPersonId: row.id, ownerUserId: actor.userId, jobId: draftJob.id, touch: "email1", state, findings: [], advice: [], lookup: {}, generations: 1, ...written, ...decided },
      });
    }
    ids.push(row.id);
  }
  return ids;
}

const startDays = async (ids: string[]) =>
  Object.fromEntries((await prisma.campaignPerson.findMany({ where: { id: { in: ids } }, select: { id: true, outreachStartOn: true } })).map((row) => [row.id, row.outreachStartOn?.toISOString().slice(0, 10) ?? null]));

const eventsOf = (campaignId: string, kind: string) => prisma.event.findMany({ where: { campaignId, kind }, orderBy: { at: "asc" } });

describe("Start outreach", () => {
  it("dates only kept, revealed people with a live first email, with one Event naming them", async () => {
    const actor = await ensureUser(prisma, rep());
    const { campaignId, people } = await campaignWith(actor, [
      {},
      { reveal: "known", draft: "approved" },
      { draft: "needs_you" },
      { draft: "failed" },
      { draft: "rejected" },
      { draft: null },
      { review: "dropped", reveal: null },
      { reveal: "no_email", draft: null },
    ]);
    const [a, b, c, failed, rejected, undrafted, dropped, noEmail] = people as [string, string, string, string, string, string, string, string];

    const result = await startOutreach(prisma, { orgId: actor.orgId, userId: actor.userId, campaignId, requestId: randomUUID(), startOn: "2026-09-22", now: MONDAY });
    expect(result).toEqual({ people: 3, repeated: false, startOn: "2026-09-22" });
    expect(await startDays(people)).toEqual({ [a]: "2026-09-22", [b]: "2026-09-22", [c]: "2026-09-22", [failed]: null, [rejected]: null, [undrafted]: null, [dropped]: null, [noEmail]: null });

    const events = await eventsOf(campaignId, OUTREACH_STARTED);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ orgId: actor.orgId, actorKind: "user", actorUserId: actor.userId, before: { startOn: null } });
    expect(events[0]?.after).toMatchObject({ startOn: "2026-09-22", people: [a, b, c] });
  });

  it("a second batch starts on its own day and keeps the first batch's", async () => {
    const actor = await ensureUser(prisma, rep());
    const { campaignId, people: first } = await campaignWith(actor, [{}, {}]);
    await startOutreach(prisma, { orgId: actor.orgId, userId: actor.userId, campaignId, requestId: randomUUID(), startOn: "2026-09-22", now: MONDAY });

    const second = await addPeople(actor, campaignId, [{}, {}, {}]);
    const result = await startOutreach(prisma, { orgId: actor.orgId, userId: actor.userId, campaignId, requestId: randomUUID(), startOn: "2026-10-05", now: MONDAY });
    expect(result.people).toBe(3);
    const days = await startDays([...first, ...second]);
    expect(first.map((id) => days[id])).toEqual(["2026-09-22", "2026-09-22"]);
    expect(second.map((id) => days[id])).toEqual(["2026-10-05", "2026-10-05", "2026-10-05"]);

    expect(await outreachStatusFor(prisma, { orgId: actor.orgId, campaignId })).toEqual({
      startable: 0,
      batches: [
        { startOn: "2026-09-22", people: 2 },
        { startOn: "2026-10-05", people: 3 },
      ],
      pausedAt: null,
    });
  });

  it("is idempotent under a double click: the same press twice starts once, with one Event", async () => {
    const actor = await ensureUser(prisma, rep());
    const { campaignId, people } = await campaignWith(actor, [{}, {}]);
    const press = { orgId: actor.orgId, userId: actor.userId, campaignId, requestId: randomUUID(), startOn: "2026-09-22", now: MONDAY };

    const [one, two] = await Promise.all([startOutreach(prisma, press), startOutreach(prisma, press)]);
    expect([one, two].map((r) => r.people)).toEqual([2, 2]);
    expect([one, two].filter((r) => r.repeated)).toHaveLength(1);
    expect(await eventsOf(campaignId, OUTREACH_STARTED)).toHaveLength(1);
    expect(Object.values(await startDays(people))).toEqual(["2026-09-22", "2026-09-22"]);

    // A second press from another tab (a new request id) has nobody left to start, and moves nobody.
    const again = await refusal(caller(rep()).campaigns.startOutreach({ campaignId, requestId: randomUUID(), startOn: "2026-09-29" }));
    expect(again).toEqual({ code: "BAD_REQUEST", message: outreachStartCopy.nothingToStart });
    expect(Object.values(await startDays(people))).toEqual(["2026-09-22", "2026-09-22"]);
  });

  it("refuses a request id reused for a different day", async () => {
    const actor = await ensureUser(prisma, rep());
    const { campaignId } = await campaignWith(actor, [{}]);
    const requestId = randomUUID();
    await startOutreach(prisma, { orgId: actor.orgId, userId: actor.userId, campaignId, requestId, startOn: "2026-09-22", now: MONDAY });
    await expect(startOutreach(prisma, { orgId: actor.orgId, userId: actor.userId, campaignId, requestId, startOn: "2026-09-23", now: MONDAY })).rejects.toMatchObject({ refusal: "request_reused" });
  });

  it("refuses a day before London's today, and what is not a day", async () => {
    const actor = await ensureUser(prisma, rep());
    const { campaignId, people } = await campaignWith(actor, [{}]);
    const base = { orgId: actor.orgId, userId: actor.userId, campaignId, requestId: randomUUID(), now: MONDAY };
    await expect(startOutreach(prisma, { ...base, startOn: "2026-09-18" })).rejects.toMatchObject({ refusal: "bad_date" });
    await expect(startOutreach(prisma, { ...base, startOn: "2026-02-30" })).rejects.toMatchObject({ refusal: "bad_date" });
    // Today itself is allowed.
    await expect(startOutreach(prisma, { ...base, startOn: "2026-09-21" })).resolves.toMatchObject({ people: 1 });
    expect(Object.values(await startDays(people))).toEqual(["2026-09-21"]);
  });

  it("a weekend day starts on the Monday after, and the Event says so (P3 review)", async () => {
    const actor = await ensureUser(prisma, rep());
    const { campaignId, people } = await campaignWith(actor, [{}]);
    await expect(startOutreach(prisma, { orgId: actor.orgId, userId: actor.userId, campaignId, requestId: randomUUID(), startOn: "2026-09-26", now: MONDAY })).resolves.toMatchObject({ people: 1, startOn: "2026-09-28" });
    expect(Object.values(await startDays(people))).toEqual(["2026-09-28"]);
    const [event] = await eventsOf(campaignId, "outreach.started");
    expect((event?.after as { startOn?: string }).startOn).toBe("2026-09-28");
  });

  it("refuses a day more than 30 days ahead, and takes the 30th (P3 review)", async () => {
    const actor = await ensureUser(prisma, rep());
    const { campaignId, people } = await campaignWith(actor, [{}]);
    const base = { orgId: actor.orgId, userId: actor.userId, campaignId, requestId: randomUUID(), now: MONDAY };
    // Mon 21 Sep + 31 days is Thu 22 Oct; + 30 is Wed 21 Oct.
    await expect(startOutreach(prisma, { ...base, startOn: "2026-10-22" })).rejects.toMatchObject({ refusal: "too_far" });
    expect(await refusal(caller(rep()).campaigns.startOutreach({ campaignId, requestId: randomUUID(), startOn: "2099-01-05" }))).toEqual({ code: "BAD_REQUEST", message: outreachStartCopy.tooFar });
    await expect(startOutreach(prisma, { ...base, startOn: "2026-10-21" })).resolves.toMatchObject({ people: 1 });
    expect(Object.values(await startDays(people))).toEqual(["2026-10-21"]);
  });

  it("starts people whose first email is still to review: every email is still approved before it goes", async () => {
    const actor = await ensureUser(prisma, rep());
    const { campaignId, people } = await campaignWith(actor, [{ draft: "to_review" }, { draft: "needs_you" }, { draft: "approved" }]);
    await expect(startOutreach(prisma, { orgId: actor.orgId, userId: actor.userId, campaignId, requestId: randomUUID(), startOn: "2026-09-22", now: MONDAY })).resolves.toMatchObject({ people: 3 });
    expect(Object.values(await startDays(people))).toEqual(["2026-09-22", "2026-09-22", "2026-09-22"]);
  });

  it("stores the day the rep chose, not the instant: 23:30 UTC in summer is already the next day in London", async () => {
    const actor = await ensureUser(prisma, rep());
    const { campaignId } = await campaignWith(actor, [{}]);
    // Mon 21 Sep 23:30 UTC is Tue 22 Sep 00:30 in London: Monday is now in the past, Tuesday is today.
    const lateMonday = () => new Date("2026-09-21T23:30:00Z");
    await expect(startOutreach(prisma, { orgId: actor.orgId, userId: actor.userId, campaignId, requestId: randomUUID(), startOn: "2026-09-21", now: lateMonday })).rejects.toMatchObject({ refusal: "bad_date" });
    await startOutreach(prisma, { orgId: actor.orgId, userId: actor.userId, campaignId, requestId: randomUUID(), startOn: "2026-09-22", now: lateMonday });
    const [row] = await prisma.$queryRaw<Array<{ day: string }>>`SELECT outreach_start_on::text AS day FROM campaign_people WHERE campaign_id = ${campaignId}`;
    expect(row?.day).toBe("2026-09-22");
  });
});

describe("Pause and Resume", () => {
  it("pauses and resumes with an Event each, and a repeat of either changes nothing", async () => {
    const actor = await ensureUser(prisma, rep());
    const { campaignId } = await campaignWith(actor, [{}]);
    const at = new Date("2026-09-23T10:00:00Z");
    const owner = { orgId: actor.orgId, userId: actor.userId, campaignId };

    expect(await setOutreachPaused(prisma, { ...owner, paused: true, now: () => at })).toEqual({ paused: true, changed: true });
    expect((await outreachStatusFor(prisma, owner)).pausedAt?.toISOString()).toBe(at.toISOString());
    expect(await setOutreachPaused(prisma, { ...owner, paused: true })).toEqual({ paused: true, changed: false });
    expect(await eventsOf(campaignId, OUTREACH_PAUSED)).toHaveLength(1);

    expect(await setOutreachPaused(prisma, { ...owner, paused: false })).toEqual({ paused: false, changed: true });
    expect((await outreachStatusFor(prisma, owner)).pausedAt).toBeNull();
    expect(await setOutreachPaused(prisma, { ...owner, paused: false })).toEqual({ paused: false, changed: false });
    const resumed = await eventsOf(campaignId, OUTREACH_RESUMED);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({ before: { pausedAt: at.toISOString() }, after: { pausedAt: null }, actorUserId: actor.userId });
  });

  it("goes through the router", async () => {
    const actor = await ensureUser(prisma, rep());
    const { campaignId } = await campaignWith(actor, [{}]);
    expect(await caller(rep()).campaigns.pauseOutreach({ campaignId, paused: true })).toEqual({ id: campaignId, paused: true });
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).outreachPausedAt).not.toBeNull();
    expect(await caller(rep()).campaigns.pauseOutreach({ campaignId, paused: false })).toEqual({ id: campaignId, paused: false });
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).outreachPausedAt).toBeNull();
  });
});

describe("org and owner scoping", () => {
  it("another org and another rep in the same org get NOT_FOUND, and nothing changes", async () => {
    const actor = await ensureUser(prisma, rep());
    const { campaignId, people } = await campaignWith(actor, [{}, {}]);

    for (const session of [stranger(), colleague()]) {
      // A day the router takes on any day the suite runs, so the answer is about whose campaign it is.
      expect(await refusal(caller(session).campaigns.startOutreach({ campaignId, requestId: randomUUID(), startOn: nextWorkingDay(new Date()) }))).toMatchObject({ code: "NOT_FOUND" });
      expect(await refusal(caller(session).campaigns.pauseOutreach({ campaignId, paused: true }))).toMatchObject({ code: "NOT_FOUND" });
    }
    expect(Object.values(await startDays(people))).toEqual([null, null]);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).outreachPausedAt).toBeNull();
    expect(await prisma.event.count({ where: { campaignId, kind: { in: [OUTREACH_STARTED, OUTREACH_PAUSED, OUTREACH_RESUMED] } } })).toBe(0);
  });

  it("the org comes from the session: the router takes no org or user in its input", async () => {
    const actor = await ensureUser(prisma, rep());
    const { campaignId } = await campaignWith(actor, [{}]);
    const extra = { campaignId, requestId: randomUUID(), startOn: "2099-01-05", orgId: "org_other" } as unknown as Parameters<ReturnType<typeof caller>["campaigns"]["startOutreach"]>[0];
    expect(await refusal(caller(rep()).campaigns.startOutreach(extra))).toMatchObject({ code: "BAD_REQUEST" });
  });
});
