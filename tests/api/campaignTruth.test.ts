import { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { leadgenRecipe } from "../../agents/research/output.schema";
import { campaignsCopy } from "@/lib/copy/campaigns";
import { prisma } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { NO_CRM } from "@/lib/leadgen/crm";
import { SampleRevealProvider, sampleProvider, sampleVocabulary } from "@/lib/leadgen/sample";
import { DOCUMENTED_UNVERIFIED_PRICING } from "@/lib/leadgen/spend";
import { campaignSummariesForOwner } from "@/lib/repo/campaignSummary";
import { CAMPAIGN_CONFIRMED, CAMPAIGN_REVEAL_CONFIRMED, LEAD_GEN_JOB, REVEAL_JOB } from "@/lib/repo/leadgen";
import { recordResearchCompleted } from "@/lib/repo/research";
import { appRouter } from "@/server/api/root";
import { type TRPCContext } from "@/server/api/trpc";
import { type Session } from "@/server/auth/session";
import { ensureUser, type Actor } from "@/server/auth/upsertUser";
import { leadGenHandler } from "@/worker/handlers/leadGen";
import { revealHandler } from "@/worker/handlers/reveal";

import { emptyAll, resetDatabase } from "../db/harness";
import { completePack, partialPack, startInput } from "../lib/campaignPacks";

/**
 * The product-truth foundation through the real router: the summary facts
 * the list reads, the stage and the actions the page reads, and the
 * mutations behind those actions, agreeing with each other. Sample people
 * and sample credits throughout; nothing reaches a provider.
 */

vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: null }),
  currentUser: async () => null,
}));

beforeAll(async () => {
  await resetDatabase();
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await emptyAll();
  process.env.RELAY_LEADGEN_PROVIDER = "sample";
  resetEnv();
});

afterEach(() => {
  delete process.env.RELAY_LEADGEN_PROVIDER;
  resetEnv();
});

function contextFor(session: Session | null): TRPCContext {
  let pending: Promise<Actor> | undefined;
  return {
    prisma,
    headers: new Headers(),
    session,
    actor: () => {
      if (session === null) return Promise.reject(new Error("not signed in"));
      return (pending ??= ensureUser(prisma, session));
    },
  };
}
const caller = (session: Session | null) => appRouter.createCaller(contextFor(session));
const sessionOf = (clerkId: string, email: string): Session => ({ clerkId, profile: async () => ({ email, name: null }) });
const boss = () => sessionOf("user_boss", "boss@example.test");
const rep = () => sessionOf("user_rep", "rep@example.test");
const stranger = () => sessionOf("user_stranger", "stranger@other.test");

async function failureOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (error instanceof TRPCError) return error.message === error.code ? error.code : `${error.code}: ${error.message}`;
    throw error;
  }
}

/** A campaign whose research finished with `pack`. */
async function planned(session: Session = rep(), pack = completePack()) {
  await ensureUser(prisma, boss());
  const { id } = await caller(session).campaigns.create(startInput());
  const job = await prisma.job.findFirstOrThrow({ where: { campaignId: id } });
  await recordResearchCompleted(prisma, {
    orgId: job.orgId,
    jobId: job.id,
    runId: "run_test",
    pack: JSON.parse(JSON.stringify(pack)),
    report: {},
    facts: { product: "insights360", version: 2, hash: "test", draft: false },
    knowledge: { product: "insights360", version: 1, hash: "test" },
    partial: pack.partial,
    missingModules: [...pack.missingModules],
    outcome: pack.insufficient !== undefined ? "insufficient" : pack.partial ? "partial" : "complete",
    scope: JSON.parse(JSON.stringify(pack.scope ?? {})),
  });
  await prisma.job.update({ where: { id: job.id }, data: { status: "done" } });
  return { id, researchJob: job };
}

