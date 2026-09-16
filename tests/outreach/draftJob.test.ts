import { randomUUID } from "node:crypto";

import type { Campaign as CampaignRow, Job, Prisma } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { OutreachInput } from "../../agents/outreach/input.schema";
import { stubModel } from "@/lib/agents/stubModel";
import { nameFrom, toResearchBrief } from "@/lib/campaigns/brief";
import { toCampaign } from "@/lib/campaigns/view";
import { prisma } from "@/lib/db";
import { NO_CRM } from "@/lib/leadgen/crm";
import { FakeLeadGenProvider, FakeRevealProvider } from "@/lib/leadgen/fakeProvider";
import type { ProviderCandidate, RevealedContact } from "@/lib/leadgen/provider";
import type { LeadGenSetup } from "@/lib/leadgen/setup";
import { DOCUMENTED_UNVERIFIED_PRICING } from "@/lib/leadgen/spend";
import { confirmCampaign, confirmReveal, createCampaign, getCampaignForOwner, reviewPeople } from "@/lib/repo/campaigns";
import { LEAD_GEN_JOB, REVEAL_JOB } from "@/lib/repo/leadgen";
import { OUTREACH_DRAFT_JOB, OUTREACH_LOOKUP, recordDraft, saveVoice } from "@/lib/repo/outreach";
import { recordResearchCompleted } from "@/lib/repo/research";
import type { FetchService, SearchService } from "@/lib/services";
import { leadGenHandler } from "@/worker/handlers/leadGen";
import { outreachDraftHandler } from "@/worker/handlers/outreachDraft";
import { revealHandler } from "@/worker/handlers/reveal";
import { TerminalError } from "@/worker/errors";
import { appRouter } from "@/server/api/root";
import type { TRPCContext } from "@/server/api/trpc";
import type { Session } from "@/server/auth/session";
import { ensureUser, type Actor } from "@/server/auth/upsertUser";

import { emptyAll, resetDatabase } from "../db/harness";
import { briefFields, completePack } from "../lib/campaignPacks";
import { NO_WAIT, ROLE_TITLES, VOCABULARY, candidate } from "../leadgen/harness";

