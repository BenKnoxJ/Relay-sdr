import { randomUUID } from "node:crypto";

import type { Campaign as CampaignRow, Job, Prisma } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { nextBatch, searchEstimate, type LatestSearch } from "@/lib/campaigns/batches";
import { nameFrom, toResearchBrief } from "@/lib/campaigns/brief";
import { toCampaign } from "@/lib/campaigns/view";
import { prisma } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { NO_CRM } from "@/lib/leadgen/crm";
import { FakeLeadGenProvider, FakeRevealProvider, type FakeStep } from "@/lib/leadgen/fakeProvider";
import type { ProviderCandidate, RevealedContact } from "@/lib/leadgen/provider";
import type { LeadGenSetup } from "@/lib/leadgen/setup";
import { DOCUMENTED_UNVERIFIED_PRICING } from "@/lib/leadgen/spend";
import {
  CampaignChangeRefused,
  confirmCampaign,
  confirmReveal,
  createCampaign,
  findMorePeople,
  findMoreViewFor,
  getCampaignForOwner,
  requestDrafts,
  rerunPeople,
  reviewPeople,
  type ChangeRefusal,
} from "@/lib/repo/campaigns";
import { campaignSummariesForOwner } from "@/lib/repo/campaignSummary";
import { CAMPAIGN_MORE_PEOPLE, LEADGEN_PICKED, LEAD_GEN_JOB, REVEAL_JOB, revealJobKey } from "@/lib/repo/leadgen";
import { mutate } from "@/lib/repo/mutate";
import { OUTREACH_REQUESTED, OUTREACH_DRAFT_JOB } from "@/lib/repo/outreach";
import { startOutreach } from "@/lib/repo/outreachStart";
import { campaignPeopleTracking } from "@/lib/repo/outreachTracking";
import { recordResearchCompleted } from "@/lib/repo/research";
import { leadGenHandler } from "@/worker/handlers/leadGen";
import { revealHandler } from "@/worker/handlers/reveal";
import { appRouter } from "@/server/api/root";
import type { TRPCContext } from "@/server/api/trpc";
import type { Session } from "@/server/auth/session";
import { ensureUser, type Actor } from "@/server/auth/upsertUser";

import { emptyAll, resetDatabase } from "../db/harness";
import { briefFields, completePack } from "../lib/campaignPacks";
import { NO_WAIT, ROLE_TITLES, VOCABULARY, candidate } from "./harness";

/**
 * Find more people (P5b) on the real database, with scripted providers and
 * the lead gen, reveal and start paths run in-process: a second batch leaves
 * out batch 1 and people held in other campaigns; review, Reveal, drafting and
 * start take one batch and leave batch 1's dates alone; the search cap holds;
 * a double click is one batch; and nothing crosses an org.
 */

vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: null }), currentUser: async () => null }));

const ORG = "org_more_a";
const OTHER_ORG = "org_more_b";
const REP = "user_more_a";
const REP_B = "user_more_b";

// A Monday afternoon in London: the next working day is Tue 22 Sep.
const MONDAY = () => new Date("2026-09-21T14:00:00Z");

beforeAll(async () => {
  await resetDatabase();
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await emptyAll();
  for (const id of [ORG, OTHER_ORG]) {
    await mutate(prisma, { orgId: id, actor: { kind: "system" }, kind: "org.created", apply: (tx) => tx.org.create({ data: { id, name: id } }) });
  }
  for (const [orgId, id] of [[ORG, REP], [OTHER_ORG, REP_B]] as const) {
    await mutate(prisma, { orgId, actor: { kind: "system" }, kind: "user.upserted", apply: (tx) => tx.user.create({ data: { id, orgId, email: `${id}@example.test` } }) });
  }
});

function setup(over: Partial<LeadGenSetup> = {}): LeadGenSetup {
  return {
    sample: true,
    searchCreditCap: 40,
    pricingAssumptions: DOCUMENTED_UNVERIFIED_PRICING.id,
    pricing: DOCUMENTED_UNVERIFIED_PRICING,
    readBalance: async () => ({ remaining: 100, readAt: new Date(Date.now() - 60_000), source: "sample" }),
    environment: async () => {
      throw new Error("tests hand the handler its provider");
    },
    revealer: () => {
      throw new Error("tests hand the handler its provider");
    },
    ...over,
  };
}

