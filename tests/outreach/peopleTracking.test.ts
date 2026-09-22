import { randomUUID } from "node:crypto";

import type { OutreachDraftState, Prisma } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { nameFrom, toResearchBrief } from "@/lib/campaigns/brief";
import { outreachTrackingCopy } from "@/lib/copy/outreachTracking";
import { prisma } from "@/lib/db";
import { londonDay, toDbDate } from "@/lib/outreach/sequence";
import { createCampaign } from "@/lib/repo/campaigns";
import { draftsForCard, recordDrafts } from "@/lib/repo/outreach";
import { appRouter } from "@/server/api/root";
import type { TRPCContext } from "@/server/api/trpc";
import type { Session } from "@/server/auth/session";
import { ensureUser, type Actor } from "@/server/auth/upsertUser";

import { SEQUENCE } from "../../agents/outreach/input.schema";
import { emptyAll, resetDatabase } from "../db/harness";
import { briefFields } from "../lib/campaignPacks";

/**
 * The People list and the person drawer (Relay P5) on the real database,
 * through the routers the page calls: the list's rows carry who the person
 * is, an email is marked sent only once approved, the Inbox and the drawer
 * read the same draft state, Try again redrafts a draft that failed, a
 * LinkedIn or call draft is stored with no subject, and another org's or
 * another rep's person is not readable.
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

type DraftSpec = { touch: string; attempt?: number; state?: OutreachDraftState; body?: string | null; subject?: string | null };

/** A started campaign with one kept, revealed person and the drafts described. */
async function personWith(actor: Actor, drafts: DraftSpec[], preview: Record<string, unknown> = {}): Promise<{ campaignId: string; personId: string; jobIds: string[] }> {
  const brief = toResearchBrief(briefFields());
  const { campaign } = await createCampaign(prisma, { orgId: actor.orgId, userId: actor.userId, startRequestId: randomUUID(), name: nameFrom(brief.who), brief: brief as Prisma.InputJsonObject });
  const job = await prisma.job.create({ data: { orgId: actor.orgId, ownerUserId: actor.userId, kind: "lead_gen", idempotencyKey: `test:${randomUUID()}`, input: {}, status: "done", campaignId: campaign.id, briefVersion: 1 } });
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
      preview: { name: `Person ${serial}`, ...preview },
      review: "kept",
      reviewedAt: new Date(),
      reviewedByUserId: actor.userId,
      reveal: "revealed",
      revealedAt: new Date(),
      outreachStartOn: toDbDate(TODAY),
    },
  });
  const jobIds: string[] = [];
  for (const spec of drafts) {
    const draftJob = await prisma.job.create({ data: { orgId: actor.orgId, ownerUserId: actor.userId, kind: "outreach_draft", idempotencyKey: `test:${randomUUID()}`, input: {}, status: "done", campaignId: campaign.id, briefVersion: 1 } });
    jobIds.push(draftJob.id);
    const state = spec.state ?? "to_review";
    const body = spec.body === undefined ? (state === "failed" ? null : `${spec.touch} words.`) : spec.body;
    await prisma.outreachDraft.create({
      data: {
        orgId: actor.orgId,
        campaignId: campaign.id,
        briefVersion: 1,
        campaignPersonId: row.id,
        ownerUserId: actor.userId,
        jobId: draftJob.id,
        touch: spec.touch,
        attempt: spec.attempt ?? 1,
        state,
        body,
        ask: body === null ? null : "Worth a call?",
        subject: spec.subject ?? null,
        ...(body === null ? {} : { opener: { ref: "x", kind: "role_pain" } }),
        ...(state === "approved" || state === "rejected" ? { decidedAt: new Date(), decidedByUserId: actor.userId } : {}),
        ...(state === "rejected" ? { rejectReason: "wrong_angle" } : {}),
        findings: [],
        advice: [],
        lookup: {},
        generations: 1,
      },
    });
  }
  return { campaignId: campaign.id, personId: row.id, jobIds };
}

