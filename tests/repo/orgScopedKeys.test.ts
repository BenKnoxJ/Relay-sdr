import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db";

import { emptyAll, resetDatabase } from "../db/harness";

// Master doc §25, rule 3, read from the database rather than from the schema
// file. `tests/db/migrate.test.ts` proves the indexes are shaped right; this
// proves what that shape buys — one tenant's key never answers for another's.
//
// Written against Prisma directly, not through `mutate`: the subject is a
// constraint, and putting a transaction and an Event between the test and the
// insert would only give the failure somewhere else to come from.

const ORG_A = "org_scoped_a";
const ORG_B = "org_scoped_b";
const TOOL_KEY = "send:touch-1:person-42";

beforeAll(async () => {
  await resetDatabase();
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

/** An org with a job and a run under it, ready for a step. */
async function seedRun(orgId: string): Promise<string> {
  await prisma.org.create({ data: { id: orgId, name: orgId } });
  const job = await prisma.job.create({
    data: { orgId, kind: "send", idempotencyKey: "touch-1", input: {} },
  });
  const run = await prisma.agentRun.create({
    data: { orgId, jobId: job.id, kind: "send", model: "claude-opus-5" },
  });
  return run.id;
}

async function addStep(orgId: string, runId: string, index: number, toolKey: string | null) {
  return prisma.agentRunStep.create({
    data: { orgId, runId, index, kind: "tool", name: "send_email", toolKey },
  });
}

describe("org-scoped tool keys", () => {
  let runA = "";
  let runB = "";

  beforeEach(async () => {
    await emptyAll();
    runA = await seedRun(ORG_A);
    runB = await seedRun(ORG_B);
  });

  it("@proof lets two orgs use the same toolKey", async () => {
    await addStep(ORG_A, runA, 0, TOOL_KEY);
    await addStep(ORG_B, runB, 0, TOOL_KEY);

    const steps = await prisma.agentRunStep.findMany({ where: { toolKey: TOOL_KEY } });
    expect(steps.map((step) => step.orgId).sort()).toEqual([ORG_A, ORG_B]);
  });

  it("@proof still refuses the same toolKey twice inside one org", async () => {
    await addStep(ORG_A, runA, 0, TOOL_KEY);

    // The retry the key exists to stop: the same tool call, a second time, in
    // the org that already made it.
    await expect(addStep(ORG_A, runA, 1, TOOL_KEY)).rejects.toMatchObject({ code: "P2002" });

    expect(await prisma.agentRunStep.count({ where: { orgId: ORG_A } })).toBe(1);
  });

  it("leaves model steps, which carry no toolKey, alone", async () => {
    // Two nulls are not equal to each other in a Postgres unique index, which
    // is what makes a nullable idempotency key workable at all.
    await addStep(ORG_A, runA, 0, null);
    await addStep(ORG_A, runA, 1, null);

    expect(await prisma.agentRunStep.count({ where: { toolKey: null } })).toBe(2);
  });
});