const runLeadGen = async (id: string) => {
  const job = await prisma.job.findFirstOrThrow({ where: { campaignId: id, kind: LEAD_GEN_JOB }, orderBy: { createdAt: "desc" } });
  await leadGenHandler({
    environment: (handoff) => ({ provider: sampleProvider(handoff), vocabulary: sampleVocabulary(handoff) }),
    crm: NO_CRM,
    pricing: DOCUMENTED_UNVERIFIED_PRICING,
    retry: { attempts: 1, wait: async () => {} },
  })({ db: prisma, job, signal: new AbortController().signal });
};

const runReveal = async (id: string) => {
  const job = await prisma.job.findFirstOrThrow({ where: { campaignId: id, kind: REVEAL_JOB } });
  await revealHandler({ revealer: () => new SampleRevealProvider(), crm: NO_CRM, pricing: DOCUMENTED_UNVERIFIED_PRICING, retry: { attempts: 1, wait: async () => {} } })({
    db: prisma,
    job,
    signal: new AbortController().signal,
  });
};

/** Confirmed, searched, two kept, and Reveal emails pressed: the reveal job is queued. */
async function revealing(session: Session = rep()) {
  const { id } = await planned(session);
  await caller(session).campaigns.confirm({ campaignId: id, fromBriefVersion: 1, requestId: crypto.randomUUID() });
  await runLeadGen(id);
  const kept = await prisma.campaignPerson.findMany({ where: { campaignId: id, status: "chosen" }, orderBy: { rank: "asc" }, take: 2 });
  for (const person of kept) await caller(session).campaigns.reviewPeople({ campaignId: id, briefVersion: 1, personId: person.id, scope: "person", decision: "kept" });
  const plan = (await caller(session).campaigns.get({ id })).peopleFound!.revealPlan!;
  await caller(session).campaigns.revealEmails({ campaignId: id, briefVersion: 1, requestId: crypto.randomUUID(), expected: { toReveal: plan.toReveal, known: plan.known, maxCredits: plan.maxCredits } });
  const revealJob = await prisma.job.findFirstOrThrow({ where: { campaignId: id, kind: REVEAL_JOB } });
  return { id, revealJob };
}