/**
 * Email 1 (outreach v2.1 §M) on the real database, with a scripted model and
 * scripted search: Write emails makes one job per kept person with a usable
 * email; each job looks up once, writes at most twice, gates, and records one
 * draft; the rep approves (Ready to send) or rejects it. Nothing is sent, and
 * no model, search or provider is called.
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

// ---------------------------------------------------------------------------
// Sessions, as the campaigns router test signs people in.

function contextFor(session: Session): TRPCContext {
  let pending: Promise<Actor> | undefined;
  return { prisma, headers: new Headers(), session, actor: () => (pending ??= ensureUser(prisma, session)) };
}
const sessionOf = (clerkId: string, email: string): Session => ({ clerkId, profile: async () => ({ email, name: "Sam Carter" }) });
const rep = () => sessionOf("user_rep", "rep@example.test");
const stranger = () => sessionOf("user_stranger", "stranger@other.test");
const caller = (session: Session) => appRouter.createCaller(contextFor(session));

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (error instanceof TRPCError) return error.code;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// A campaign whose kept people have been revealed.

function setup(): LeadGenSetup {
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
  };
}

const contact = (n: number): RevealedContact => ({ status: "found", name: `Person ${n}`, domain: `www.firm${n}.co.uk`, emails: [{ address: `person${n}@firm${n}.co.uk`, type: "work", grade: "A+" }] });

async function revealed(session: Session = rep(), keep = 3): Promise<{ actor: Actor; campaign: CampaignRow }> {
  const actor = await ensureUser(prisma, session);
  const brief = toResearchBrief(briefFields());
  const pack = completePack();
  const { campaign, job } = await createCampaign(prisma, { orgId: actor.orgId, userId: actor.userId, startRequestId: randomUUID(), name: nameFrom(brief.who), brief: brief as Prisma.InputJsonObject });
  if (job === null) throw new Error("tests: a fresh start made no job");
  await recordResearchCompleted(prisma, {
    orgId: actor.orgId,
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

  await confirmCampaign(prisma, { orgId: actor.orgId, userId: actor.userId, campaignId: campaign.id, fromBriefVersion: 1, requestId: randomUUID(), setup: setup() });
  const leadGen = await prisma.job.findFirstOrThrow({ where: { campaignId: campaign.id, kind: LEAD_GEN_JOB } });
  const people: ProviderCandidate[] = Array.from({ length: 6 }, (_, index) => candidate(index + 1, { title: ROLE_TITLES[(index + 1) % ROLE_TITLES.length] }));
  const provider = new FakeLeadGenProvider([{ candidates: people, charged: people.length, hasMore: false }]);
  await leadGenHandler({ environment: () => ({ provider, vocabulary: VOCABULARY }), crm: NO_CRM, retry: NO_WAIT })({ db: prisma, job: { ...leadGen, attempts: 1 }, signal: new AbortController().signal });

  const chosen = await prisma.campaignPerson.findMany({ where: { campaignId: campaign.id, status: "chosen" }, orderBy: { rank: "asc" } });
  for (const row of chosen.slice(0, keep)) {
    await reviewPeople(prisma, { orgId: actor.orgId, userId: actor.userId, campaignId: campaign.id, briefVersion: 1, personId: row.id, scope: "person", decision: "kept" });
  }
  const plan = (await view(actor, campaign)).peopleFound?.revealPlan;
  await confirmReveal(prisma, {
    orgId: actor.orgId,
    userId: actor.userId,
    campaignId: campaign.id,
    briefVersion: 1,
    requestId: randomUUID(),
    expected: { toReveal: plan?.toReveal ?? 0, known: plan?.known ?? 0, maxCredits: plan?.maxCredits ?? 0 },
    setup: setup(),
  });
  const revealJob = await prisma.job.findFirstOrThrow({ where: { campaignId: campaign.id, kind: REVEAL_JOB } });
  const contacts = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`l-${String(index + 1).padStart(3, "0")}`, contact(index + 1)]));
  await revealHandler({ revealer: () => new FakeRevealProvider([{ contacts, charged: keep }]), crm: NO_CRM, pricing: DOCUMENTED_UNVERIFIED_PRICING, retry: NO_WAIT })({
    db: prisma,
    job: { ...revealJob, attempts: 1 },
    signal: new AbortController().signal,
  });
  return { actor, campaign };
}

async function view(actor: Actor, campaign: CampaignRow) {
  const record = await getCampaignForOwner(prisma, { orgId: actor.orgId, userId: actor.userId, id: campaign.id });
  if (record === null) throw new Error("tests: campaign not found");
  return toCampaign(record, { available: true, searchCreditCap: 40, sample: true });
}

const writeEmails = (session: Session, campaign: CampaignRow, requestId: string = randomUUID()) => caller(session).campaigns.writeEmails({ campaignId: campaign.id, briefVersion: 1, requestId });

const draftJobs = (campaign: CampaignRow) => prisma.job.findMany({ where: { campaignId: campaign.id, kind: OUTREACH_DRAFT_JOB }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });

// ---------------------------------------------------------------------------
// The scripted writer and the scripted lookup.

/** Four different good first emails on the role problem, one per firm, so no two share an opening or an ask. */
const GOOD: { body: string; ask: string }[] = [
  {
    body: `When quality checking covers a small sample of calls, the habit behind a complaint is usually found weeks after it started.\n\nMost claims teams only hear about it once the letter arrives. Reading every call shows the pattern in the first week instead. Is finding those calls earlier something you are working on?`,
    ask: "Is finding those calls earlier something you are working on?",
  },
  {
    body: `Complaints tend to arrive long after the call that caused them.\n\nMeanwhile the same habit repeats quietly on dozens of other calls across the team. Reading all of them would show which conversations to coach first. Would that be useful for your team?`,
    ask: "Would that be useful for your team?",
  },
  {
    body: `The part of a complaint nobody can see is the conversation that started it.\n\nMost sampling catches it too late to matter. We read every recorded call and point to the ones behind each complaint. Is that a gap your team feels at the moment?`,
    ask: "Is that a gap your team feels at the moment?",
  },
  {
    body: `Which calls sit behind this quarter's complaints is usually a guess.\n\nA sample of one in fifty leaves most of them unheard. We read every recorded call, so the answer comes from the calls themselves. Would it help to see how that works for a claims team?`,
    ask: "Would it help to see how that works for a claims team?",
  },
];

type Answer = "good" | "time-ask" | "garbage";

