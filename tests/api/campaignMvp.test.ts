import { TRPCError } from "@trpc/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { campaignsCopy } from "@/lib/copy/campaigns";
import { prisma } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { NO_CRM } from "@/lib/leadgen/crm";
import { SampleRevealProvider, sampleProvider, sampleVocabulary } from "@/lib/leadgen/sample";
import { DOCUMENTED_UNVERIFIED_PRICING } from "@/lib/leadgen/spend";
import { LEAD_GEN_JOB, REVEAL_JOB } from "@/lib/repo/leadgen";
import { recordResearchCompleted } from "@/lib/repo/research";
import { appRouter } from "@/server/api/root";
import { type TRPCContext } from "@/server/api/trpc";
import { type Session } from "@/server/auth/session";
import { ensureUser, type Actor } from "@/server/auth/upsertUser";
import { leadGenHandler } from "@/worker/handlers/leadGen";
import { revealHandler } from "@/worker/handlers/reveal";

import { emptyAll, resetDatabase } from "../db/harness";
import { completePack, startInput, stoppedPack } from "../lib/campaignPacks";

/**
 * The campaign app's last backend pieces, through the real router: the page
 * no longer carries the research pack except on a stop, Finding people says
 * what the frozen search is, accounts needing review come first, and the
 * campaign's activity reads from its Events. Sample people and credits only.
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
const colleague = () => sessionOf("user_colleague", "colleague@example.test");
const stranger = () => sessionOf("user_stranger", "stranger@other.test");

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (error instanceof TRPCError) return error.code;
    throw error;
  }
}

async function planned(pack = completePack()) {
  await ensureUser(prisma, boss());
  const { id } = await caller(rep()).campaigns.create(startInput());
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
  return id;
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

describe("the campaign view's weight", () => {
  it("@proof sends no research pack for a plan or anything after it, and still sends a stop what it needs", async () => {
    const id = await planned();
    const plan = await caller(rep()).campaigns.get({ id });
    expect(plan.state).toBe("planReady");
    expect(plan.pack).toBeNull();
    expect(plan.overview).not.toBeNull();
    expect(plan.plays).toHaveLength(3);
    // PR #34's truth is unchanged.
    expect(plan.facts).toMatchObject({ stage: "plan_ready", nextAction: "confirm", research: { viablePlays: 3 } });

    await caller(rep()).campaigns.confirm({ campaignId: id, fromBriefVersion: 1, requestId: crypto.randomUUID() });
    await runLeadGen(id);
    expect((await caller(rep()).campaigns.get({ id })).pack).toBeNull();

    const stopped = await planned(stoppedPack());
    const stop = await caller(rep()).campaigns.get({ id: stopped });
    expect(stop.state).toBe("stopped");
    expect(stop.pack?.insufficient?.widenings.length).toBeGreaterThan(0);
    expect(stop.pack?.stopEvidence?.length).toBeGreaterThan(0);
  });
});

describe("Finding people, while it runs", () => {
  it("@proof says what the frozen search is: its line, the roles, the seed firms, when it was queued and the credits so far", async () => {
    const id = await planned();
    const before = await caller(rep()).campaigns.get({ id });
    expect(before.finding).toBeNull();
    await caller(rep()).campaigns.confirm({ campaignId: id, fromBriefVersion: 1, requestId: crypto.randomUUID() });

    const finding = await caller(rep()).campaigns.get({ id });
    expect(finding.facts?.stage).toBe("finding_people");
    const job = await prisma.job.findFirstOrThrow({ where: { campaignId: id, kind: LEAD_GEN_JOB } });
    const top = before.plays![0]!;
    expect(finding.finding).toMatchObject({ groupName: top.group.name, seedFirms: top.groupSeedFirms, since: job.createdAt.toISOString(), credits: { charged: 0, held: 0 } });
    expect(finding.finding!.search.startsWith(campaignsCopy.accountFitSearch)).toBe(true);
    expect(finding.finding!.buyerRoles.map((role) => ({ part: role.part, title: role.title })).sort((a, b) => a.part.localeCompare(b.part))).toEqual(
      [...top.roles].sort((a, b) => a.part.localeCompare(b.part)),
    );
    expect(finding.finding!.credits.cap).toBeGreaterThan(0);

    await runLeadGen(id);
    expect((await caller(rep()).campaigns.get({ id })).finding).toBeNull();
  });
});

describe("Reviewing people, pending first", () => {
  it("@proof lists accounts that still need the rep first, then kept, then dropped, in Relay's order inside each", async () => {
    const id = await planned();
    await caller(rep()).campaigns.confirm({ campaignId: id, fromBriefVersion: 1, requestId: crypto.randomUUID() });
    await runLeadGen(id);
    const original = (await caller(rep()).campaigns.get({ id })).peopleFound!.accounts;
    expect(original.length).toBeGreaterThanOrEqual(3);
    const [first, second] = original;
    await caller(rep()).campaigns.reviewPeople({ campaignId: id, briefVersion: 1, personId: first!.personId, scope: "account", decision: "dropped" });
    await caller(rep()).campaigns.reviewPeople({ campaignId: id, briefVersion: 1, personId: second!.personId, scope: "account", decision: "kept" });

    const accounts = (await caller(rep()).campaigns.get({ id })).peopleFound!.accounts;
    const pending = original.slice(2).map((account) => account.personId);
    expect(accounts.map((account) => account.personId)).toEqual([...pending, second!.personId, first!.personId]);
    // Ranking and selection are unchanged: the same people, the same ranks.
    expect(accounts.flatMap((account) => account.people.map((person) => `${person.id}:${person.rank}`)).sort()).toEqual(
      original.flatMap((account) => account.people.map((person) => `${person.id}:${person.rank}`)).sort(),
    );
  });
});

describe("campaigns.activity", () => {
  it("@proof reads the campaign's Events newest first, in a rep's words, with who did it, and no research text", async () => {
    const id = await planned();
    await caller(rep()).campaigns.confirm({ campaignId: id, fromBriefVersion: 1, requestId: crypto.randomUUID() });
    await runLeadGen(id);
    const people = await prisma.campaignPerson.findMany({ where: { campaignId: id, status: "chosen" }, orderBy: { rank: "asc" }, take: 2 });
    for (const person of people) await caller(rep()).campaigns.reviewPeople({ campaignId: id, briefVersion: 1, personId: person.id, scope: "person", decision: "kept" });
    const plan = (await caller(rep()).campaigns.get({ id })).peopleFound!.revealPlan!;
    await caller(rep()).campaigns.revealEmails({ campaignId: id, briefVersion: 1, requestId: crypto.randomUUID(), expected: { toReveal: plan.toReveal, known: plan.known, maxCredits: plan.maxCredits } });
    const revealJob = await prisma.job.findFirstOrThrow({ where: { campaignId: id, kind: REVEAL_JOB } });
    await revealHandler({ revealer: () => new SampleRevealProvider(), crm: NO_CRM, pricing: DOCUMENTED_UNVERIFIED_PRICING, retry: { attempts: 1, wait: async () => {} } })({
      db: prisma,
      job: revealJob,
      signal: new AbortController().signal,
    });

    const { entries } = await caller(rep()).campaigns.activity({ id });
    expect(entries.map((entry) => entry.kind)).toEqual(["revealed", "reveal_confirmed", "people_reviewed", "people_reviewed", "people_found", "confirmed", "research_done", "created"]);
    const at = entries.map((entry) => entry.at);
    expect([...at].sort().reverse()).toEqual(at);
    const byKind = Object.fromEntries(entries.map((entry) => [entry.kind, entry]));
    expect(byKind.created).toMatchObject({ actor: { kind: "you" }, line: campaignsCopy.activityCreated });
    expect(byKind.research_done).toMatchObject({ actor: { kind: "relay" }, line: campaignsCopy.activityResearchComplete });
    const group = (await caller(rep()).campaigns.get({ id })).facts!.confirmed!.groupName;
    expect(byKind.confirmed!.line).toBe(`${campaignsCopy.activityConfirmed} ${group}. ${campaignsCopy.lawfulBasisConfirmed}.`);
    expect(byKind.people_reviewed!.line).toBe(`${campaignsCopy.activityKept} 1 ${campaignsCopy.activityPerson}`);
    expect(byKind.reveal_confirmed!.line).toBe(`${campaignsCopy.activityRevealApproved} 2 ${campaignsCopy.activityEmails}, ${campaignsCopy.activityUpTo} ${plan.maxCredits} ${campaignsCopy.activityCredits}`);
    expect(byKind.revealed!.line).toBe(`${campaignsCopy.activityRevealed} 2 ${campaignsCopy.activityReady}, 2 ${campaignsCopy.activityCreditsUsed}`);
    // Nothing from the pack, the handoff or the candidates rides along.
    const wire = JSON.stringify(entries);
    const pack = JSON.stringify(completePack());
    expect(wire).not.toContain("evidence");
    expect(wire).not.toMatch(/sample\.person|@sample-firm/);
    expect(pack.length).toBeGreaterThan(wire.length * 10);

    expect((await caller(rep()).campaigns.activity({ id, limit: 3 })).entries.map((entry) => entry.kind)).toEqual(["revealed", "reveal_confirmed", "people_reviewed"]);
  });

  it("@proof answers only the campaign's owner: another rep and another org get NOT_FOUND", async () => {
    const id = await planned();
    expect(await codeOf(caller(colleague()).campaigns.activity({ id }))).toBe("NOT_FOUND");
    expect(await codeOf(caller(stranger()).campaigns.activity({ id }))).toBe("NOT_FOUND");
    expect(await codeOf(caller(rep()).campaigns.activity({ id: "not-a-campaign" }))).toBe("NOT_FOUND");
    expect(await codeOf(caller(rep()).campaigns.activity({ id, limit: 51 }))).toBe("BAD_REQUEST");
  });

  it("says a chosen play, a widening and an edit apart", async () => {
    const id = await planned();
    const second = (await caller(rep()).campaigns.get({ id })).plays![1]!;
    await caller(rep()).campaigns.confirm({ campaignId: id, fromBriefVersion: 1, requestId: crypto.randomUUID(), candidateId: second.id });
    const confirmed = (await caller(rep()).campaigns.activity({ id })).entries.find((entry) => entry.kind === "confirmed")!;
    expect(confirmed.line).toBe(`${campaignsCopy.activityConfirmedChosen} ${second.group.name}. ${campaignsCopy.lawfulBasisConfirmed}.`);

    const stopped = await planned(stoppedPack());
    const option = (await caller(rep()).campaigns.get({ id: stopped })).widenings!.findIndex((choice) => choice.usable);
    await caller(rep()).campaigns.widen({ campaignId: stopped, fromBriefVersion: 1, optionIndex: option, requestId: crypto.randomUUID() });
    const entries = (await caller(rep()).campaigns.activity({ id: stopped })).entries;
    expect(entries[0]).toMatchObject({ kind: "brief_changed", line: `${campaignsCopy.activityBriefWidened} 2` });
    expect(entries.find((entry) => entry.kind === "research_done")?.line).toBe(campaignsCopy.activityResearchStopped);
  });
});

describe("activity lines, from the words alone", () => {
  it("says a Confirm whose group could not be read in its own words, not by trimming another line", async () => {
    const { activityOf } = await import("@/lib/campaigns/activity");
    const [entry] = activityOf([{ id: "e1", kind: "campaign.confirmed", at: new Date("2026-09-15T12:00:00Z"), actorKind: "user", actorUserId: "u1", actorName: "Sam Rep", projection: { group: null } }], "u2");
    expect(entry).toMatchObject({ kind: "confirmed", actor: { kind: "person", name: "Sam" }, line: `${campaignsCopy.activityConfirmedNoGroup}. ${campaignsCopy.lawfulBasisConfirmed}.` });
  });
});
