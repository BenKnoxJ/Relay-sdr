import { TRPCError } from "@trpc/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { campaignsCopy } from "@/lib/copy/campaigns";
import { prisma } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { LEAD_GEN_JOB } from "@/lib/repo/leadgen";
import { recordResearchCompleted } from "@/lib/repo/research";
import { appRouter } from "@/server/api/root";
import { type TRPCContext } from "@/server/api/trpc";
import { type Session } from "@/server/auth/session";
import { ensureUser, type Actor } from "@/server/auth/upsertUser";

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