async function planned(orgId = ORG, userId = orgId === ORG ? REP : REP_B): Promise<CampaignRow> {
  const brief = toResearchBrief(briefFields());
  const pack = completePack();
  const { campaign, job } = await createCampaign(prisma, { orgId, userId, startRequestId: randomUUID(), name: nameFrom(brief.who), brief: brief as Prisma.InputJsonObject });
  if (job === null) throw new Error("tests: a fresh start made no job");
  await recordResearchCompleted(prisma, {
    orgId,
    jobId: job.id,
    runId: "run_test",
    pack: JSON.parse(JSON.stringify(pack)),
    report: {},
    facts: { product: "insights360", version: 2, hash: "test", draft: false },
    knowledge: { product: "insights360", version: 1, hash: "test" },
    partial: pack.partial,
    missingModules: [...pack.missingModules],
    outcome: "complete",
    scope: JSON.parse(JSON.stringify(pack.scope ?? {})),
  });
  await prisma.job.update({ where: { id: job.id }, data: { status: "done" } });
  return campaign;
}

const person = (n: number) => candidate(n, { title: ROLE_TITLES[n % ROLE_TITLES.length] });
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => person(from + index));
const page = (candidates: ProviderCandidate[]): FakeStep => ({ candidates, charged: candidates.length, hasMore: false });

/** Run a lead gen job in-process against a scripted provider, as the worker would. */
async function runLeadGen(job: Job, steps: FakeStep[]) {
  const provider = new FakeLeadGenProvider(steps);
  await leadGenHandler({ environment: () => ({ provider, vocabulary: VOCABULARY }), crm: NO_CRM, retry: NO_WAIT })({ db: prisma, job: { ...job, attempts: 1 }, signal: new AbortController().signal });
  await prisma.job.update({ where: { id: job.id }, data: { status: "done" } });
  return provider;
}

const contact = (providerId: string): RevealedContact => {
  const n = Number(providerId.slice(2));
  return { status: "found", name: `Person ${n}`, domain: `www.firm${n}.co.uk`, emails: [{ address: `person${n}@firm${n}.co.uk`, type: "work", grade: "A+" }] };
};

const owner = (campaign: CampaignRow) => ({ orgId: campaign.orgId, userId: campaign.ownerUserId, campaignId: campaign.id });

async function view(campaign: CampaignRow) {
  const record = await getCampaignForOwner(prisma, { orgId: campaign.orgId, userId: campaign.ownerUserId, id: campaign.id });
  if (record === null) throw new Error("tests: campaign not found");
  return toCampaign(record, { available: true, searchCreditCap: 40, sample: true });
}

/**
 * Keep the first `keep` of the latest batch, reveal them, ask for their drafts, write each Email 1 as the draft job
 * would, and start them on `startOn` (null: never pressed). The last `late` drafts land after the start, as a draft
 * still writing when Start outreach is pressed does.
 */
