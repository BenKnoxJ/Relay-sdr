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
import { completePack, startInput } from "../lib/campaignPacks";

/**
 * Confirm plan through the real router: the rep's own campaign only, the
 * org and owner from the session, and an honest refusal where finding people
 * is not set up. The sample setup is switched on by environment, as a
 * developer would; nothing reaches a provider.
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
  delete process.env.RELAY_LEADGEN_PROVIDER;
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

async function planned() {
  await ensureUser(prisma, boss());
  const { id } = await caller(rep()).campaigns.create(startInput());
  const job = await prisma.job.findFirstOrThrow({ where: { campaignId: id } });
  const pack = completePack();
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
    outcome: "complete",
    scope: JSON.parse(JSON.stringify(pack.scope ?? {})),
  });
  await prisma.job.update({ where: { id: job.id }, data: { status: "done" } });
  return id;
}

async function failureOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (error instanceof TRPCError) return error.message === error.code ? error.code : `${error.code}: ${error.message}`;
    throw error;
  }
}

describe("campaigns.confirm", () => {
  it("refuses honestly where finding people is not set up, and shows Confirm as not pressable", async () => {
    const id = await planned();
    const campaign = await caller(rep()).campaigns.get({ id });
    expect(campaign.can.confirm).toBe(false);
    expect(campaign.confirmPlan).toMatchObject({ available: false, searchCreditCap: null, sample: false });
    expect(await failureOf(caller(rep()).campaigns.confirm({ campaignId: id, fromBriefVersion: 1, requestId: crypto.randomUUID() }))).toBe(
      `BAD_REQUEST: ${campaignsCopy.confirmNotAvailable}`,
    );
    expect(await prisma.job.count({ where: { kind: LEAD_GEN_JOB } })).toBe(0);
  });

  it("@proof confirms the rep's own campaign once, with the sample setup switched on", async () => {
    process.env.RELAY_LEADGEN_PROVIDER = "sample";
    resetEnv();
    const id = await planned();
    const before = await caller(rep()).campaigns.get({ id });
    expect(before.can.confirm).toBe(true);
    expect(before.confirmPlan).toMatchObject({ available: true, sample: true });

    const requestId = crypto.randomUUID();
    expect(await caller(rep()).campaigns.confirm({ campaignId: id, fromBriefVersion: 1, requestId })).toEqual({ id });
    expect(await caller(rep()).campaigns.confirm({ campaignId: id, fromBriefVersion: 1, requestId })).toEqual({ id });
    expect(await prisma.job.count({ where: { campaignId: id, kind: LEAD_GEN_JOB } })).toBe(1);
    expect((await caller(rep()).campaigns.get({ id })).state).toBe("findingPeople");
  });

  it("@proof answers another rep, and another org, as if the campaign were not there", async () => {
    process.env.RELAY_LEADGEN_PROVIDER = "sample";
    resetEnv();
    const id = await planned();
    for (const session of [colleague(), stranger()]) {
      expect(await failureOf(caller(session).campaigns.confirm({ campaignId: id, fromBriefVersion: 1, requestId: crypto.randomUUID() }))).toBe("NOT_FOUND");
    }
    expect(await prisma.job.count({ where: { kind: LEAD_GEN_JOB } })).toBe(0);
  });
});

describe("campaigns.reviewPeople", () => {
  /** A confirmed campaign whose sample search has run: Reviewing people, with every person pending. */
  async function found() {
    process.env.RELAY_LEADGEN_PROVIDER = "sample";
    resetEnv();
    const id = await planned();
    await caller(rep()).campaigns.confirm({ campaignId: id, fromBriefVersion: 1, requestId: crypto.randomUUID() });
    const job = await prisma.job.findFirstOrThrow({ where: { campaignId: id, kind: LEAD_GEN_JOB } });
    await leadGenHandler({
      environment: (handoff) => ({ provider: sampleProvider(handoff), vocabulary: sampleVocabulary(handoff) }),
      crm: NO_CRM,
      pricing: DOCUMENTED_UNVERIFIED_PRICING,
      retry: { attempts: 1, wait: async () => {} },
    })({ db: prisma, job, signal: new AbortController().signal });
    const people = await prisma.campaignPerson.findMany({ where: { campaignId: id, status: "chosen" }, orderBy: { rank: "asc" } });
    return { id, person: people[0]!, people };
  }

  it("@proof keeps a person for the rep who owns the campaign, through the router", async () => {
    const { id, person } = await found();
    expect(await caller(rep()).campaigns.reviewPeople({ campaignId: id, briefVersion: 1, personId: person.id, scope: "person", decision: "kept" })).toEqual({ id });
    expect((await prisma.campaignPerson.findUniqueOrThrow({ where: { id: person.id } })).review).toBe("kept");
    expect((await caller(rep()).campaigns.get({ id })).peopleFound?.review.kept).toBe(1);
  });

  it("@proof answers another rep in the org, and another org, as if the campaign were not there", async () => {
    const { id, person } = await found();
    for (const session of [colleague(), stranger()]) {
      expect(await failureOf(caller(session).campaigns.reviewPeople({ campaignId: id, briefVersion: 1, personId: person.id, scope: "account", decision: "dropped" }))).toBe("NOT_FOUND");
    }
    expect(await prisma.campaignPerson.count({ where: { campaignId: id, review: { not: "pending" } } })).toBe(0);
  });

  it("@proof reveals the kept people's emails through the router, once, and answers nobody else", async () => {
    const { id } = await found();
    const kept = await prisma.campaignPerson.findMany({ where: { campaignId: id, status: "chosen" }, orderBy: { rank: "asc" }, take: 2 });
    for (const person of kept) await caller(rep()).campaigns.reviewPeople({ campaignId: id, briefVersion: 1, personId: person.id, scope: "person", decision: "kept" });
    const before = await caller(rep()).campaigns.get({ id });
    expect(before.can.reveal).toBe(true);
    const plan = before.peopleFound!.revealPlan!;
    expect(plan).toMatchObject({ kept: 2, toReveal: 2, maxCredits: 2 });
    const expected = { toReveal: plan.toReveal, known: plan.known, maxCredits: plan.maxCredits };

    for (const session of [colleague(), stranger()]) {
      expect(await failureOf(caller(session).campaigns.revealEmails({ campaignId: id, briefVersion: 1, requestId: crypto.randomUUID(), expected }))).toBe("NOT_FOUND");
    }
    expect(await failureOf(caller(rep()).campaigns.revealEmails({ campaignId: id, briefVersion: 1, requestId: crypto.randomUUID(), expected: { ...expected, maxCredits: 1 } }))).toBe(
      `CONFLICT: ${campaignsCopy.revealChanged}`,
    );
    const extra = { campaignId: id, briefVersion: 1, requestId: crypto.randomUUID(), expected, orgId: "someone-else" } as unknown as Parameters<ReturnType<typeof caller>["campaigns"]["revealEmails"]>[0];
    expect(await failureOf(caller(rep()).campaigns.revealEmails(extra))).toMatch(/^BAD_REQUEST/);
    expect(await prisma.job.count({ where: { kind: REVEAL_JOB } })).toBe(0);

    const requestId = crypto.randomUUID();
    expect(await caller(rep()).campaigns.revealEmails({ campaignId: id, briefVersion: 1, requestId, expected })).toEqual({ id });
    expect(await caller(rep()).campaigns.revealEmails({ campaignId: id, briefVersion: 1, requestId, expected })).toEqual({ id });
    expect(await prisma.job.count({ where: { kind: REVEAL_JOB } })).toBe(1);
    expect((await caller(rep()).campaigns.get({ id })).state).toBe("revealing");

    const job = await prisma.job.findFirstOrThrow({ where: { campaignId: id, kind: REVEAL_JOB } });
    await revealHandler({ revealer: () => new SampleRevealProvider(), crm: NO_CRM, pricing: DOCUMENTED_UNVERIFIED_PRICING, retry: { attempts: 1, wait: async () => {} } })({ db: prisma, job, signal: new AbortController().signal });
    const after = await caller(rep()).campaigns.get({ id });
    expect(after.state).toBe("peopleReady");
    expect(after.peopleFound!.accounts.flatMap((account) => account.people).map((person) => person.email)).toEqual(kept.map((person) => `sample.person.${Number(person.providerId.slice(7))}@sample-firm-${Math.ceil(Number(person.providerId.slice(7)) / 2)}.example`));
  });

  it("refuses a stale page and input it does not take", async () => {
    const { id, person } = await found();
    expect(await failureOf(caller(rep()).campaigns.reviewPeople({ campaignId: id, briefVersion: 2, personId: person.id, scope: "person", decision: "kept" }))).toBe(
      `BAD_REQUEST: ${campaignsCopy.cannotChange}`,
    );
    const extra = { campaignId: id, briefVersion: 1, personId: person.id, scope: "person", decision: "kept", orgId: "someone-else" } as unknown as Parameters<ReturnType<typeof caller>["campaigns"]["reviewPeople"]>[0];
    expect(await failureOf(caller(rep()).campaigns.reviewPeople(extra))).toMatch(/^BAD_REQUEST/);
  });

  it("keeps the ticked people across accounts in one change and one Event, and refuses an empty selection", async () => {
    const { id, people } = await found();
    const ticked = people.slice(0, 3);
    expect(await caller(rep()).campaigns.reviewPeople({ campaignId: id, briefVersion: 1, personId: ticked[0]!.id, scope: "selected", personIds: ticked.map((person) => person.id), decision: "kept" })).toEqual({ id });
    const rows = await prisma.campaignPerson.findMany({ where: { campaignId: id, status: "chosen" }, orderBy: { rank: "asc" } });
    expect(rows.filter((row) => row.review === "kept").map((row) => row.id).sort()).toEqual(ticked.map((person) => person.id).sort());
    const events = await prisma.event.findMany({ where: { campaignId: id, kind: "campaign.people_reviewed" } });
    expect(events).toHaveLength(1);
    expect((events[0]?.after as { people: string[]; scope: string }).people).toHaveLength(3);
    expect((events[0]?.after as { scope: string }).scope).toBe("selected");
    expect(await failureOf(caller(rep()).campaigns.reviewPeople({ campaignId: id, briefVersion: 1, personId: ticked[0]!.id, scope: "selected", personIds: [], decision: "kept" }))).toMatch(/^BAD_REQUEST/);
  });

});