function answerFor(input: OutreachInput, kind: Answer): string {
  if (kind === "garbage") return "Here is the email you asked for.";
  const firm = Number(input.person.company.match(/\d+/)?.[0] ?? 0);
  const good = GOOD[firm % GOOD.length]!;
  const draft = kind === "good" ? good : { body: good.body.replace(good.ask, "Could we find twenty minutes next week?"), ask: "Could we find twenty minutes next week?" };
  const ref = input.buyerRole?.id ?? input.pack.archetype.pains[0]!.id;
  return JSON.stringify({ kind: "message", subject: "Complaints and the calls behind them", ...draft, opener: { ref, kind: "role_pain" }, claims: [] });
}

function writer(script: Answer[]) {
  const inputs: OutreachInput[] = [];
  return {
    inputs,
    makeModel: (id: "claude-sonnet-5" | string, input: OutreachInput) => {
      const kind = script[inputs.length] ?? "good";
      inputs.push(input);
      return { transport: "stub" as const, model: stubModel({ modelId: id, calls: [{ text: answerFor(input, kind), usage: { in: 6000, out: 350, cacheRead: 0, cacheWrite: 0, reasoning: 0 } }], whenExhausted: "throw" }) };
    },
  };
}

function nothingFound() {
  const calls = { searches: 0, fetches: 0 };
  const search: SearchService = {
    search: async () => {
      calls.searches += 1;
      return { hits: [] };
    },
    extract: async () => ({ unreadable: true, reason: "not scripted" }),
  };
  const fetch: FetchService = {
    scrape: async () => {
      calls.fetches += 1;
      return { unreadable: true, reason: "not scripted" };
    },
  };
  return { calls, search, fetch };
}

async function runDraft(job: Job, script: Answer[] = ["good"]) {
  const model = writer(script);
  const lookup = nothingFound();
  // The handler's makeModel names a priced model; the scripted one accepts any.
  const result = await outreachDraftHandler({ makeModel: model.makeModel as never, search: lookup.search, fetch: lookup.fetch, now: () => new Date("2026-09-15T09:00:00Z") })({
    db: prisma,
    job: { ...job, attempts: 1 },
    signal: new AbortController().signal,
  });
  return { result, model, lookup };
}

/** A job whose model or search throws something that is not a failed agent run, on the given attempt of three. */
function runBroken(job: Job, attempt: number, where: "model" | "search" | "terminal") {
  const lookup = nothingFound();
  const search: SearchService = where === "search" ? { ...lookup.search, search: async () => Promise.reject(new Error("search is down")) } : lookup.search;
  const makeModel = () => {
    if (where === "terminal") throw new TerminalError("outreach: no scripted draft for this person");
    throw new Error("socket hang up");
  };
  return outreachDraftHandler({ makeModel: makeModel as never, search, fetch: lookup.fetch, now: () => new Date("2026-09-15T09:00:00Z") })({
    db: prisma,
    job: { ...job, attempts: attempt, maxAttempts: 3 },
    signal: new AbortController().signal,
  });
}

// ---------------------------------------------------------------------------

describe("Write emails", () => {
  it("@proof makes one draft job per kept person with a usable email, once per version", async () => {
    const { campaign } = await revealed(rep(), 3);
    const requestId = randomUUID();
    expect(await writeEmails(rep(), campaign, requestId)).toEqual({ id: campaign.id });
    const jobs = await draftJobs(campaign);
    expect(jobs).toHaveLength(3);
    expect(jobs.map((job) => (job.input as { attempt: number }).attempt)).toEqual([1, 1, 1]);
    expect(new Set(jobs.map((job) => (job.input as { campaignPersonId: string }).campaignPersonId)).size).toBe(3);

    // The same press again is the same press; a second, different press is refused.
    expect(await writeEmails(rep(), campaign, requestId)).toEqual({ id: campaign.id });
    expect(await codeOf(writeEmails(rep(), campaign))).toBe("CONFLICT");
    expect(await draftJobs(campaign)).toHaveLength(3);
  });

  it("@proof answers another org as if the campaign were not there", async () => {
    const { campaign } = await revealed(rep(), 2);
    await ensureUser(prisma, stranger());
    expect(await codeOf(writeEmails(stranger(), campaign))).toBe("NOT_FOUND");
    expect(await draftJobs(campaign)).toHaveLength(0);
  });

  it("shows the campaign as writing, then counts the drafts", async () => {
    const { actor, campaign } = await revealed(rep(), 2);
    await writeEmails(rep(), campaign);
    const writing = await view(actor, campaign);
    expect(writing.state).toBe("drafting");
    expect(writing.peopleFound?.drafts).toMatchObject({ writing: 2 });

    const [first] = await draftJobs(campaign);
    await runDraft(first!);
    await prisma.job.update({ where: { id: first!.id }, data: { status: "done" } });
    expect((await view(actor, campaign)).peopleFound?.drafts).toMatchObject({ writing: 1, to_review: 1 });
  });
});