describe("every play research ranked, and choosing one", () => {
  it("@proof exposes every viable play, ranked, and confirms the rank-2 one the rep chose", async () => {
    const { id } = await planned();
    const before = await caller(rep()).campaigns.get({ id });
    expect(before.plays?.map((play) => play.rank)).toEqual([1, 2, 3]);
    expect(before.plays?.filter((play) => play.recommended)).toHaveLength(1);
    expect(before.facts?.research).toEqual({ outcome: "complete", plays: 3, viablePlays: 3 });
    const second = before.plays![1]!;

    expect(await caller(rep()).campaigns.confirm({ campaignId: id, fromBriefVersion: 1, requestId: crypto.randomUUID(), candidateId: second.id })).toEqual({ id });
    const confirm = await prisma.event.findFirstOrThrow({ where: { campaignId: id, kind: CAMPAIGN_CONFIRMED } });
    const after = confirm.after as { selection: string; handoff: { play: { id: string }; buyerGroup: { id: string; sourceRank: number }; targeting: unknown; buyerRoles: { part: string; title: string }[] } };
    expect(after.selection).toBe("chosen");
    expect(after.handoff.play.id).toBe(second.id);
    expect(after.handoff.buyerGroup).toMatchObject({ id: second.group.id, sourceRank: 2 });
    expect(after.handoff.targeting).toEqual({ ...leadgenRecipe(completePack(), second.group.id), locations: [] });
    expect(after.handoff.buyerRoles.map((role) => ({ part: role.part, title: role.title }))).toEqual(second.roles);

    const campaign = await caller(rep()).campaigns.get({ id });
    expect(campaign.facts?.confirmed).toEqual({ groupId: second.group.id, groupName: second.group.name, playId: second.id, sourceRank: 2 });
    expect(campaign.facts?.stage).toBe("finding_people");
  });

  it("@proof keeps rank 1 as the default when the rep names no play", async () => {
    const { id } = await planned();
    const top = (await caller(rep()).campaigns.get({ id })).plays![0]!;
    await caller(rep()).campaigns.confirm({ campaignId: id, fromBriefVersion: 1, requestId: crypto.randomUUID() });
    const after = (await prisma.event.findFirstOrThrow({ where: { campaignId: id, kind: CAMPAIGN_CONFIRMED } })).after as { selection: string; handoff: { play: { id: string }; buyerGroup: { sourceRank: number } } };
    expect(after).toMatchObject({ selection: "default", handoff: { play: { id: top.id }, buyerGroup: { sourceRank: 1 } } });
  });

  it("answers a repeated press for the same play as that press, and refuses the same press naming another play", async () => {
    const { id } = await planned();
    const [first, second] = (await caller(rep()).campaigns.get({ id })).plays!;
    const requestId = crypto.randomUUID();
    expect(await caller(rep()).campaigns.confirm({ campaignId: id, fromBriefVersion: 1, requestId, candidateId: second!.id })).toEqual({ id });
    expect(await caller(rep()).campaigns.confirm({ campaignId: id, fromBriefVersion: 1, requestId, candidateId: second!.id })).toEqual({ id });
    expect(await failureOf(caller(rep()).campaigns.confirm({ campaignId: id, fromBriefVersion: 1, requestId, candidateId: first!.id }))).toBe(`CONFLICT: ${campaignsCopy.changedSince}`);
    // Naming no play is a different choice from naming one, whichever play the default would be.
    expect(await failureOf(caller(rep()).campaigns.confirm({ campaignId: id, fromBriefVersion: 1, requestId }))).toBe(`CONFLICT: ${campaignsCopy.changedSince}`);
    expect(await prisma.job.count({ where: { campaignId: id, kind: LEAD_GEN_JOB } })).toBe(1);
  });

  it("answers a repeated default press as that press, and refuses the same press naming a play", async () => {
    const { id } = await planned();
    const second = (await caller(rep()).campaigns.get({ id })).plays![1]!;
    const requestId = crypto.randomUUID();
    expect(await caller(rep()).campaigns.confirm({ campaignId: id, fromBriefVersion: 1, requestId })).toEqual({ id });
    expect(await caller(rep()).campaigns.confirm({ campaignId: id, fromBriefVersion: 1, requestId })).toEqual({ id });
    expect(await failureOf(caller(rep()).campaigns.confirm({ campaignId: id, fromBriefVersion: 1, requestId, candidateId: second.id }))).toBe(`CONFLICT: ${campaignsCopy.changedSince}`);
    expect(await prisma.job.count({ where: { campaignId: id, kind: LEAD_GEN_JOB } })).toBe(1);
  });

  it("refuses a play the plan does not rank, truthfully, and starts nothing", async () => {
    const { id } = await planned();
    expect(await failureOf(caller(rep()).campaigns.confirm({ campaignId: id, fromBriefVersion: 1, requestId: crypto.randomUUID(), candidateId: "candidate-from-another-plan" }))).toBe(
      `BAD_REQUEST: ${campaignsCopy.confirmUnknownPlay}`,
    );
    expect(await prisma.job.count({ where: { campaignId: id, kind: LEAD_GEN_JOB } })).toBe(0);
    expect(await prisma.event.count({ where: { campaignId: id, kind: CAMPAIGN_CONFIRMED } })).toBe(0);
  });

  it("is never Plan ready on a partial pack with no play to search, and Confirm is neither offered nor accepted", async () => {
    const { id } = await planned(rep(), partialPack());
    const campaign = await caller(rep()).campaigns.get({ id });
    expect(campaign.facts).toMatchObject({ stage: "research_needs_you", attention: { reason: "no_play" }, research: { viablePlays: 0 } });
    expect(campaign.can.confirm).toBe(false);
    expect(campaign.plays).toEqual([]);
    expect(await failureOf(caller(rep()).campaigns.confirm({ campaignId: id, fromBriefVersion: 1, requestId: crypto.randomUUID() }))).toBe(`BAD_REQUEST: ${campaignsCopy.confirmNoGroup}`);
  });
});