describe("the list's rows", () => {
  it("carry the person's title, company and a LinkedIn link that is a web address", async () => {
    const actor = await ensureUser(prisma, rep());
    const { campaignId } = await personWith(actor, [{ touch: "email1" }], { title: "Head of Claims", company: "Ardent Motor", linkedinUrl: "https://www.linkedin.com/in/someone" });
    const { campaignId: other } = await personWith(actor, [{ touch: "email1" }], { title: "COO", company: "Bramble", linkedinUrl: "javascript:alert(1)" });

    const [row] = (await caller(rep()).tracking.campaignPeopleTracking({ campaignId })).rows;
    expect(row).toMatchObject({ title: "Head of Claims", company: "Ardent Motor", linkedinUrl: "https://www.linkedin.com/in/someone" });
    const [bad] = (await caller(rep()).tracking.campaignPeopleTracking({ campaignId: other })).rows;
    expect(bad).toMatchObject({ company: "Bramble", linkedinUrl: null });
  });

  it("show no link for a web address that is not LinkedIn's (P5c), in the list and the drawer", async () => {
    const actor = await ensureUser(prisma, rep());
    const { campaignId, personId } = await personWith(actor, [{ touch: "email1" }], { linkedinUrl: "https://example.com/in/someone" });
    const [row] = (await caller(rep()).tracking.campaignPeopleTracking({ campaignId })).rows;
    expect(row).toMatchObject({ linkedinUrl: null });
    expect(await caller(rep()).tracking.personTracking({ personId })).toMatchObject({ linkedinUrl: null });
  });
});

describe("an email is marked sent only once it is approved", () => {
  it("refuses Mark sent on an email still to review, with a plain reason, and takes it once approved", async () => {
    const actor = await ensureUser(prisma, rep());
    const { personId } = await personWith(actor, [{ touch: "email1", subject: "Calls behind complaints" }]);
    const api = caller(rep());

    expect(await refusal(api.tracking.markStep({ personId, step: "email1", kind: "sent" }))).toEqual({ code: "BAD_REQUEST", message: outreachTrackingCopy.notApproved });
    expect(await prisma.outreachEvent.count({ where: { campaignPersonId: personId } })).toBe(0);

    const view = await api.tracking.personTracking({ personId });
    await api.drafts.approve({ draftId: view.drafts.email1!.id });
    await expect(api.tracking.markStep({ personId, step: "email1", kind: "sent" })).resolves.toMatchObject({ kind: "sent", step: "email1" });
  });

  it("a LinkedIn note or a call needs no approval to be marked", async () => {
    const actor = await ensureUser(prisma, rep());
    const { personId } = await personWith(actor, [{ touch: "li_connect" }, { touch: "call" }]);
    const api = caller(rep());
    await expect(api.tracking.markStep({ personId, step: "li_connect", kind: "sent" })).resolves.toMatchObject({ step: "li_connect" });
    await expect(api.tracking.markStep({ personId, step: "call1", kind: "done", callResult: "voicemail", note: "Left the short one." })).resolves.toMatchObject({ step: "call1" });
    const view = await api.tracking.personTracking({ personId });
    expect(view.tracking.steps.find((step) => step.id === "call1")).toMatchObject({ state: "done", callResult: "voicemail" });
    expect(view.notes).toEqual([expect.objectContaining({ step: "call1", note: "Left the short one." })]);
  });
});