describe("the draft job", () => {
  it("@proof looks up, writes once, passes the gates and records a draft to review", async () => {
    const { actor, campaign } = await revealed(rep(), 1);
    await writeEmails(rep(), campaign);
    const [job] = await draftJobs(campaign);
    const { model, lookup } = await runDraft(job!);

    const draft = await prisma.outreachDraft.findFirstOrThrow({ where: { jobId: job!.id } });
    expect(draft).toMatchObject({ orgId: actor.orgId, ownerUserId: actor.userId, state: "to_review", generations: 1, attempt: 1, touch: "email1" });
    // The body is what sits between Relay's greeting and sign-off.
    expect(draft.body).not.toMatch(/^(?:Hi|Person)\b/);
    expect(draft.findings).toEqual([]);
    // Nothing found on the person or the firm: the role problem, from the plan.
    expect(draft.opener).toMatchObject({ kind: "role_pain", source: "The campaign plan" });
    expect(lookup.calls).toEqual({ searches: 2, fetches: 0 });
    expect(draft.lookup).toMatchObject({ usable: false, searches: 2, fetches: 0 });
    expect(Number(draft.costUsd)).toBeGreaterThan(0);
    expect(model.inputs).toHaveLength(1);
    expect(model.inputs[0]!.touch.kind).toBe("email1");
    expect(await prisma.agentRun.count({ where: { jobId: job!.id } })).toBe(1);
    expect(await prisma.event.count({ where: { kind: "outreach.drafted" } })).toBe(1);
  });

  it("@proof redrafts once with the findings when the first draft fails a gate", async () => {
    const { campaign } = await revealed(rep(), 1);
    await writeEmails(rep(), campaign);
    const [job] = await draftJobs(campaign);
    const { model } = await runDraft(job!, ["time-ask", "good"]);

    const draft = await prisma.outreachDraft.findFirstOrThrow({ where: { jobId: job!.id } });
    expect(draft).toMatchObject({ state: "to_review", generations: 2 });
    expect(model.inputs[1]!.redraft?.findings.join(" ")).toMatch(/asks for a time/);
    expect(model.inputs[1]!.redraft?.previous.ask).toBe("Could we find twenty minutes next week?");
  });

  it("@proof parks a draft that fails twice as Needs you, with the labels, after two generations and no more", async () => {
    const { campaign } = await revealed(rep(), 1);
    await writeEmails(rep(), campaign);
    const [job] = await draftJobs(campaign);
    const { model } = await runDraft(job!, ["time-ask", "time-ask", "good"]);

    const draft = await prisma.outreachDraft.findFirstOrThrow({ where: { jobId: job!.id } });
    expect(draft).toMatchObject({ state: "needs_you", generations: 2 });
    expect((draft.findings as { rule: string }[]).map((finding) => finding.rule)).toContain("time-ask");
    expect(model.inputs).toHaveLength(2);
    expect(await prisma.agentRun.count({ where: { jobId: job!.id } })).toBe(2);
  });

  it("records a draft it could not write as not written, with no body", async () => {
    const { campaign } = await revealed(rep(), 1);
    await writeEmails(rep(), campaign);
    const [job] = await draftJobs(campaign);
    await runDraft(job!, ["garbage", "garbage"]);
    const draft = await prisma.outreachDraft.findFirstOrThrow({ where: { jobId: job!.id } });
    expect(draft).toMatchObject({ state: "failed", body: null, generations: 2 });
  });

  it("hands an unexpected error back to the queue while attempts remain, and the person still shows as writing", async () => {
    const { actor, campaign } = await revealed(rep(), 1);
    await writeEmails(rep(), campaign);
    const [job] = await draftJobs(campaign);
    await expect(runBroken(job!, 1, "model")).rejects.toThrow(/socket hang up/);
    expect(await prisma.outreachDraft.count({ where: { jobId: job!.id } })).toBe(0);
    expect((await view(actor, campaign)).peopleFound?.drafts).toMatchObject({ writing: 1, failed: 0 });
  });

  it("records a visible failed draft when an unexpected error lands on the job's last attempt", async () => {
    const { actor, campaign } = await revealed(rep(), 1);
    await writeEmails(rep(), campaign);
    const [job] = await draftJobs(campaign);
    const result = await runBroken(job!, 3, "model");
    const draft = await prisma.outreachDraft.findFirstOrThrow({ where: { jobId: job!.id } });
    expect(result).toEqual({ draftId: draft.id });
    expect(draft).toMatchObject({ state: "failed", body: null, claims: [] });
    expect((draft.findings as { rule: string }[]).map((finding) => finding.rule)).toEqual(["error"]);
    await prisma.job.update({ where: { id: job!.id }, data: { status: "done" } });
    expect((await view(actor, campaign)).peopleFound?.drafts).toMatchObject({ writing: 0, failed: 1 });
  });

  it("records a failed draft at once for an error no retry can fix", async () => {
    const { campaign } = await revealed(rep(), 1);
    await writeEmails(rep(), campaign);
    const [job] = await draftJobs(campaign);
    await runBroken(job!, 1, "terminal");
    expect(await prisma.outreachDraft.findFirstOrThrow({ where: { jobId: job!.id } })).toMatchObject({ state: "failed", generations: 0 });
  });

  it("records a failed draft when the lookup itself fails on the last attempt", async () => {
    const { campaign } = await revealed(rep(), 1);
    await writeEmails(rep(), campaign);
    const [job] = await draftJobs(campaign);
    await expect(runBroken(job!, 1, "search")).rejects.toThrow(/search is down/);
    await runBroken(job!, 3, "search");
    expect(await prisma.outreachDraft.findFirstOrThrow({ where: { jobId: job!.id } })).toMatchObject({ state: "failed", generations: 0 });
  });

  it("shows a person whose job failed with no draft as failed, not as never asked", async () => {
    const { actor, campaign } = await revealed(rep(), 2);
    await writeEmails(rep(), campaign);
    const [first] = await draftJobs(campaign);
    // The queue spent the attempts and nothing was recorded (the database was down for the last one, say).
    await prisma.job.update({ where: { id: first!.id }, data: { status: "failed" } });
    const drafts = (await view(actor, campaign)).peopleFound?.drafts;
    expect(drafts).toMatchObject({ writing: 1, failed: 1 });
  });

  it("@proof is idempotent: a retried job writes nothing new and searches for nothing", async () => {
    const { campaign } = await revealed(rep(), 1);
    await writeEmails(rep(), campaign);
    const [job] = await draftJobs(campaign);
    const first = await runDraft(job!);
    const second = await runDraft(job!);
    expect(second.result).toEqual(first.result);
    expect(second.model.inputs).toHaveLength(0);
    expect(second.lookup.calls).toEqual({ searches: 0, fetches: 0 });
    expect(await prisma.outreachDraft.count({ where: { jobId: job!.id } })).toBe(1);
    expect(await prisma.event.count({ where: { kind: OUTREACH_LOOKUP } })).toBe(1);
  });

  it("@proof stops at the campaign's drafting ceiling and calls no model", async () => {
    const { actor, campaign } = await revealed(rep(), 2);
    await writeEmails(rep(), campaign);
    const [first, second] = await draftJobs(campaign);
    // A first draft that cost the whole ceiling.
    await recordDraft(prisma, {
      orgId: actor.orgId,
      job: { id: first!.id, campaignId: campaign.id, briefVersion: 1, ownerUserId: actor.userId },
      campaignPersonId: (first!.input as { campaignPersonId: string }).campaignPersonId,
      attempt: 1,
      state: "failed",
      draft: null,
      findings: [],
      advice: [],
      lookup: { items: [], usable: false, searches: 0, fetches: 0 },
      generations: 0,
      costUsd: 10,
    });
    const { model, lookup } = await runDraft(second!);
    expect(model.inputs).toHaveLength(0);
    expect(lookup.calls).toEqual({ searches: 0, fetches: 0 });
    expect(await prisma.outreachDraft.findFirstOrThrow({ where: { jobId: second!.id } })).toMatchObject({ state: "failed", generations: 0 });
  });
});