describe("the actions the page offers are the ones the server accepts", () => {
  it("@proof blocks Edit brief on the server while a reveal is queued or running, and allows it once the reveal is done", async () => {
    const { id, revealJob } = await revealing();
    const brief = startInput().brief;
    const edit = () => caller(rep()).campaigns.editBrief({ campaignId: id, fromBriefVersion: 1, requestId: crypto.randomUUID(), brief: { ...brief, weeks: brief.weeks + 1 } });

    expect((await caller(rep()).campaigns.get({ id })).can.edit).toBe(false);
    expect(await failureOf(edit())).toBe(`CONFLICT: ${campaignsCopy.changedSince}`);
    await prisma.job.update({ where: { id: revealJob.id }, data: { status: "running" } });
    expect(await failureOf(edit())).toBe(`CONFLICT: ${campaignsCopy.changedSince}`);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id } })).briefVersion).toBe(1);

    await prisma.job.update({ where: { id: revealJob.id }, data: { status: "queued" } });
    await runReveal(id);
    expect((await caller(rep()).campaigns.get({ id })).can.edit).toBe(true);
    expect(await edit()).toEqual({ id });
  });

  it("@proof retries a reveal that failed before any request left Relay, once, and reveals", async () => {
    const { id, revealJob } = await revealing();
    await prisma.job.update({ where: { id: revealJob.id }, data: { status: "failed", error: "sample: the provider did not answer" } });

    const stopped = await caller(rep()).campaigns.get({ id });
    expect(stopped.facts).toMatchObject({ stage: "reveal_needs_you", attention: { kind: "needs_you", reason: "reveal_failed", retryable: true }, nextAction: "retry_reveal" });
    expect(stopped).toMatchObject({ state: "revealing", chip: campaignsCopy.chipNeedsYou, next: campaignsCopy.nextRevealNeedsYou, nextIsAction: true });
    expect(stopped.can.retryReveal).toBe(true);
    expect(stopped.activity?.some((entry) => entry.kind === "reveal_confirmed")).toBe(true);

    const requestId = crypto.randomUUID();
    expect(await caller(rep()).campaigns.retryReveal({ campaignId: id, briefVersion: 1, requestId })).toEqual({ id });
    expect(await caller(rep()).campaigns.retryReveal({ campaignId: id, briefVersion: 1, requestId })).toEqual({ id });
    expect(await prisma.event.count({ where: { campaignId: id, kind: "campaign.reveal_retried" } })).toBe(1);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: revealJob.id } })).status).toBe("queued");
    expect(await prisma.job.count({ where: { campaignId: id, kind: REVEAL_JOB } })).toBe(1);

    await runReveal(id);
    const ready = await caller(rep()).campaigns.get({ id });
    expect(ready.facts?.stage).toBe("people_ready");
    expect(ready.facts?.reveal?.emailsReady).toBe(2);
  });

  it("@proof never retries a reveal whose request may have reached the provider: its spend is held and the reason is said", async () => {
    const { id, revealJob } = await revealing();
    const approval = await prisma.event.findFirstOrThrow({ where: { campaignId: id, kind: CAMPAIGN_REVEAL_CONFIRMED } });
    await prisma.creditLedgerEntry.create({
      data: { orgId: revealJob.orgId, campaignId: id, briefVersion: 1, confirmEventId: approval.id, jobId: revealJob.id, kind: "reveal", key: "test:reveal:b1", worstCase: 2, state: "unreconciled" },
    });
    await prisma.job.update({ where: { id: revealJob.id }, data: { status: "failed", error: "sample: lost the answer" } });

    const campaign = await caller(rep()).campaigns.get({ id });
    expect(campaign.facts).toMatchObject({ stage: "reveal_needs_you", attention: { reason: "reveal_spend_unresolved", retryable: false }, nextAction: "edit_brief" });
    expect(campaign.can).toMatchObject({ retryReveal: false, edit: true });
    expect(campaign.facts?.spend.reveal).toEqual({ max: 2, charged: 0, held: 2 });
    expect(campaign.facts?.attention?.reason).toBe("reveal_spend_unresolved");
    expect(await failureOf(caller(rep()).campaigns.retryReveal({ campaignId: id, briefVersion: 1, requestId: crypto.randomUUID() }))).toBe(`CONFLICT: ${campaignsCopy.changedSince}`);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: revealJob.id } })).status).toBe("failed");
  });

  it("offers Try again on a cancelled search and runs it; never on a terminal one, which the server refuses too", async () => {
    const { id } = await planned();
    await caller(rep()).campaigns.confirm({ campaignId: id, fromBriefVersion: 1, requestId: crypto.randomUUID() });
    const job = await prisma.job.findFirstOrThrow({ where: { campaignId: id, kind: LEAD_GEN_JOB } });

    await prisma.job.update({ where: { id: job.id }, data: { status: "cancelled" } });
    const cancelled = await caller(rep()).campaigns.get({ id });
    expect(cancelled.can.retryPeople).toBe(true);
    expect(cancelled.facts?.nextAction).toBe("retry_people");
    expect(await caller(rep()).campaigns.retryPeople({ campaignId: id, briefVersion: 1, requestId: crypto.randomUUID() })).toEqual({ id });
    expect(await prisma.job.count({ where: { campaignId: id, kind: LEAD_GEN_JOB } })).toBe(2);

    const rerun = await prisma.job.findFirstOrThrow({ where: { campaignId: id, kind: LEAD_GEN_JOB }, orderBy: { createdAt: "desc" } });
    await prisma.job.update({ where: { id: rerun.id }, data: { status: "failed", error: "lead gen: no people provider is set up" } });
    const terminal = await caller(rep()).campaigns.get({ id });
    expect(terminal.can.retryPeople).toBe(false);
    expect(terminal.facts).toMatchObject({ stage: "people_needs_you", attention: { retryable: false }, nextAction: "edit_brief" });
    expect(await failureOf(caller(rep()).campaigns.retryPeople({ campaignId: id, briefVersion: 1, requestId: crypto.randomUUID() }))).toBe(`CONFLICT: ${campaignsCopy.changedSince}`);
  });

  it("offers no Try again on cancelled research, and the server takes none", async () => {
    await ensureUser(prisma, boss());
    const { id } = await caller(rep()).campaigns.create(startInput());
    await prisma.job.updateMany({ where: { campaignId: id }, data: { status: "cancelled" } });
    const campaign = await caller(rep()).campaigns.get({ id });
    expect(campaign.can).toMatchObject({ retry: false, edit: true });
    expect(campaign.facts?.nextAction).toBe("edit_brief");
    expect(await failureOf(caller(rep()).campaigns.retry({ campaignId: id, briefVersion: 1, requestId: crypto.randomUUID() }))).toBe(`CONFLICT: ${campaignsCopy.changedSince}`);
  });
});