describe("the Inbox and the drawer agree", () => {
  it("an email approved in the Inbox reads approved in the drawer, and one approved from the drawer leaves the Inbox", async () => {
    const actor = await ensureUser(prisma, rep());
    const { personId } = await personWith(actor, [{ touch: "email1", subject: "Calls" }, { touch: "email2" }]);
    const api = caller(rep());

    const before = await api.tracking.personTracking({ personId });
    expect(before.emailCards.email1).toMatchObject({ kind: "draft", id: before.drafts.email1!.id, ordinal: 1 });
    expect((await api.drafts.queue()).items.map((item) => item.id).sort()).toEqual([before.drafts.email1!.id, before.drafts.email2!.id].sort());

    // Approved in the Inbox.
    await api.drafts.approve({ draftId: before.drafts.email1!.id });
    expect((await api.tracking.personTracking({ personId })).drafts.email1).toMatchObject({ state: "approved" });

    // Approved from the drawer: the same procedure, so the Inbox no longer lists it.
    await api.drafts.approve({ draftId: before.drafts.email2!.id, body: "email2 words, edited." });
    expect((await api.drafts.queue()).items).toEqual([]);
    expect((await api.tracking.personTracking({ personId })).drafts.email2).toMatchObject({ state: "approved", body: "email2 words, edited." });

    // Sent from the drawer: the step is done in the drawer, and nothing about it returns to the Inbox.
    await api.tracking.markStep({ personId, step: "email1", kind: "sent" });
    expect((await api.tracking.personTracking({ personId })).tracking.steps.find((step) => step.id === "email1")).toMatchObject({ state: "done" });
    expect((await api.drafts.queue()).items).toEqual([]);
  });

  it("the drawer shows an approved draft over a later attempt that failed", async () => {
    const actor = await ensureUser(prisma, rep());
    const { personId } = await personWith(actor, [
      { touch: "email1", attempt: 1, state: "approved", body: "The one approved." },
      { touch: "email1", attempt: 2, state: "failed" },
    ]);
    expect((await caller(rep()).tracking.personTracking({ personId })).drafts.email1).toMatchObject({ attempt: 1, state: "approved", body: "The one approved." });
  });
});

