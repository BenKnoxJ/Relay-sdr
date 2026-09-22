import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Campaign as CampaignRow, Job, Prisma } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SEQUENCE, type OutreachInput } from "../../agents/outreach/input.schema";
import type { HumanTouches, HumanizeInput } from "../../agents/outreach/sequence.schema";
import { stubModel } from "@/lib/agents/stubModel";
import { enqueue } from "@/lib/jobs/queue";
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
import { OUTREACH_DRAFT_JOB, OUTREACH_LOOKUP, PERSON_DRAFT_COST_CAP_USD, recordDraft, saveVoice } from "@/lib/repo/outreach";
import { checkedSequenceOf, renderChecks } from "@/lib/outreach/messageChecks";
import { loadStandard } from "@/lib/outreach/standard";
import { recordResearchCompleted } from "@/lib/repo/research";
import type { FetchService, SearchService } from "@/lib/services";
import { leadGenHandler } from "@/worker/handlers/leadGen";
import { fixtureWriter, outreachDraftHandler, type ModelCall } from "@/worker/handlers/outreachDraft";
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

type Answer = "good" | "time-ask" | "garbage" | "opener-claim" | "call" | "machine-word";

function answerFor(input: OutreachInput, kind: Answer): string {
  if (kind === "garbage") return "Here is the email you asked for.";
  const ref = input.buyerRole?.id ?? input.pack.archetype.pains[0]!.id;
  if (kind === "call") {
    return JSON.stringify({ kind: "call", talkingPoint: { openingLine: "Calling about the calls behind complaints.", oneQuestion: "Is that yours?", listenFor: "who owns it", numberSource: "zoho" }, opener: { ref, kind: "role_pain" }, claims: [] });
  }
  const firm = Number(input.person.company.match(/\d+/)?.[0] ?? 0);
  const good = GOOD[firm % GOOD.length]!;
  if (kind === "machine-word") {
    // Relay's own nouns and "pipeline", which the outreach list refuses (P5c), beside plain English ("job") it does not.
    const ask = "Is the current review doing the job?";
    return JSON.stringify({ kind: "message", subject: "Complaints and the calls behind them", body: good.body.replace(good.ask, `Our orchestrator reads every call in the pipeline, with no prompt to tune. ${ask}`), ask, opener: { ref, kind: "role_pain" }, claims: [] });
  }
  const draft = kind !== "time-ask" ? good : { body: good.body.replace(good.ask, "Could we find twenty minutes next week?"), ask: "Could we find twenty minutes next week?" };
  // The 15 Sep slip: the opener's ref listed as if it were a product claim.
  const claims = kind === "opener-claim" ? [ref] : [];
  return JSON.stringify({ kind: "message", subject: "Complaints and the calls behind them", ...draft, opener: { ref, kind: "role_pain" }, claims });
}

/** The rest of a good sequence, the same for everyone: each touch inside its own limits and gates. */
function restOfSequence(ref: string): Record<string, unknown> {
  const message = (body: string, ask: string, subject?: string) => ({ kind: "message", ...(subject === undefined ? {} : { subject }), body, ask, opener: { ref, kind: "role_pain" }, claims: [] });
  return {
    email2: message(
      "Another angle on the same problem. When a complaint lands, the calls behind it are usually weeks old. Reading every call shows the pattern while it can still be coached. Would that timing matter to your team?",
      "Would that timing matter to your team?",
      "Should be dropped: a reply has no subject",
    ),
    breakup: message("I won't keep writing about this. If call quality sits with someone else on your side, who would be the right person to ask?", "If call quality sits with someone else on your side, who would be the right person to ask?", "Right person for call quality"),
    li_connect: message("Your role came up while I was reading about complaint handling. Would you be open to connecting?", "Would you be open to connecting?"),
    li_dm: message(
      "In claims teams, something that comes up a lot is that the calls behind a complaint are found late, because only a small sample gets reviewed. Reading every call turns that around, so coaching can start in the same week as the call. Is that something your team is looking at this year, or is it settled for now?",
      "Is that something your team is looking at this year, or is it settled for now?",
    ),
    li_dm2: message(
      "A last thought on this. The complaints that cost the most usually trace back to a handful of calls nobody heard. Finding those early is the whole idea. Worth a conversation, or not a priority right now?",
      "Worth a conversation, or not a priority right now?",
    ),
    call: {
      kind: "call",
      talkingPoint: {
        openingLine: "It's about how the calls behind complaints get found, and I will be quick.",
        oneQuestion: "Is finding those calls earlier something you own?",
        listenFor: "whether sampling feels like a gap, and who owns call quality",
        numberSource: "find_a_number",
        voicemail: "Calling about how the calls behind complaints get found. I will send a short note by email, so there is nothing to call back about.",
        objections: [{ objection: "We already sample calls.", answer: "That makes sense; the question is how many of the calls behind complaints the sample catches." }],
      },
      opener: { ref, kind: "role_pain" },
      claims: [],
    },
  };
}

type Humanize = (touches: HumanTouches) => unknown;