describe("the rep's review", () => {
  async function written(keep = 2) {
    const setupResult = await revealed(rep(), keep);
    await writeEmails(rep(), setupResult.campaign);
    for (const job of await draftJobs(setupResult.campaign)) await runDraft(job);
    return setupResult;
  }

  it("@proof shows the rep their drafts, and approves one with an edit as Ready to send; nothing is sent", async () => {
    await written(2);
    const { items } = await caller(rep()).drafts.queue();
    expect(items).toHaveLength(2);
    const item = items[0]!;
    expect(item).toMatchObject({ kind: "draft", sends: null, written: true });

    const edited = `${item.kind === "draft" && item.draft.kind === "message" ? item.draft.body : ""} Happy to send more.`;
    await caller(rep()).drafts.approve({ draftId: item.id, body: edited });
    const draft = await prisma.outreachDraft.findUniqueOrThrow({ where: { id: item.id } });
    expect(draft).toMatchObject({ state: "approved", editedBody: edited });
    expect(draft.editClass).not.toBeNull();
    expect((await caller(rep()).drafts.queue()).items).toHaveLength(1);
    // Decided is final.
    expect(await codeOf(caller(rep()).drafts.approve({ draftId: item.id }))).toBe("CONFLICT");
    // Approve sends nothing: no job but the drafts' own exists.
    expect(await prisma.job.count({ where: { kind: { notIn: ["research", LEAD_GEN_JOB, REVEAL_JOB, OUTREACH_DRAFT_JOB] } } })).toBe(0);
  });

  it("@proof asks for another draft on wrong angle, and closes it on not now", async () => {
    const { campaign } = await written(2);
    const { items } = await caller(rep()).drafts.queue();
    const result = await caller(rep()).drafts.reject({ draftId: items[0]!.id, reason: "wrong_angle", requestId: randomUUID() });
    expect(result.redrafting).toBe(true);
    const redraft = (await draftJobs(campaign)).find((job) => (job.input as { attempt: number }).attempt === 2);
    expect(redraft?.input).toMatchObject({ attempt: 2, avoid: { reason: "wrong_angle" } });

    const closed = await caller(rep()).drafts.reject({ draftId: items[1]!.id, reason: "not_now", requestId: randomUUID() });
    expect(closed.redrafting).toBe(false);
    expect(await prisma.outreachDraft.findUniqueOrThrow({ where: { id: items[1]!.id } })).toMatchObject({ state: "rejected", rejectReason: "not_now" });
  });

  it("@proof keeps drafts to their owner: another org sees none and cannot decide one", async () => {
    await written(1);
    const { items } = await caller(rep()).drafts.queue();
    await ensureUser(prisma, stranger());
    expect((await caller(stranger()).drafts.queue()).items).toEqual([]);
    expect(await codeOf(caller(stranger()).drafts.approve({ draftId: items[0]!.id }))).toBe("NOT_FOUND");
    expect(await codeOf(caller(stranger()).drafts.reject({ draftId: items[0]!.id, reason: "not_now", requestId: randomUUID() }))).toBe("NOT_FOUND");
  });
});