describe("Try again", () => {
  it("redrafts a draft that failed: the existing single-draft redraft, and the drawer says it is being written again", async () => {
    const actor = await ensureUser(prisma, rep());
    const { personId } = await personWith(actor, [{ touch: "li_dm", state: "failed" }]);
    const api = caller(rep());
    const draft = (await api.tracking.personTracking({ personId })).drafts.li_dm!;
    expect(draft).toMatchObject({ state: "failed", canTryAgain: true, redrafting: false });

    await expect(api.drafts.reject({ draftId: draft.id, reason: "wrong_angle", requestId: randomUUID() })).resolves.toMatchObject({ redrafting: true });
    const redraft = await prisma.job.findFirstOrThrow({ where: { kind: "outreach_draft", status: "queued" } });
    expect(redraft.input).toMatchObject({ campaignPersonId: personId, attempt: 2, touch: "li_dm" });
    // It stays failed (nothing was written to reject); the drawer says the next one is coming and offers no second press.
    expect((await api.tracking.personTracking({ personId })).drafts.li_dm).toMatchObject({ state: "failed", redrafting: true, canTryAgain: false });

    // A second press is the same queued attempt, and records nothing more (P5c).
    await expect(api.drafts.reject({ draftId: draft.id, reason: "wrong_angle", requestId: randomUUID() })).resolves.toMatchObject({ redrafting: true });
    expect(await prisma.job.count({ where: { kind: "outreach_draft", status: "queued" } })).toBe(1);
    expect(await prisma.event.count({ where: { kind: "draft.rejected" } })).toBe(1);
  });

  it("a failed email leaves the Inbox once another attempt is on its way or written, so one email never has two cards", async () => {
    const actor = await ensureUser(prisma, rep());
    const { campaignId, personId } = await personWith(actor, [{ touch: "email1", state: "failed" }]);
    const api = caller(rep());
    const failed = (await api.tracking.personTracking({ personId })).drafts.email1!;
    expect((await api.drafts.queue()).items.map((item) => item.id)).toEqual([failed.id]);

    await api.drafts.reject({ draftId: failed.id, reason: "wrong_angle", requestId: randomUUID() });
    expect((await api.drafts.queue()).items).toEqual([]);

    // The worker writes attempt 2 and the job is done: the new draft is the one card.
    const job = await prisma.job.findFirstOrThrow({ where: { kind: "outreach_draft", status: "queued" } });
    await prisma.job.update({ where: { id: job.id }, data: { status: "done" } });
    const written = await prisma.outreachDraft.create({
      data: { orgId: actor.orgId, campaignId, briefVersion: 1, campaignPersonId: personId, ownerUserId: actor.userId, jobId: job.id, touch: "email1", attempt: 2, state: "to_review", body: "Second go.", ask: "Worth a call?", opener: { ref: "x", kind: "role_pain" }, findings: [], advice: [], lookup: {}, generations: 1 },
    });
    expect((await api.drafts.queue()).items.map((item) => item.id)).toEqual([written.id]);
  });

  it("a draft that failed on its last attempt is refused, not quietly recorded", async () => {
    const actor = await ensureUser(prisma, rep());
    const { personId } = await personWith(actor, [{ touch: "email1", attempt: 3, state: "failed" }]);
    const api = caller(rep());
    const draft = (await api.tracking.personTracking({ personId })).drafts.email1!;
    expect(await refusal(api.drafts.reject({ draftId: draft.id, reason: "wrong_angle", requestId: randomUUID() }))).toMatchObject({ code: "BAD_REQUEST" });
    expect(await prisma.event.count({ where: { kind: "draft.rejected" } })).toBe(0);
  });

  it("a draft that failed can't be closed with a reason that asks for nothing", async () => {
    const actor = await ensureUser(prisma, rep());
    const { personId } = await personWith(actor, [{ touch: "email1", state: "failed" }]);
    const api = caller(rep());
    const draft = (await api.tracking.personTracking({ personId })).drafts.email1!;
    expect(await refusal(api.drafts.reject({ draftId: draft.id, reason: "not_now", requestId: randomUUID() }))).toMatchObject({ code: "BAD_REQUEST" });
    expect(await prisma.outreachDraft.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({ state: "failed" });
  });

  it("a draft held as Needs you is rejected for another attempt, and the drawer says it is being written again", async () => {
    const actor = await ensureUser(prisma, rep());
    const { personId } = await personWith(actor, [{ touch: "email2", state: "needs_you" }]);
    const api = caller(rep());
    const draft = (await api.tracking.personTracking({ personId })).drafts.email2!;
    expect(draft).toMatchObject({ canTryAgain: true });
    await api.drafts.reject({ draftId: draft.id, reason: "wrong_angle", requestId: randomUUID() });
    expect((await api.tracking.personTracking({ personId })).drafts.email2).toMatchObject({ state: "rejected", redrafting: true, canTryAgain: false });
  });

  it("is not offered on the third attempt", async () => {
    const actor = await ensureUser(prisma, rep());
    const { personId } = await personWith(actor, [{ touch: "call", attempt: 3, state: "needs_you" }]);
    expect((await caller(rep()).tracking.personTracking({ personId })).drafts.call1).toMatchObject({ state: "needs_you", canTryAgain: false });
  });
});

describe("Try again records no reason (P5c)", () => {
  it("on a draft held as Needs you: the next attempt is asked for with no reason and nothing to steer away from", async () => {
    const actor = await ensureUser(prisma, rep());
    const { personId } = await personWith(actor, [{ touch: "email2", state: "needs_you" }]);
    const api = caller(rep());
    const draft = (await api.tracking.personTracking({ personId })).drafts.email2!;

    await expect(api.drafts.retry({ draftId: draft.id, requestId: randomUUID() })).resolves.toMatchObject({ id: draft.id, redrafting: true });
    // The held draft steps aside naming what the rep did, not a reason they never gave, and the drawer says the next one is coming.
    expect(await prisma.outreachDraft.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({ state: "rejected", rejectReason: "try_again", decidedByUserId: actor.userId });
    expect((await api.tracking.personTracking({ personId })).drafts.email2).toMatchObject({ state: "rejected", redrafting: true, canTryAgain: false });
    const job = await prisma.job.findFirstOrThrow({ where: { kind: "outreach_draft", status: "queued" } });
    expect(job.input).toEqual({ requestId: expect.any(String), campaignPersonId: personId, attempt: 2, touch: "email2" });
    // One Event, and it is not a rejection with an invented reason.
    const events = await prisma.event.findMany({ where: { kind: { in: ["draft.retried", "draft.rejected"] } } });
    expect(events.map((event) => [event.kind, event.after])).toEqual([["draft.retried", { draftId: draft.id, campaignPersonId: personId, redraftJobId: job.id }]]);
  });

  it("on a draft that failed: it stays failed, and a second press while that attempt is queued records nothing", async () => {
    const actor = await ensureUser(prisma, rep());
    const { personId } = await personWith(actor, [{ touch: "li_dm", state: "failed" }]);
    const api = caller(rep());
    const draft = (await api.tracking.personTracking({ personId })).drafts.li_dm!;

    await api.drafts.retry({ draftId: draft.id, requestId: randomUUID() });
    await expect(api.drafts.retry({ draftId: draft.id, requestId: randomUUID() })).resolves.toMatchObject({ redrafting: true });
    expect(await prisma.outreachDraft.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({ state: "failed", rejectReason: null });
    expect(await prisma.job.count({ where: { kind: "outreach_draft", status: "queued" } })).toBe(1);
    expect(await prisma.event.count({ where: { kind: "draft.retried" } })).toBe(1);
    expect(await prisma.event.count({ where: { kind: "draft.rejected" } })).toBe(0);
  });

  it("is refused on a draft to review, on the last attempt, and on someone else's draft", async () => {
    const actor = await ensureUser(prisma, rep());
    const { personId } = await personWith(actor, [{ touch: "email1" }, { touch: "li_dm", attempt: 3, state: "failed" }]);
    const api = caller(rep());
    const view = await api.tracking.personTracking({ personId });
    expect(await refusal(api.drafts.retry({ draftId: view.drafts.email1!.id, requestId: randomUUID() }))).toMatchObject({ code: "BAD_REQUEST" });
    expect(await refusal(api.drafts.retry({ draftId: view.drafts.li_dm!.id, requestId: randomUUID() }))).toMatchObject({ code: "BAD_REQUEST" });
    expect(await refusal(caller(stranger()).drafts.retry({ draftId: view.drafts.email1!.id, requestId: randomUUID() }))).toMatchObject({ code: "NOT_FOUND" });
    expect(await prisma.event.count({ where: { kind: "draft.retried" } })).toBe(0);
  });
});

describe("the drawer's draft is the latest usable attempt (P5c)", () => {
  const cases: Array<[string, DraftSpec[], { attempt: number; state: OutreachDraftState }]> = [
    ["to review over a later attempt that failed", [{ touch: "email1", attempt: 1, state: "to_review" }, { touch: "email1", attempt: 2, state: "failed" }], { attempt: 1, state: "to_review" }],
    ["needs you over a later attempt that failed", [{ touch: "email1", attempt: 1, state: "needs_you" }, { touch: "email1", attempt: 2, state: "failed" }], { attempt: 1, state: "needs_you" }],
    ["approved over a later attempt to review", [{ touch: "email1", attempt: 1, state: "approved" }, { touch: "email1", attempt: 2, state: "to_review" }], { attempt: 1, state: "approved" }],
    ["to review over an earlier one that needs you", [{ touch: "email1", attempt: 1, state: "needs_you" }, { touch: "email1", attempt: 2, state: "to_review" }], { attempt: 2, state: "to_review" }],
    ["the later of two to review", [{ touch: "email1", attempt: 1, state: "rejected" }, { touch: "email1", attempt: 2, state: "to_review" }, { touch: "email1", attempt: 3, state: "to_review" }], { attempt: 3, state: "to_review" }],
    ["the latest when none is usable", [{ touch: "email1", attempt: 1, state: "rejected" }, { touch: "email1", attempt: 2, state: "failed" }], { attempt: 2, state: "failed" }],
  ];
  it.each(cases)("%s", async (_name, drafts, expected) => {
    const actor = await ensureUser(prisma, rep());
    const { personId } = await personWith(actor, drafts);
    expect((await caller(rep()).tracking.personTracking({ personId })).drafts.email1).toMatchObject(expected);
  });
});

describe("outcomes", () => {
  it("Not interested closes the person and skips every step not yet done", async () => {
    const actor = await ensureUser(prisma, rep());
    const { personId } = await personWith(actor, [{ touch: "li_connect" }]);
    const api = caller(rep());
    await api.tracking.markStep({ personId, step: "li_connect", kind: "sent" });
    await api.tracking.setOutcome({ personId, outcome: "not_interested" });
    const view = await api.tracking.personTracking({ personId });
    expect(view.status).toBe("closed");
    expect(view.tracking.steps.map((step) => [step.id, step.state])).toEqual([
      ["email1", "skipped"],
      ["li_connect", "done"],
      ["call1", "skipped"],
      ["email2", "skipped"],
      ["li_dm", "skipped"],
      ["call2", "skipped"],
      ["li_dm2", "skipped"],
      ["breakup", "skipped"],
    ]);
    expect(view.nextDue).toBeNull();
  });
});

describe("a LinkedIn or call draft is stored with no subject", () => {
  it("drops a subject the writer gave a LinkedIn note or a call, and keeps an email's", async () => {
    const actor = await ensureUser(prisma, rep());
    const { campaignId, personId } = await personWith(actor, []);
    const job = await prisma.job.create({ data: { orgId: actor.orgId, ownerUserId: actor.userId, kind: "outreach_draft", idempotencyKey: `test:${randomUUID()}`, input: {}, status: "running", campaignId, briefVersion: 1 } });
    const opener = { ref: "x", kind: "role_pain", text: "t", source: "s", date: "2026-09-21" };
    await recordDrafts(prisma, {
      orgId: actor.orgId,
      job: { id: job.id, campaignId, briefVersion: 1, ownerUserId: actor.userId },
      campaignPersonId: personId,
      attempt: 1,
      lookup: { items: [], usable: false, searches: 0, fetches: 0 },
      touches: SEQUENCE.map((touch) => ({ touch, state: "to_review" as const, draft: { subject: "connecting", body: "Worth connecting?", ask: "Worth connecting?", opener, claims: [] }, findings: [], advice: [], generations: 1, costUsd: 0 })),
    });
    const stored = Object.fromEntries((await prisma.outreachDraft.findMany({ where: { campaignPersonId: personId } })).map((draft) => [draft.touch, draft.subject]));
    expect(stored).toEqual({ email1: "connecting", email2: "connecting", breakup: "connecting", li_connect: null, li_dm: null, li_dm2: null, call: null });
    // And the drawer shows no subject on a LinkedIn or call step.
    const drafts = (await caller(rep()).tracking.personTracking({ personId })).drafts;
    expect(Object.fromEntries(Object.entries(drafts).map(([step, draft]) => [step, draft?.subject ?? null]))).toEqual({
      email1: "connecting",
      li_connect: null,
      call1: null,
      email2: "connecting",
      li_dm: null,
      call2: null,
      li_dm2: null,
      breakup: "connecting",
    });
  });

  it("shows no subject on a LinkedIn or call row stored with one before P5 (P5c)", async () => {
    const actor = await ensureUser(prisma, rep());
    const { personId } = await personWith(actor, [
      { touch: "email1", subject: "Calls behind complaints" },
      { touch: "li_connect", subject: "connecting" },
      { touch: "call", subject: "call" },
    ]);
    const drafts = (await caller(rep()).tracking.personTracking({ personId })).drafts;
    expect([drafts.email1?.subject, drafts.li_connect?.subject, drafts.call1?.subject]).toEqual(["Calls behind complaints", null, null]);
  });
});

describe("org and owner scoping on the new reads", () => {
  it("another org's rep and a colleague in the same org get NOT_FOUND on the person, and no draft cards", async () => {
    const actor = await ensureUser(prisma, rep());
    const { campaignId, personId } = await personWith(actor, [{ touch: "email1" }], { title: "Head of Claims", company: "Ardent Motor" });
    const draftId = (await caller(rep()).tracking.personTracking({ personId })).drafts.email1!.id;

    for (const session of [stranger(), colleague()]) {
      const other = await ensureUser(prisma, session);
      expect(await refusal(caller(session).tracking.personTracking({ personId }))).toMatchObject({ code: "NOT_FOUND" });
      expect(await refusal(caller(session).tracking.campaignPeopleTracking({ campaignId }))).toMatchObject({ code: "NOT_FOUND" });
      expect(await draftsForCard(prisma, { orgId: other.orgId, userId: other.userId, ids: [draftId] })).toEqual([]);
      // The rep's own org with a colleague's user id still reads nothing.
      expect(await draftsForCard(prisma, { orgId: actor.orgId, userId: other.userId, ids: [draftId] })).toEqual([]);
      expect(await refusal(caller(session).tracking.markStep({ personId, step: "li_connect", kind: "sent" }))).toMatchObject({ code: "NOT_FOUND" });
    }
  });
});