async function throughOutreach(campaign: CampaignRow, keep: number, startOn: string | null, late = 0): Promise<string[]> {
  const latest = await prisma.job.findFirstOrThrow({ where: { campaignId: campaign.id, kind: LEAD_GEN_JOB }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  const chosen = await prisma.campaignPerson.findMany({ where: { campaignId: campaign.id, jobId: latest.id, status: "chosen" }, orderBy: { rank: "asc" } });
  const kept = chosen.slice(0, keep);
  await reviewPeople(prisma, { ...owner(campaign), briefVersion: 1, personId: kept[0]!.id, scope: "selected", personIds: kept.map((row) => row.id), decision: "kept" });
  const plan = (await view(campaign)).peopleFound?.revealPlan;
  await confirmReveal(prisma, { ...owner(campaign), briefVersion: 1, requestId: randomUUID(), expected: { toReveal: plan!.toReveal, known: plan!.known, maxCredits: plan!.maxCredits }, setup: setup() });
  const reveal = await prisma.job.findFirstOrThrow({ where: { campaignId: campaign.id, kind: REVEAL_JOB, status: "queued" } });
  const provider = new FakeRevealProvider([{ contacts: Object.fromEntries(kept.map((row) => [row.providerId, contact(row.providerId)])), charged: kept.length }]);
  await revealHandler({ revealer: () => provider, crm: NO_CRM, pricing: DOCUMENTED_UNVERIFIED_PRICING, retry: NO_WAIT })({ db: prisma, job: { ...reveal, attempts: 1 }, signal: new AbortController().signal });
  await prisma.job.update({ where: { id: reveal.id }, data: { status: "done" } });
  await requestDrafts(prisma, { ...owner(campaign), briefVersion: 1, requestId: randomUUID() });
  const draftJobs = await prisma.job.findMany({ where: { campaignId: campaign.id, kind: OUTREACH_DRAFT_JOB, status: "queued" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const cut = draftJobs.length - late;
  for (const job of draftJobs.slice(0, cut)) await writeDraft(campaign, job);
  if (startOn !== null) await startOutreach(prisma, { ...owner(campaign), requestId: randomUUID(), startOn, now: MONDAY });
  for (const job of draftJobs.slice(cut)) await writeDraft(campaign, job);
  return kept.map((row) => row.id);
}

/** Write one person's Email 1 as their draft job would. */
async function writeDraft(campaign: CampaignRow, job: Job) {
  const campaignPersonId = (job.input as { campaignPersonId: string }).campaignPersonId;
  await prisma.outreachDraft.create({
    data: { orgId: campaign.orgId, campaignId: campaign.id, briefVersion: 1, campaignPersonId, ownerUserId: campaign.ownerUserId, jobId: job.id, touch: "email1", state: "to_review", findings: [], advice: [], lookup: {}, generations: 1, body: "Hello.", ask: "Worth a call?", opener: { ref: "x", kind: "role_pain" } },
  });
  await prisma.job.update({ where: { id: job.id }, data: { status: "done" } });
}

/** A campaign whose batch 1 (l-001 to l-012 returned, 10 chosen) is found, revealed, drafted and started on Tue 22 Sep. */
async function running(orgId = ORG, userId?: string): Promise<{ campaign: CampaignRow; first: string[] }> {
  const campaign = await planned(orgId, userId);
  await confirmCampaign(prisma, { orgId, userId: campaign.ownerUserId, campaignId: campaign.id, fromBriefVersion: 1, requestId: randomUUID(), setup: setup() });
  const job = await prisma.job.findFirstOrThrow({ where: { campaignId: campaign.id, kind: LEAD_GEN_JOB } });
  await runLeadGen(job, [page(range(1, 12))]);
  const first = await throughOutreach(campaign, 4, "2026-09-22");
  return { campaign, first };
}

const more = (campaign: CampaignRow, over: Partial<Parameters<typeof findMorePeople>[1]> = {}) =>
  findMorePeople(prisma, { ...owner(campaign), briefVersion: 1, requestId: randomUUID(), howMany: 10, newCap: false, setup: setup(), ...over });

async function refusalOf(promise: Promise<unknown>): Promise<ChangeRefusal | "ok"> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (error instanceof CampaignChangeRefused) return error.refusal;
    throw error;
  }
}

const batchJob = (campaignId: string, batch: number) =>
  prisma.job.findFirstOrThrow({ where: { campaignId, kind: LEAD_GEN_JOB, input: { path: ["batch"], equals: batch } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });

const startDays = async (ids: string[]) =>
  (await prisma.campaignPerson.findMany({ where: { id: { in: ids } }, select: { outreachStartOn: true }, orderBy: { rank: "asc" } })).map((row) => row.outreachStartOn?.toISOString().slice(0, 10) ?? null);

describe("Find more people: the second batch", () => {
  it("leaves out everyone already in the campaign and anyone held in another, and arrives as batch 2", async () => {
    const { campaign } = await running();
    // Another campaign in the org keeps l-201: held here.
    const other = await planned();
    await confirmCampaign(prisma, { ...owner(other), fromBriefVersion: 1, requestId: randomUUID(), setup: setup() });
    await runLeadGen(await prisma.job.findFirstOrThrow({ where: { campaignId: other.id, kind: LEAD_GEN_JOB } }), [page([person(201), ...range(301, 309)])]);
    const kept = await prisma.campaignPerson.findFirstOrThrow({ where: { campaignId: other.id, providerId: "l-201" } });
    await reviewPeople(prisma, { ...owner(other), briefVersion: 1, personId: kept.id, scope: "person", decision: "kept" });

    const before = await prisma.campaignPerson.findMany({ where: { campaignId: campaign.id }, orderBy: { id: "asc" } });
    expect(before.every((row) => row.batch === 1)).toBe(true);

    const result = await more(campaign);
    expect(result.repeated).toBe(false);
    const job = await batchJob(campaign.id, 2);
    expect(job.input).toMatchObject({ run: 2, batch: 2, howMany: 10 });
    expect((await view(campaign)).state).toBe("findingPeople");

    // The search returns batch 1's chosen and spare people again, the person held elsewhere, and new people.
    await runLeadGen(job, [page([...range(1, 12), person(201), ...range(101, 112)])]);

    const second = await prisma.campaignPerson.findMany({ where: { campaignId: campaign.id, jobId: job.id } });
    expect(second.length).toBeGreaterThan(0);
    expect(second.every((row) => row.batch === 2)).toBe(true);
    expect(second.map((row) => row.providerId).every((id) => Number(id.slice(2)) >= 101 && Number(id.slice(2)) <= 112)).toBe(true);
    expect(second.filter((row) => row.status === "chosen")).toHaveLength(10);
    const picked = await prisma.event.findFirstOrThrow({ where: { kind: LEADGEN_PICKED, after: { path: ["jobId"], equals: job.id } } });
    const holds = (picked.after as { output: { holdsApplied: { reason: string; count: number }[] } }).output.holdsApplied;
    expect(holds).toEqual(expect.arrayContaining([{ reason: "duplicate_in_campaign", count: 12 }, { reason: "in_other_campaign", count: 1 }]));

    // Batch 1 is untouched.
    const after = await prisma.campaignPerson.findMany({ where: { id: { in: before.map((row) => row.id) } }, orderBy: { id: "asc" } });
    expect(after).toEqual(before);

    const drawn = await view(campaign);
    expect(drawn.state).toBe("peopleFound");
    expect(drawn.batch).toBe(2);
    expect(drawn.peopleFound?.found.n).toBe(10);
    expect(drawn.peopleFound?.review).toMatchObject({ pending: 10, kept: 0 });
  });

  it("reveals, drafts and starts batch 2 on its own, and batch 1's dates stay where they were", async () => {
    const { campaign, first } = await running();
    await more(campaign);
    await runLeadGen(await batchJob(campaign.id, 2), [page(range(101, 112))]);

    const second = await throughOutreach(campaign, 3, "2026-09-29");

    const reveals = await prisma.job.findMany({ where: { campaignId: campaign.id, kind: REVEAL_JOB }, orderBy: { createdAt: "asc" } });
    expect(reveals.map((job) => job.idempotencyKey)).toEqual([revealJobKey(campaign.id, 1), revealJobKey(campaign.id, 1, 2)]);
    const requested = await prisma.event.findMany({ where: { campaignId: campaign.id, kind: OUTREACH_REQUESTED }, orderBy: { at: "asc" } });
    expect(requested.map((event) => (event.after as { people: string[] }).people)).toEqual([first, second]);

    expect(await startDays(first)).toEqual(["2026-09-22", "2026-09-22", "2026-09-22", "2026-09-22"]);
    expect(await startDays(second)).toEqual(["2026-09-29", "2026-09-29", "2026-09-29"]);

    const people = await campaignPeopleTracking(prisma, { orgId: ORG, userId: REP, campaignId: campaign.id, today: "2026-09-21" });
    expect(people?.rows.map((row) => [row.batch, row.startOn])).toEqual([
      ...first.map(() => [1, "2026-09-22"]),
      ...second.map(() => [2, "2026-09-29"]),
    ]);

    // With batch 2 started, a batch 3 is on offer, and a fresh press makes it.
    expect((await findMoreViewFor(prisma, { orgId: ORG, userId: REP, campaignId: campaign.id }, setup()))?.batch).toBe(3);
    expect((await more(campaign)).repeated).toBe(false);
    expect((await batchJob(campaign.id, 3)).input).toMatchObject({ run: 3, batch: 3 });
  });

  it("is not offered until the latest batch is started", async () => {
    const campaign = await planned();
    await confirmCampaign(prisma, { ...owner(campaign), fromBriefVersion: 1, requestId: randomUUID(), setup: setup() });
    await runLeadGen(await prisma.job.findFirstOrThrow({ where: { campaignId: campaign.id, kind: LEAD_GEN_JOB } }), [page(range(1, 12))]);
    // Revealed and written for, but Start outreach never pressed: batch 1 is still the rep's to finish.
    await throughOutreach(campaign, 4, null);
    expect(await findMoreViewFor(prisma, { orgId: ORG, userId: REP, campaignId: campaign.id }, setup())).toBeNull();
    expect(await refusalOf(more(campaign))).toBe("wrong_state");
    await startOutreach(prisma, { ...owner(campaign), requestId: randomUUID(), startOn: "2026-09-22", now: MONDAY });
    expect((await findMoreViewFor(prisma, { orgId: ORG, userId: REP, campaignId: campaign.id }, setup()))?.batch).toBe(2);
  });

  it("is not offered until the latest batch is revealed and written for", async () => {
    const { campaign } = await running();
    await more(campaign);
    const job = await batchJob(campaign.id, 2);
    // In flight: nothing more, from this tab or another.
    expect(await refusalOf(more(campaign))).toBe("wrong_state");
    await runLeadGen(job, [page(range(101, 112))]);
    // Found but not revealed: batch 2 is still the rep's to finish.
    expect(await findMoreViewFor(prisma, { orgId: ORG, userId: REP, campaignId: campaign.id }, setup())).toBeNull();
    expect(await refusalOf(more(campaign))).toBe("wrong_state");
  });

  it("a later batch's Try again stays that batch, for the same number", async () => {
    const { campaign } = await running();
    await more(campaign, { howMany: 20 });
    // Never sent, so nothing is held against the cap, and the halt is one Try again can answer.
    await runLeadGen(await batchJob(campaign.id, 2), [{ error: "not_sent" }, { error: "not_sent" }, { error: "not_sent" }]);
    await rerunPeople(prisma, { ...owner(campaign), briefVersion: 1, requestId: randomUUID() });
    const latest = await prisma.job.findFirstOrThrow({ where: { campaignId: campaign.id, kind: LEAD_GEN_JOB }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    expect(latest.input).toMatchObject({ run: 3, batch: 2, howMany: 20 });
  });
});

describe("Find more people: the search cap", () => {
  it("spends what is left of the approved cap, and asks for a new one when the estimate is more", async () => {
    const { campaign } = await running();
    // Batch 1 charged 12 credits of the 40 for 10 people chosen.
    const drawn = await findMoreViewFor(prisma, { orgId: ORG, userId: REP, campaignId: campaign.id }, setup());
    expect(drawn).toEqual({
      batch: 2,
      cap: 40,
      remaining: 28,
      newCap: 40,
      options: [
        { howMany: 10, estimate: 12, needsNewCap: false },
        { howMany: 20, estimate: 24, needsNewCap: false },
        { howMany: 30, estimate: 36, needsNewCap: true },
      ],
      sample: true,
    });

    // 30 without approving a new cap is refused; a page that asked for one when none is needed is too.
    expect(await refusalOf(more(campaign, { howMany: 30 }))).toBe("cap_used");
    expect(await refusalOf(more(campaign, { howMany: 10, newCap: true }))).toBe("estimate_changed");
    // A new cap above the balance is refused, as at Confirm.
    expect(await refusalOf(more(campaign, { howMany: 30, newCap: true, setup: setup({ readBalance: async () => ({ remaining: 20, readAt: new Date(), source: "sample" }) }) }))).toBe("over_cap");
    expect(await prisma.job.count({ where: { campaignId: campaign.id, kind: LEAD_GEN_JOB } })).toBe(1);

    const requestId = randomUUID();
    // The new limit is the configured one (60 here), against a balance read on the press.
    await more(campaign, { howMany: 30, newCap: true, requestId, setup: setup({ searchCreditCap: 60 }) });
    const press = await prisma.event.findFirstOrThrow({ where: { kind: CAMPAIGN_MORE_PEOPLE } });
    expect(press.after).toMatchObject({ batch: 2, howMany: 30, capRequestId: requestId, cap: { searchCreditCap: 60, balanceSnapshot: { remaining: 100 }, balanceSource: "sample" } });
    const job = await batchJob(campaign.id, 2);
    expect(job.input).toMatchObject({ batch: 2, howMany: 30, capRequestId: requestId });

    // The batch's search counts against the new approval, not the Confirm's.
    await runLeadGen(job, [page(range(101, 130))]);
    const entries = await prisma.creditLedgerEntry.findMany({ where: { jobId: job.id } });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry.confirmEventId === press.id && entry.kind === "search")).toBe(true);
    expect(await prisma.campaignPerson.count({ where: { jobId: job.id, status: "chosen" } })).toBe(30);
    // The page reads the batch's spend against the limit it was approved with.
    expect((await view(campaign)).peopleFound?.spend).toEqual({ charged: 30, reserved: 0, cap: 60 });
    // The campaign's search spend, on the page and in the list alike, reads against the limit spent against now: the
    // new 60 and the 30 charged under it, not 40 + 60 with batch 1's 12 as well.
    expect((await view(campaign)).spend?.search).toMatchObject({ cap: 60, charged: 30 });
    const [row] = await campaignSummariesForOwner(prisma, { orgId: ORG, userId: REP }, { leadGenAvailable: true });
    expect(row?.input.spend.search).toMatchObject({ cap: 60, charged: 30 });
  });

  it("stops a batch at what is left of the cap, never past it", async () => {
    const { campaign } = await running();
    await more(campaign, { howMany: 20 });
    // Two requests of 20 would need 40 in the worst case; 28 is left, so the second is never sent.
    const provider = await runLeadGen(await batchJob(campaign.id, 2), [{ candidates: range(101, 110), charged: 10, hasMore: true }, { candidates: range(111, 130), charged: 20, hasMore: false }]);
    expect(provider.calls).toHaveLength(1);
    const spent = await prisma.creditLedgerEntry.findMany({ where: { campaignId: campaign.id, kind: "search" } });
    expect(spent.reduce((total, entry) => total + (entry.charged ?? 0), 0)).toBeLessThanOrEqual(40);
  });
});

describe("Find more people: presses", () => {
  it("is idempotent under a double click: one batch, one job, one Event", async () => {
    const { campaign } = await running();
    const requestId = randomUUID();
    const [one, two] = await Promise.all([more(campaign, { requestId }), more(campaign, { requestId })]);
    expect([one, two].filter((result) => result.repeated)).toHaveLength(1);
    expect(await prisma.job.count({ where: { campaignId: campaign.id, kind: LEAD_GEN_JOB } })).toBe(2);
    expect(await prisma.event.count({ where: { campaignId: campaign.id, kind: CAMPAIGN_MORE_PEOPLE } })).toBe(1);
    // The same request id for a different number is not the same press.
    expect(await refusalOf(more(campaign, { requestId, howMany: 20 }))).toBe("request_reused");
  });

  it("stays in the org and with the owner", async () => {
    const { campaign } = await running();
    expect(await refusalOf(more(campaign, { orgId: OTHER_ORG, userId: REP_B }))).toBe("not_found");
    expect(await findMoreViewFor(prisma, { orgId: OTHER_ORG, userId: REP_B, campaignId: campaign.id }, setup())).toBeNull();

    // Another org keeping l-150 holds nobody here.
    const theirs = await planned(OTHER_ORG);
    await confirmCampaign(prisma, { ...owner(theirs), fromBriefVersion: 1, requestId: randomUUID(), setup: setup() });
    await runLeadGen(await prisma.job.findFirstOrThrow({ where: { campaignId: theirs.id, kind: LEAD_GEN_JOB } }), [page([person(150), ...range(401, 409)])]);
    const kept = await prisma.campaignPerson.findFirstOrThrow({ where: { campaignId: theirs.id, providerId: "l-150" } });
    await reviewPeople(prisma, { ...owner(theirs), briefVersion: 1, personId: kept.id, scope: "person", decision: "kept" });

    await more(campaign);
    await runLeadGen(await batchJob(campaign.id, 2), [page(range(145, 156))]);
    expect(await prisma.campaignPerson.count({ where: { campaignId: campaign.id, providerId: "l-150", batch: 2 } })).toBe(1);
  });

  it("is refused where finding people is not set up", async () => {
    const { campaign } = await running();
    expect(await refusalOf(more(campaign, { setup: null }))).toBe("not_available");
    expect(await findMoreViewFor(prisma, { orgId: ORG, userId: REP, campaignId: campaign.id }, null)).toBeNull();
  });
});

describe("the batch column", () => {
  it("is additive: a row written without one is batch 1, and a batch below 1 is refused", async () => {
    const { campaign } = await running();
    expect(await prisma.campaignPerson.count({ where: { campaignId: campaign.id, batch: { not: 1 } } })).toBe(0);
    const column = await prisma.$queryRaw<Array<{ column_default: string; is_nullable: string }>>`
      SELECT column_default, is_nullable FROM information_schema.columns WHERE table_name = 'campaign_people' AND column_name = 'batch'
    `;
    expect(column).toEqual([{ column_default: "1", is_nullable: "NO" }]);
    const row = await prisma.campaignPerson.findFirstOrThrow({ where: { campaignId: campaign.id } });
    await expect(prisma.$executeRaw`UPDATE campaign_people SET batch = 0 WHERE id = ${row.id}`).rejects.toThrow(/campaign_people_batch_positive/);
  });
});

describe("the batch rules", () => {
  const latest = (over: Partial<LatestSearch> = {}): LatestSearch => ({ batch: 1, inFlight: false, picked: true, revealed: true, outreachRequested: true, started: true, writable: 3, ...over });

  it("offers the next batch only once the latest is revealed, written for and started", () => {
    expect(nextBatch(null)).toBeNull();
    expect(nextBatch(latest())).toBe(2);
    expect(nextBatch(latest({ inFlight: true }))).toBeNull();
    expect(nextBatch(latest({ revealed: false, outreachRequested: false }))).toBeNull();
    expect(nextBatch(latest({ outreachRequested: false, started: false }))).toBeNull();
    // Written for but never started: batch 1 would be stranded behind batch 2. Once pressed, writable reads 0.
    expect(nextBatch(latest({ started: false }))).toBeNull();
    expect(nextBatch(latest({ started: false, writable: 0 }))).toBeNull();
    // Nobody to write for is finished with too.
    expect(nextBatch(latest({ outreachRequested: false, started: false, writable: 0 }))).toBe(2);
    // A later batch that found nobody is asked for again under its own number; batch 1's is Needs you.
    expect(nextBatch(latest({ batch: 2, picked: false, revealed: false, outreachRequested: false }))).toBe(2);
    expect(nextBatch(latest({ batch: 1, picked: false, revealed: false, outreachRequested: false }))).toBeNull();
  });

  it("estimates from what the campaign has used per person, never below one request's worst case", () => {
    expect(searchEstimate(10, { credits: 0, people: 0 }, DOCUMENTED_UNVERIFIED_PRICING)).toBe(10);
    expect(searchEstimate(20, { credits: 12, people: 10 }, DOCUMENTED_UNVERIFIED_PRICING)).toBe(24);
    expect(searchEstimate(20, { credits: 2, people: 10 }, DOCUMENTED_UNVERIFIED_PRICING)).toBe(20);
  });
});

describe("the campaign page while a later batch is under way", () => {
  const session: Session = { clerkId: "user_more_page", profile: async () => ({ email: "sam@more-page.test", name: "Sam Carter" }) };
  afterEach(() => {
    delete process.env.RELAY_LEADGEN_PROVIDER;
    resetEnv();
  });
  const get = (id: string) => {
    let pending: Promise<Actor> | undefined;
    const ctx: TRPCContext = { prisma, headers: new Headers(), session, actor: () => (pending ??= ensureUser(prisma, session)) };
    return appRouter.createCaller(ctx).campaigns.get({ id });
  };

  it("never strands batch 1: a draft that lands after Start outreach can still be started while batch 2 is in review", async () => {
    process.env.RELAY_LEADGEN_PROVIDER = "sample";
    resetEnv();
    const actor = await ensureUser(prisma, session);
    const campaign = await planned(actor.orgId, actor.userId);
    await confirmCampaign(prisma, { ...owner(campaign), fromBriefVersion: 1, requestId: randomUUID(), setup: setup() });
    await runLeadGen(await prisma.job.findFirstOrThrow({ where: { campaignId: campaign.id, kind: LEAD_GEN_JOB } }), [page(range(1, 12))]);
    // Start outreach pressed while one of batch 1's four drafts was still writing: three start, one lands after.
    const first = await throughOutreach(campaign, 4, "2026-09-22", 1);
    await more(campaign);
    await runLeadGen(await batchJob(campaign.id, 2), [page(range(101, 112))]);

    const reviewing = await get(campaign.id);
    expect(reviewing.state).toBe("peopleFound");
    expect(reviewing.batch).toBe(2);
    // Batch 1's late person is waiting to start, and the People tab has everyone drafted.
    expect(reviewing.outreach).toMatchObject({ startable: 1, drafted: 4, batches: [{ startOn: "2026-09-22", people: 3 }] });

    // Start outreach takes them, and batch 2's people, not yet drafted, are left alone.
    const started = await startOutreach(prisma, { ...owner(campaign), requestId: randomUUID(), startOn: "2026-09-23", now: MONDAY });
    expect(started.people).toBe(1);
    expect((await startDays(first)).filter((day) => day === null)).toHaveLength(0);
    expect(await prisma.campaignPerson.count({ where: { jobId: (await batchJob(campaign.id, 2)).id, outreachStartOn: { not: null } } })).toBe(0);
  });

  it("keeps batch 1's outreach (its days and Pause) and offers more once a batch has nobody to write for", async () => {
    // Sample lead gen, as a development server runs it: the page's Find more reads the configured setup.
    process.env.RELAY_LEADGEN_PROVIDER = "sample";
    resetEnv();
    const actor = await ensureUser(prisma, session);
    const { campaign } = await running(actor.orgId, actor.userId);
    await more(campaign);
    await runLeadGen(await batchJob(campaign.id, 2), [page(range(101, 112))]);

    const reviewing = await get(campaign.id);
    expect(reviewing.state).toBe("peopleFound");
    expect(reviewing.batch).toBe(2);
    expect(reviewing.outreach?.batches).toEqual([{ startOn: "2026-09-22", people: 4 }]);
    expect(reviewing.findMore).toBeNull();

    // Batch 2's kept people have no email to reveal: nobody to write for, so the next batch is on offer.
    const job = await batchJob(campaign.id, 2);
    const chosen = await prisma.campaignPerson.findMany({ where: { jobId: job.id, status: "chosen" }, orderBy: { rank: "asc" } });
    await reviewPeople(prisma, { ...owner(campaign), briefVersion: 1, personId: chosen[0]!.id, scope: "person", decision: "kept" });
    const plan = (await view(campaign)).peopleFound?.revealPlan;
    await confirmReveal(prisma, { ...owner(campaign), briefVersion: 1, requestId: randomUUID(), expected: { toReveal: plan!.toReveal, known: plan!.known, maxCredits: plan!.maxCredits }, setup: setup() });
    const reveal = await prisma.job.findFirstOrThrow({ where: { campaignId: campaign.id, kind: REVEAL_JOB, status: "queued" } });
    const provider = new FakeRevealProvider([{ contacts: { [chosen[0]!.providerId]: { status: "found", name: "Person", domain: "www.firm.co.uk", emails: [] } }, charged: 0 }]);
    await revealHandler({ revealer: () => provider, crm: NO_CRM, pricing: DOCUMENTED_UNVERIFIED_PRICING, retry: NO_WAIT })({ db: prisma, job: { ...reveal, attempts: 1 }, signal: new AbortController().signal });
    await prisma.job.update({ where: { id: reveal.id }, data: { status: "done" } });

    const ready = await get(campaign.id);
    expect(ready.state).toBe("peopleReady");
    expect(ready.outreach?.batches).toEqual([{ startOn: "2026-09-22", people: 4 }]);
    expect(ready.findMore?.batch).toBe(3);
  });
});