describe("the rep's voice", () => {
  it("saves the samples and the note, and the writer is given them", async () => {
    const { campaign } = await revealed(rep(), 1);
    await caller(rep()).drafts.saveVoice({ samples: [{ text: "Morning Sarah,\n\nShort and plain.\n\nSam", addedAt: "2026-09-15" }], howIWrite: "Short. No hype." });
    expect(await caller(rep()).drafts.voice()).toEqual({ samples: [{ text: "Morning Sarah,\n\nShort and plain.\n\nSam", addedAt: "2026-09-15" }], howIWrite: "Short. No hype." });
    await writeEmails(rep(), campaign);
    const [job] = await draftJobs(campaign);
    const { model } = await runDraft(job!);
    expect(model.inputs[0]!.voice).toEqual({ email: ["Morning Sarah,\n\nShort and plain.\n\nSam"], linkedin: [], howIWrite: "Short. No hype." });
  });

  it("@proof never writes a voice under another org", async () => {
    const owner = await ensureUser(prisma, rep());
    const other = await ensureUser(prisma, stranger());
    await saveVoice(prisma, { orgId: owner.orgId, userId: owner.userId, voice: { samples: [], howIWrite: "Mine." } });
    await expect(saveVoice(prisma, { orgId: other.orgId, userId: owner.userId, voice: { samples: [], howIWrite: "Theirs." } })).rejects.toThrow();
    expect(await prisma.repVoice.findMany({ select: { orgId: true, userId: true, howIWrite: true } })).toEqual([{ orgId: owner.orgId, userId: owner.userId, howIWrite: "Mine." }]);
  });
});