describe("the campaign summary", () => {
  it("@proof counts people, emails, and search, reveal and research spend apart, the same on the list as on the page", async () => {
    const { id, researchJob } = await planned();
    const run = await prisma.agentRun.create({ data: { orgId: researchJob.orgId, jobId: researchJob.id, kind: "research", model: "claude-opus-5", status: "done", costTotal: "1.25" } });
    await prisma.agentRunStep.createMany({
      data: [
        { orgId: researchJob.orgId, runId: run.id, index: 0, kind: "model", name: "claude-opus-5", cost: "1.000000" },
        { orgId: researchJob.orgId, runId: run.id, index: 1, kind: "model", name: "claude-opus-5", cost: "0.250000" },
      ],
    });
    await caller(rep()).campaigns.confirm({ campaignId: id, fromBriefVersion: 1, requestId: crypto.randomUUID() });
    await runLeadGen(id);
    const chosen = await prisma.campaignPerson.findMany({ where: { campaignId: id, status: "chosen" }, orderBy: { rank: "asc" } });
    for (const person of chosen.slice(0, 2)) await caller(rep()).campaigns.reviewPeople({ campaignId: id, briefVersion: 1, personId: person.id, scope: "person", decision: "kept" });
    await caller(rep()).campaigns.reviewPeople({ campaignId: id, briefVersion: 1, personId: chosen[2]!.id, scope: "person", decision: "dropped" });

    const reviewing = (await caller(rep()).campaigns.list()).campaigns.find((c) => c.id === id)!.facts!;
    expect(reviewing.stage).toBe("reviewing_people");
    expect(reviewing.nextAction).toBe("review_people");
    expect(reviewing.people).toMatchObject({ chosen: chosen.length, kept: 2, dropped: 1, pending: chosen.length - 3 });
    expect(reviewing.people!.accounts).toBe(new Set(chosen.map((person) => person.companyKey)).size);

    const plan = (await caller(rep()).campaigns.get({ id })).peopleFound!.revealPlan!;
    await caller(rep()).campaigns.revealEmails({ campaignId: id, briefVersion: 1, requestId: crypto.randomUUID(), expected: { toReveal: plan.toReveal, known: plan.known, maxCredits: plan.maxCredits } });
    await runReveal(id);

    const page = await caller(rep()).campaigns.get({ id });
    const row = (await caller(rep()).campaigns.list()).campaigns.find((c) => c.id === id)!;
    expect(row.facts).toEqual(page.facts);
    const facts = page.facts!;
    expect(facts.stage).toBe("people_ready");
    expect(facts.reveal).toMatchObject({ revealed: 2, emailsReady: 2 });
    expect(facts.spend.search.charged).toBeGreaterThan(0);
    expect(facts.spend.search.cap).toBeGreaterThan(0);
    expect(facts.spend.reveal).toEqual({ max: plan.maxCredits, charged: 2, held: 0 });
    expect(facts.spend.allVersions.revealCharged).toBe(2);
    expect(facts.spend.research).toEqual({ usd: 1.25, usdThisVersion: 1.25 });
    // The activity records the reveal as what came back, newest first, with who confirmed it.
    const kinds = page.activity?.map((entry) => entry.kind) ?? [];
    expect(kinds[0]).toBe("revealed");
    expect(kinds).toContain("reveal_confirmed");
    expect(kinds).toContain("confirmed");
    expect(kinds).toContain("created");
    expect(page.activity?.[0]?.actor.kind).toBe("relay");
  });

  it("@proof lists only the rep's own campaigns, in a fixed number of queries however many there are, with nothing org-wide read", async () => {
    await planned(stranger());
    const { id: first } = await planned();
    const owner = await prisma.user.findFirstOrThrow({ where: { email: "rep@example.test" } });
    const statements: string[] = [];
    const counting = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } }, log: [{ emit: "event", level: "query" }] });
    counting.$on("query", (event) => statements.push(event.query));
    try {
      await campaignSummariesForOwner(counting, { orgId: owner.orgId, userId: owner.id }, { leadGenAvailable: true });
      const withOne = statements.length;

      // More campaigns, in more states: researching, confirmed and searched, and a stop-free plan.
      await caller(rep()).campaigns.create(startInput());
      await caller(rep()).campaigns.confirm({ campaignId: first, fromBriefVersion: 1, requestId: crypto.randomUUID() });
      await runLeadGen(first);
      await planned();
      await planned();
      statements.length = 0;
      const rows = await campaignSummariesForOwner(counting, { orgId: owner.orgId, userId: owner.id }, { leadGenAvailable: true });
      expect(rows).toHaveLength(4);
      // One more query at most: the candidates' grouped counts, once any search has picked people.
      expect(statements.length).toBeLessThanOrEqual(withOne + 1);
      expect(statements.join("\n")).not.toMatch(/"people"|"provider_identities"|"contact_suppressions"/);
    } finally {
      await counting.$disconnect();
    }

    const mine = await caller(rep()).campaigns.list();
    expect(mine.campaigns).toHaveLength(4);
    expect(mine.campaigns.every((row) => row.facts !== undefined)).toBe(true);
    expect((await caller(stranger()).campaigns.list()).campaigns).toHaveLength(1);
    expect((await caller(boss()).campaigns.list()).campaigns).toEqual([]);
  });
});