function writer(script: Answer[], humanize: Humanize = (touches) => touches, patch: (ref: string) => Record<string, unknown> = () => ({})) {
  const inputs: OutreachInput[] = [];
  const humanized: HumanizeInput[] = [];
  return {
    inputs,
    humanized,
    makeModel: (id: "claude-sonnet-5" | string, input: OutreachInput, at: ModelCall) => {
      const usage = { in: 6000, out: 350, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
      const reply = (text: string) => ({ transport: "stub" as const, model: stubModel({ modelId: id, calls: [{ text, usage }], whenExhausted: "throw" }) });
      if (at.pass === "humanize") {
        humanized.push(at.humanize!);
        return reply(JSON.stringify(humanize(at.humanize!.touches)));
      }
      const kind = script[inputs.length] ?? "good";
      inputs.push(input);
      const ref = input.buyerRole?.id ?? input.pack.archetype.pains[0]!.id;
      if (input.sequence === undefined && input.touch.kind !== "email1") return reply(JSON.stringify(restOfSequence(ref)[input.touch.kind]));
      const first = answerFor(input, kind);
      if (input.sequence === undefined || kind === "garbage") return reply(first);
      return reply(JSON.stringify({ ...restOfSequence(ref), ...patch(ref), email1: JSON.parse(first) }));
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

async function runDraft(job: Job, script: Answer[] = ["good"], humanize?: Humanize, patch?: (ref: string) => Record<string, unknown>) {
  const model = writer(script, humanize, patch);
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
  it("@proof looks up, drafts the whole sequence in one call, humanizes it once, and stores seven drafts", async () => {
    const { actor, campaign } = await revealed(rep(), 1);
    await writeEmails(rep(), campaign);
    const [job] = await draftJobs(campaign);
    const { model, lookup, result } = await runDraft(job!);

    const drafts = await prisma.outreachDraft.findMany({ where: { jobId: job!.id } });
    expect(drafts.map((row) => row.touch).sort()).toEqual([...SEQUENCE].sort());
    expect(drafts.map((row) => [row.touch, row.state, row.findings])).toEqual(drafts.map((row) => [row.touch, "to_review", []]));
    expect(drafts.every((row) => row.orgId === actor.orgId && row.attempt === 1)).toBe(true);
    expect(result).toEqual({ draftId: expect.any(String), draftIds: expect.any(Array) });
    // One call wrote all seven, one humanizer pass edited them: two runs, one Event.
    expect(model.inputs).toHaveLength(1);
    expect(model.inputs[0]!.sequence).toEqual([...SEQUENCE]);
    // P5c: the drafter is told who is writing: the rep's first name, and Conversant while the org is only its domain.
    expect(model.inputs[0]!.sender).toEqual({ firstName: "Sam", company: "Conversant" });
    expect(model.humanized).toHaveLength(1);
    expect(Object.keys(model.humanized[0]!.touches).sort()).toEqual([...SEQUENCE].sort());
    // The job's cost sits on its first touch.
    const touch = (kind: string) => drafts.find((row) => row.touch === kind)!;
    expect(Number(touch("email2").costUsd)).toBe(0);
    // A follow-up is a reply in Email 1's thread; LinkedIn has no subject. The break-up keeps its own.
    expect(touch("email2").subject).toBeNull();
    expect(touch("li_dm").subject).toBeNull();
    expect(touch("breakup").subject).toBe("Right person for call quality");
    // The call script is stored as the rep reads it, its question as the ask.
    expect(touch("call").body).toContain("Voicemail: Calling about how the calls behind complaints get found.");
    expect(touch("call").body).toContain("If they say: We already sample calls.");
    expect(touch("call").ask).toBe("Is finding those calls earlier something you own?");

    const draft = touch("email1");
    expect(draft).toMatchObject({ orgId: actor.orgId, ownerUserId: actor.userId, state: "to_review", generations: 1, attempt: 1, touch: "email1" });
    // The body is what sits between Relay's greeting and sign-off.
    expect(draft.body).not.toMatch(/^(?:Hi|Person)\b/);
    expect(draft.findings).toEqual([]);
    // Nothing found on the person or the firm: the role problem, from the plan.
    expect(draft.opener).toMatchObject({ kind: "role_pain", source: "The campaign plan" });
    expect(lookup.calls).toEqual({ searches: 2, fetches: 0 });
    expect(draft.lookup).toMatchObject({ usable: false, searches: 2, fetches: 0 });
    expect(Number(draft.costUsd)).toBeGreaterThan(0);
    expect(model.inputs[0]!.touch.kind).toBe("email1");
    expect(await prisma.agentRun.count({ where: { jobId: job!.id } })).toBe(2);
    expect(await prisma.event.count({ where: { kind: "outreach.drafted" } })).toBe(1);
  });

  it("moves the opener's ref out of the claims before the gates, and stores the draft without it", async () => {
    const { campaign } = await revealed(rep(), 1);
    await writeEmails(rep(), campaign);
    const [job] = await draftJobs(campaign);
    await runDraft(job!, ["opener-claim"]);

    const draft = await prisma.outreachDraft.findFirstOrThrow({ where: { jobId: job!.id, touch: "email1" } });
    expect(draft).toMatchObject({ state: "to_review", generations: 1, claims: [] });
    expect(draft.findings).toEqual([]);
  });

  it("offers a first email the message shape only: a call-shaped answer is refused by the run, not gated", async () => {
    const { campaign } = await revealed(rep(), 1);
    await writeEmails(rep(), campaign);
    const [job] = await draftJobs(campaign);
    const { model } = await runDraft(job!, ["call", "good"]);

    const draft = await prisma.outreachDraft.findFirstOrThrow({ where: { jobId: job!.id, touch: "email1" } });
    expect(draft).toMatchObject({ state: "to_review", generations: 2 });
    expect(model.inputs[1]!.redraft?.previous.body).toMatch(/did not come back in the right shape/);
    const runs = await prisma.agentRun.findMany({ where: { jobId: job!.id }, orderBy: { createdAt: "asc" }, select: { status: true, error: true } });
    // The refused answer, the corrected one, and the humanizer pass.
    expect(runs.map((run) => run.status)).toEqual(["failed", "done", "done"]);
    expect(runs[0]!.error).toMatch(/schema|validate/);
  });

  it("tells the redraft why an answer was refused, and keeps the refused words off the rep's card", async () => {
    const { campaign } = await revealed(rep(), 1);
    await writeEmails(rep(), campaign);
    const [job] = await draftJobs(campaign);
    const { model } = await runDraft(job!, ["machine-word", "good"]);

    const draft = await prisma.outreachDraft.findFirstOrThrow({ where: { jobId: job!.id, touch: "email1" } });
    expect(draft).toMatchObject({ state: "to_review", generations: 2 });
    const redraft = model.inputs[1]!.redraft!;
    expect(redraft.findings.join(" ")).toMatch(/"orchestrator", "pipeline", "prompt"/);
    // Only the words the outreach list refuses are named; the plain English stays.
    expect(redraft.findings.join(" ")).not.toMatch(/"job"/);
    // The refused answer is what the writer fixes, not a placeholder.
    expect(redraft.previous.body).toContain("Our orchestrator reads every call");
    expect(redraft.previous.ask).toBe("Is the current review doing the job?");
  });

  it("parks a draft refused twice for its words as not written, with the plain shape finding only", async () => {
    const { campaign } = await revealed(rep(), 1);
    await writeEmails(rep(), campaign);
    const [job] = await draftJobs(campaign);
    await runDraft(job!, ["machine-word", "machine-word"]);

    const draft = await prisma.outreachDraft.findFirstOrThrow({ where: { jobId: job!.id, touch: "email1" } });
    expect(draft).toMatchObject({ state: "failed", generations: 2, body: null });
    expect(draft.findings).toEqual([{ rule: "shape", text: "The draft did not come back in the right shape." }]);
  });

  it("@proof redrafts once with the findings when the first draft fails a gate", async () => {
    const { campaign } = await revealed(rep(), 1);
    await writeEmails(rep(), campaign);
    const [job] = await draftJobs(campaign);
    const { model } = await runDraft(job!, ["time-ask", "good"]);

    const draft = await prisma.outreachDraft.findFirstOrThrow({ where: { jobId: job!.id, touch: "email1" } });
    expect(draft).toMatchObject({ state: "to_review", generations: 2 });
    expect(model.inputs[1]!.redraft?.findings.join(" ")).toMatch(/asks for a time/);
    expect(model.inputs[1]!.redraft?.previous.ask).toBe("Could we find twenty minutes next week?");
  });

  it("@proof parks a draft that fails twice as Needs you, with the labels, after two generations and no more", async () => {
    const { campaign } = await revealed(rep(), 1);
    await writeEmails(rep(), campaign);
    const [job] = await draftJobs(campaign);
    const { model } = await runDraft(job!, ["time-ask", "time-ask", "good"]);

    const draft = await prisma.outreachDraft.findFirstOrThrow({ where: { jobId: job!.id, touch: "email1" } });
    expect(draft).toMatchObject({ state: "needs_you", generations: 2 });
    expect((draft.findings as { rule: string }[]).map((finding) => finding.rule)).toContain("time-ask");
    expect(model.inputs).toHaveLength(2);
    // Two draft calls and the humanizer pass.
    expect(await prisma.agentRun.count({ where: { jobId: job!.id } })).toBe(3);
  });

  it("records a draft it could not write as not written, with no body", async () => {
    const { campaign } = await revealed(rep(), 1);
    await writeEmails(rep(), campaign);
    const [job] = await draftJobs(campaign);
    await runDraft(job!, ["garbage", "garbage"]);
    const draft = await prisma.outreachDraft.findFirstOrThrow({ where: { jobId: job!.id, touch: "email1" } });
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
    const draft = await prisma.outreachDraft.findFirstOrThrow({ where: { jobId: job!.id, touch: "email1" } });
    // Every touch of the sequence is recorded as not written, so none silently drops out.
    expect(result).toEqual({ draftId: draft.id, draftIds: expect.arrayContaining([draft.id]) });
    expect(await prisma.outreachDraft.count({ where: { jobId: job!.id, state: "failed" } })).toBe(SEQUENCE.length);
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
    expect(await prisma.outreachDraft.findFirstOrThrow({ where: { jobId: job!.id, touch: "email1" } })).toMatchObject({ state: "failed", generations: 0 });
  });

  it("records a failed draft when the lookup itself fails on the last attempt", async () => {
    const { campaign } = await revealed(rep(), 1);
    await writeEmails(rep(), campaign);
    const [job] = await draftJobs(campaign);
    await expect(runBroken(job!, 1, "search")).rejects.toThrow(/search is down/);
    await runBroken(job!, 3, "search");
    expect(await prisma.outreachDraft.findFirstOrThrow({ where: { jobId: job!.id, touch: "email1" } })).toMatchObject({ state: "failed", generations: 0 });
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
    expect(second.model.humanized).toHaveLength(0);
    expect(second.lookup.calls).toEqual({ searches: 0, fetches: 0 });
    expect(await prisma.outreachDraft.count({ where: { jobId: job!.id } })).toBe(SEQUENCE.length);
    expect(await prisma.event.count({ where: { kind: OUTREACH_LOOKUP } })).toBe(1);
  });

  it("@proof keeps the humanizer's rewording when it passes the checks, and records both versions", async () => {
    const { campaign } = await revealed(rep(), 1);
    await writeEmails(rep(), campaign);
    const [job] = await draftJobs(campaign);
    const shorter = "Another angle on this. The calls behind a complaint are usually weeks old by the time anyone hears them. Reading every call shows the pattern while there is still time to coach it. Would that timing matter to your team?";
    await runDraft(job!, ["good"], (touches) => ({ ...touches, email2: { ...touches.email2!, body: shorter } }));

    const email2 = await prisma.outreachDraft.findFirstOrThrow({ where: { jobId: job!.id, touch: "email2" } });
    expect(email2).toMatchObject({ body: shorter, state: "to_review" });
    const event = await prisma.event.findFirstOrThrow({ where: { kind: "outreach.drafted", campaignId: campaign.id } });
    const humanizer = (event.after as { humanizer: { ran: boolean; touches: Record<string, { kept: string; drafted: { body: string }; humanized: { body: string } }> } }).humanizer;
    expect(humanizer.ran).toBe(true);
    expect(humanizer.touches.email2).toMatchObject({ kept: "humanized", humanized: { body: shorter } });
    expect(humanizer.touches.email2!.drafted.body).toMatch(/^Another angle on the same problem\./);
    expect((event.after as { cost: { draftUsd: number; humanizerUsd: number } }).cost.humanizerUsd).toBeGreaterThan(0);
    // Messaging v2: each touch's change size, as a share of its characters. Untouched is 0.
    const sizes = (event.after as { humanizer: { touches: Record<string, { changePct: number | null }> } }).humanizer.touches;
    expect(sizes.email2!.changePct).toBeGreaterThan(5);
    expect(sizes.email2!.changePct).toBeLessThan(100);
    expect(sizes.breakup!.changePct).toBe(0);
    expect(Object.keys(sizes).sort()).toEqual([...SEQUENCE].sort());
  });

  it("@proof gives the humanizer the standard's rules, who is writing, and the live facts with their notes", async () => {
    const { campaign } = await revealed(rep(), 1);
    await writeEmails(rep(), campaign);
    const [job] = await draftJobs(campaign);
    const { model } = await runDraft(job!);
    const given = model.humanized[0]!;
    expect(given.rules).toEqual(loadStandard().rules);
    expect(given.sender).toEqual({ firstName: "Sam", company: "Conversant" });
    expect(given.facts.product).toBe("insights360");
    expect(given.facts.facts.length).toBeGreaterThan(0);
    expect(given.facts.facts.every((fact) => fact.status === "live")).toBe(true);
    // The notes travel with the facts, so the pass can keep a claim inside them: the price notes as the product owner set them.
    const fees = given.facts.facts.find((fact) => fact.id === "i360.price.setup-and-config-review-fees");
    expect(fees?.notes).toMatch(/only in answer to a price question in a call/i);
    expect(given.facts.facts.find((fact) => fact.id === "i360.product.results-lag-up-to-about-an-hour")?.notes).toMatch(/same day/);
  });

  it("clears a touch's claims when the humanizer cuts its product sentence, and records that it did", async () => {
    const { campaign } = await revealed(rep(), 1);
    await writeEmails(rep(), campaign);
    const [job] = await draftJobs(campaign);
    const ask = "Would that timing matter to your team?";
    const pitched = `Another angle on the same problem. Insights360 scores every analysed call against a team's own QA rules. ${ask}`;
    const cut = `Another angle on the same problem, and it is about timing. ${ask}`;
    await runDraft(
      job!,
      ["good"],
      (touches) => ({ ...touches, email2: { body: cut, ask, droppedProduct: true } }),
      (ref) => ({ email2: { kind: "message", body: pitched, ask, opener: { ref, kind: "role_pain" }, claims: ["i360.feature.auto-qa-scoring-against-tenant-rules"] } }),
    );
    const email2 = await prisma.outreachDraft.findFirstOrThrow({ where: { jobId: job!.id, touch: "email2" } });
    expect(email2).toMatchObject({ body: cut, claims: [], state: "to_review" });
    const event = await prisma.event.findFirstOrThrow({ where: { kind: "outreach.drafted", campaignId: campaign.id } });
    const logged = (event.after as { humanizer: { touches: Record<string, { kept: string; droppedProduct?: boolean }> } }).humanizer.touches;
    expect(logged.email2).toMatchObject({ kept: "humanized", droppedProduct: true });
    expect(logged.breakup!.droppedProduct).toBeUndefined();
  });

  it("keeps the claims when the humanizer says it cut the product sentence but the product is still in the words", async () => {
    const { campaign } = await revealed(rep(), 1);
    await writeEmails(rep(), campaign);
    const [job] = await draftJobs(campaign);
    const ask = "Would that timing matter to your team?";
    const pitched = `Another angle on the same problem. Insights360 scores every analysed call against a team's own QA rules. ${ask}`;
    const reworded = `Another angle on this. Insights360 scores every analysed call against a team's own QA rules. ${ask}`;
    await runDraft(
      job!,
      ["good"],
      (touches) => ({ ...touches, email2: { body: reworded, ask, droppedProduct: true } }),
      (ref) => ({ email2: { kind: "message", body: pitched, ask, opener: { ref, kind: "role_pain" }, claims: ["i360.feature.auto-qa-scoring-against-tenant-rules"] } }),
    );
    const email2 = await prisma.outreachDraft.findFirstOrThrow({ where: { jobId: job!.id, touch: "email2" } });
    expect(email2).toMatchObject({ body: reworded, claims: ["i360.feature.auto-qa-scoring-against-tenant-rules"] });
    const event = await prisma.event.findFirstOrThrow({ where: { kind: "outreach.drafted", campaignId: campaign.id } });
    expect((event.after as { humanizer: { touches: Record<string, { droppedProduct?: boolean }> } }).humanizer.touches.email2!.droppedProduct).toBeUndefined();
  });

  it("@proof sends a touch back to its drafted words when the humanizer adds a number or a name", async () => {
    const { campaign } = await revealed(rep(), 1);
    await writeEmails(rep(), campaign);
    const [job] = await draftJobs(campaign);
    await runDraft(job!, ["good"], (touches) => ({
      ...touches,
      email2: { ...touches.email2!, body: touches.email2!.body.replace("Another angle on the same problem.", "Another angle on the same problem, which cost firms 40% more in 2025.") },
      li_dm2: { ...touches.li_dm2!, body: touches.li_dm2!.body.replace("A last thought on this.", "A last thought on this, from a chat with Aviva Direct.") },
    }));

    const drafts = await prisma.outreachDraft.findMany({ where: { jobId: job!.id } });
    const touch = (kind: string) => drafts.find((row) => row.touch === kind)!;
    expect(touch("email2").body).toMatch(/^Another angle on the same problem\. When/);
    expect(touch("li_dm2").body).toMatch(/^A last thought on this\. The/);
    const event = await prisma.event.findFirstOrThrow({ where: { kind: "outreach.drafted", campaignId: campaign.id } });
    const logged = (event.after as { humanizer: { touches: Record<string, { kept: string; reason?: string }> } }).humanizer.touches;
    expect(logged.email2).toMatchObject({ kept: "drafted" });
    expect(logged.email2!.reason).toMatch(/40%.*2025|2025.*40%/);
    expect(logged.li_dm2!.reason).toMatch(/Aviva Direct/);
    // The touches it left alone are kept as humanized.
    expect(logged.breakup).toMatchObject({ kept: "humanized" });
  });

  it("sends a touch back when the humanized words fail a check the draft passed", async () => {
    const { campaign } = await revealed(rep(), 1);
    await writeEmails(rep(), campaign);
    const [job] = await draftJobs(campaign);
    await runDraft(job!, ["good"], (touches) => ({ ...touches, li_connect: { ...touches.li_connect!, body: "I wanted to reach out about complaint handling. Would you be open to connecting?", ask: "Would you be open to connecting?" } }));
    const connect = await prisma.outreachDraft.findFirstOrThrow({ where: { jobId: job!.id, touch: "li_connect" } });
    expect(connect).toMatchObject({ state: "to_review", body: "Your role came up while I was reading about complaint handling. Would you be open to connecting?" });
    const event = await prisma.event.findFirstOrThrow({ where: { kind: "outreach.drafted", campaignId: campaign.id } });
    expect((event.after as { humanizer: { touches: Record<string, { reason?: string }> } }).humanizer.touches.li_connect!.reason).toMatch(/tells/);
  });

  it("gates every touch once more against the emails actually kept: a follow-up no longer shorter than a humanized Email 1 is held", async () => {
    const { campaign } = await revealed(rep(), 1);
    await writeEmails(rep(), campaign);
    const [job] = await draftJobs(campaign);
    const followUp = "One more thought on the same problem. When a complaint lands, the calls behind it are usually weeks old. Reading every call shows the pattern early enough to coach the habit out properly. Would that timing matter to your team?";
    const firstEmail = "Complaints tend to arrive weeks after the call that caused them.\n\nBy then the same habit has quietly repeated on many other calls. Reading all of them shows which conversations to coach first. Would that be useful for your team?";
    const count = (text: string) => text.split(/\s+/).length;
    // Every scripted first email is longer than 40 words, so the drafted follow-up passes; the humanized first email is 40.
    expect([count(followUp), count(firstEmail)]).toEqual([40, 40]);
    await runDraft(
      job!,
      ["good"],
      (touches) => ({ ...touches, email1: { ...touches.email1!, body: firstEmail, ask: "Would that be useful for your team?" } }),
      (ref) => ({ email2: { kind: "message", body: followUp, ask: "Would that timing matter to your team?", opener: { ref, kind: "role_pain" }, claims: [] } }),
    );
    const drafts = await prisma.outreachDraft.findMany({ where: { jobId: job!.id } });
    const touch = (kind: string) => drafts.find((row) => row.touch === kind)!;
    expect([touch("email1").state, touch("email1").findings, touch("email1").body]).toEqual(["to_review", [], firstEmail]);
    expect(touch("email2")).toMatchObject({ body: followUp, state: "needs_you" });
    expect((touch("email2").findings as { rule: string }[]).map((finding) => finding.rule)).toEqual(["shorter-than-the-last"]);
  });

  it("@proof never lets the humanizer touch the claims or the opener: an answer carrying them is refused whole", async () => {
    const { campaign } = await revealed(rep(), 1);
    await writeEmails(rep(), campaign);
    const [job] = await draftJobs(campaign);
    await runDraft(job!, ["good"], (touches) => ({ ...touches, email1: { ...touches.email1!, claims: ["i360.product.every-ingested-call-analysed"], opener: { ref: "made-up", kind: "person_fact" } } }));
    const drafts = await prisma.outreachDraft.findMany({ where: { jobId: job!.id } });
    expect(drafts.every((row) => row.claims.length === 0)).toBe(true);
    expect(drafts.every((row) => (row.opener as { kind: string }).kind === "role_pain")).toBe(true);
    const event = await prisma.event.findFirstOrThrow({ where: { kind: "outreach.drafted", campaignId: campaign.id } });
    expect((event.after as { humanizer: { ran: boolean; error?: string } }).humanizer).toMatchObject({ ran: false, error: expect.stringMatching(/refused/) });
  });

  /** A draft that cost `costUsd`, for the person the job is for, under a job of its own. */
  async function spent(actor: Actor, campaign: CampaignRow, job: Job, costUsd: number, briefVersion = 1) {
    const campaignPersonId = (job.input as { campaignPersonId: string }).campaignPersonId;
    // Another version's spend: the campaign is moved there for the enqueue and back.
    if (briefVersion !== 1) await prisma.campaign.update({ where: { id: campaign.id }, data: { briefVersion } });
    const { job: other } = await enqueue(prisma, {
      orgId: actor.orgId,
      ownerUserId: actor.userId,
      kind: OUTREACH_DRAFT_JOB,
      idempotencyKey: `test:spent:${campaignPersonId}:${briefVersion}`,
      input: { requestId: randomUUID(), campaignPersonId, attempt: 2, touch: "li_dm" },
      campaignId: campaign.id,
      briefVersion,
    });
    await recordDraft(prisma, {
      orgId: actor.orgId,
      job: { id: other.id, campaignId: campaign.id, briefVersion, ownerUserId: actor.userId },
      campaignPersonId,
      attempt: 2,
      touch: "li_dm",
      state: "failed",
      draft: null,
      findings: [],
      advice: [],
      lookup: { items: [], usable: false, searches: 0, fetches: 0 },
      generations: 1,
      costUsd,
    });
    if (briefVersion !== 1) await prisma.campaign.update({ where: { id: campaign.id }, data: { briefVersion: 1 } });
  }

  it("@proof parks a person at their $1.50 drafting ceiling for the rep, not as failed, and calls no model", async () => {
    const { actor, campaign } = await revealed(rep(), 2);
    await writeEmails(rep(), campaign);
    const [first, second] = await draftJobs(campaign);
    expect(PERSON_DRAFT_COST_CAP_USD).toBe(1.5);
    await spent(actor, campaign, first!, 1.5);

    const capped = await runDraft(first!);
    expect(capped.model.inputs).toHaveLength(0);
    expect(capped.lookup.calls).toEqual({ searches: 0, fetches: 0 });
    const drafts = await prisma.outreachDraft.findMany({ where: { jobId: first!.id } });
    expect(drafts).toHaveLength(SEQUENCE.length);
    expect(drafts.every((row) => row.state === "needs_you" && row.body === null)).toBe(true);
    expect((drafts[0]!.findings as { rule: string }[]).map((finding) => finding.rule)).toEqual(["cost-cap"]);
    // Parked, not a dead end: nothing to approve, but the rep can set it aside.
    const parked = (await caller(rep()).drafts.queue()).items.find((item) => item.id === drafts.find((row) => row.touch === "email1")!.id)!;
    expect(parked).toMatchObject({ written: false, needsYou: "not_written" });
    expect(await codeOf(caller(rep()).drafts.approve({ draftId: parked.id }))).toBe("BAD_REQUEST");
    expect(await codeOf(caller(rep()).drafts.reject({ draftId: parked.id, reason: "not_now", requestId: randomUUID() }))).toBe("ok");
    expect(await prisma.outreachDraft.findUniqueOrThrow({ where: { id: parked.id } })).toMatchObject({ state: "rejected", body: null });
    // The ceiling is per person: the next person is drafted as usual.
    const next = await runDraft(second!);
    expect(next.model.inputs).toHaveLength(1);
    expect(await prisma.outreachDraft.findFirstOrThrow({ where: { jobId: second!.id, touch: "email1" } })).toMatchObject({ state: "to_review" });
  });

  it("counts the ceiling per brief version: spend at another version does not stop this one", async () => {
    const { actor, campaign } = await revealed(rep(), 1);
    await writeEmails(rep(), campaign);
    const [job] = await draftJobs(campaign);
    await spent(actor, campaign, job!, 5, 2);
    const { model } = await runDraft(job!);
    expect(model.inputs).toHaveLength(1);
    expect(await prisma.outreachDraft.findFirstOrThrow({ where: { jobId: job!.id, touch: "email1" } })).toMatchObject({ state: "to_review" });
  });

  it("stops at the ceiling part way: the corrective call and the humanizer are skipped, and a failing touch is parked", async () => {
    const { actor, campaign } = await revealed(rep(), 1);
    await writeEmails(rep(), campaign);
    const [job] = await draftJobs(campaign);
    // Just under the ceiling: the first call takes it over.
    await spent(actor, campaign, job!, 1.49);
    const { model } = await runDraft(job!, ["time-ask", "good"]);
    expect(model.inputs).toHaveLength(1);
    expect(model.humanized).toHaveLength(0);
    const email1 = await prisma.outreachDraft.findFirstOrThrow({ where: { jobId: job!.id, touch: "email1" } });
    expect(email1.state).toBe("needs_you");
    expect((email1.findings as { rule: string }[]).map((finding) => finding.rule)).toEqual(expect.arrayContaining(["cost-cap", "time-ask"]));
    expect(await prisma.outreachDraft.findFirstOrThrow({ where: { jobId: job!.id, touch: "email2" } })).toMatchObject({ state: "to_review" });
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
    // Two people, three emails each; the LinkedIn and call drafts are not queued here.
    expect(items).toHaveLength(6);
    const item = items[0]!;
    expect(item).toMatchObject({ kind: "draft", sends: null, written: true });

    const edited = `${item.kind === "draft" && item.draft.kind === "message" ? item.draft.body : ""} Happy to send more.`;
    await caller(rep()).drafts.approve({ draftId: item.id, body: edited });
    const draft = await prisma.outreachDraft.findUniqueOrThrow({ where: { id: item.id } });
    expect(draft).toMatchObject({ state: "approved", editedBody: edited });
    expect(draft.editClass).not.toBeNull();
    expect((await caller(rep()).drafts.queue()).items).toHaveLength(5);
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

  it("@proof lists only the email touches in the Inbox, each as Email n of 3", async () => {
    const { campaign } = await written(1);
    expect(await prisma.outreachDraft.count({ where: { campaignId: campaign.id } })).toBe(SEQUENCE.length);
    const { items } = await caller(rep()).drafts.queue();
    const stored = await prisma.outreachDraft.findMany({ where: { id: { in: items.map((item) => item.id) } }, select: { id: true, touch: true } });
    expect(stored.map((row) => row.touch).sort()).toEqual(["breakup", "email1", "email2"]);
    const touchOf = (id: string) => stored.find((row) => row.id === id)!.touch;
    expect(items.map((item) => (item.kind === "draft" ? [touchOf(item.id), item.ordinal, item.total] : null))).toEqual([
      ["email1", 1, 3],
      ["email2", 2, 3],
      ["breakup", 3, 3],
    ]);
  });

  it("@proof redrafts one touch in one call, given the earlier emails' words, then humanizes that touch", async () => {
    const { campaign } = await written(1);
    const { items } = await caller(rep()).drafts.queue();
    const followUp = items[1]!;
    const email1 = await prisma.outreachDraft.findFirstOrThrow({ where: { campaignId: campaign.id, touch: "email1" } });
    const result = await caller(rep()).drafts.reject({ draftId: followUp.id, reason: "wrong_angle", requestId: randomUUID() });
    expect(result.redrafting).toBe(true);
    const job = (await draftJobs(campaign)).find((candidate) => (candidate.input as { attempt: number }).attempt === 2)!;
    expect(job.input).toMatchObject({ attempt: 2, touch: "email2", avoid: { reason: "wrong_angle" } });
    expect(job.idempotencyKey).toMatch(/:email2:a2$/);

    const reworded = "A different angle, on timing. When a complaint lands, the calls behind it are usually weeks old. Reading every call shows the pattern while it can still be coached. Would that timing matter to your team?";
    const { model } = await runDraft(job, ["good"], (touches) => ({ email2: { ...touches.email2!, body: reworded } }));
    expect(model.inputs).toHaveLength(1);
    // Messaging v2: every message goes through the humanizer, a redraft too: one draft call and one humanizer call.
    expect(model.humanized).toHaveLength(1);
    expect(Object.keys(model.humanized[0]!.touches)).toEqual(["email2"]);
    expect(model.humanized[0]!.sender).toEqual({ firstName: "Sam", company: "Conversant" });
    expect(await prisma.agentRun.count({ where: { jobId: job.id } })).toBe(2);
    const event = (await prisma.event.findMany({ where: { kind: "outreach.drafted", campaignId: campaign.id } })).find((candidate) => (candidate.after as { jobId?: string }).jobId === job.id)!;
    const after = event.after as { cost: { humanizerUsd: number }; humanizer: { ran: boolean; touches: Record<string, { kept: string; changePct: number | null }> } };
    expect(after.humanizer.ran).toBe(true);
    expect(after.humanizer.touches.email2).toMatchObject({ kept: "humanized" });
    expect(after.humanizer.touches.email2!.changePct).toBeGreaterThan(0);
    expect(after.cost.humanizerUsd).toBeGreaterThan(0);
    const input = model.inputs[0]!;
    expect(input.sequence).toBeUndefined();
    expect(input.touch).toMatchObject({ kind: "email2", ordinal: 2 });
    // The follow-up is written knowing what Email 1 said, and nothing after it.
    expect(input.thread.map((entry) => entry.kind)).toEqual(["email1"]);
    expect(input.thread[0]!.body).toBe(email1.body);
    const redrafted = await prisma.outreachDraft.findMany({ where: { jobId: job.id } });
    expect(redrafted).toHaveLength(1);
    expect(redrafted[0]).toMatchObject({ touch: "email2", attempt: 2, state: "to_review", body: reworded });
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

describe("the cohort report's messaging v2 checks", () => {
  it("@proof shows the new columns for a sequence the fixture writer drafted, with each touch's change size from the Event", async () => {
    const { campaign } = await revealed(rep(), 1);
    await writeEmails(rep(), campaign);
    const [job] = await draftJobs(campaign);
    const person = await prisma.campaignPerson.findFirstOrThrow({ where: { id: (job!.input as { campaignPersonId: string }).campaignPersonId }, include: { person: true } });
    const qa = JSON.parse(readFileSync(path.join(process.cwd(), "fixtures", "outreach", "qa-drafts.json"), "utf8")) as { touches: Record<string, unknown> };
    const file = path.join(mkdtempSync(path.join(tmpdir(), "relay-cohort-")), "drafts.json");
    const first = { subject: "delay as the top complaint theme", ...GOOD[0]!, opener: { ref: "$role", kind: "role_pain" }, claims: [] };
    writeFileSync(file, JSON.stringify({ drafts: { [person.person!.email!.toLowerCase()]: [first] }, touches: qa.touches }));
    const lookup = nothingFound();
    await outreachDraftHandler({ makeModel: fixtureWriter(file), search: lookup.search, fetch: lookup.fetch, now: () => new Date("2026-09-15T09:00:00Z") })({
      db: prisma,
      job: { ...job!, attempts: 1 },
      signal: new AbortController().signal,
    });

    const drafts = await prisma.outreachDraft.findMany({ where: { jobId: job!.id } });
    const order = [...SEQUENCE] as string[];
    drafts.sort((a, b) => order.indexOf(a.touch) - order.indexOf(b.touch));
    const event = await prisma.event.findFirstOrThrow({ where: { kind: "outreach.drafted", campaignId: campaign.id } });
    const humanizer = (event.after as { humanizer: { touches: Record<string, { changePct: number | null }> } }).humanizer.touches;
    const report = renderChecks([checkedSequenceOf("Person 1", drafts, humanizer)], "Insights360");

    expect(report).toContain('| Touch | Written | Product named or described | Price | "X, or Y?" asks | Stock opener or subject | Gendered pronouns | Attributed insight | Humanizer change (median) |');
    expect(report).toContain('| Person | Product in Email 1 | Written touches with the product | Price in cold touches | "X, or Y?" asks | Stock openers or subjects | Gendered pronouns | Emails and LinkedIn messages with an insight | Humanizer change (median) |');
    // The fixture's first email names what the product does ("Reading every call" is not a product sentence), and its
    // LinkedIn message and follow-up end "X, or Y?": two in one sequence, over the bar.
    expect(report).toContain('| "X, or Y?" asks in any one sequence | at most 1 | at most 2 (2 in total) | **no** |');
    expect(report).toContain("| Price in a cold touch | 0 | 0 of 6 | yes |");
    // The fixture writer hands every touch back untouched: 0% on all seven, and the bar says so.
    expect(report).toContain("| Humanizer change, median | at least 10% | 0.0% over 7 touches | **no** |");
    expect(report).toMatch(/\| Person 1 \| no \| \d \| 0 \| 2 \| none \| none \| \d of 5 \| 0\.0% \|/);
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
