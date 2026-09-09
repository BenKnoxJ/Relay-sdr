import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db";
import {
  beginToolStep,
  failToolStep,
  finishRun,
  finishToolStep,
  listSteps,
  startRun,
} from "@/lib/repo/agentRuns";

import { emptyAll, resetDatabase } from "../db/harness";
import { ORG_ID, seedJob, seedOrg } from "./harness";

/**
 * Every write and every read in `agentRuns.ts` is scoped on the org, not on the
 * id alone (§25 rule 3, CWE-639).
 *
 * Not reachable today: `runAgent` mints a run id and closes it in the same call,
 * so the id and the org always agree. It is tested now because Task 7's router
 * is the caller that will be *handed* a run id, and the moment an id arrives
 * from outside, an unscoped `where` is one tenant's handle on another's row.
 *
 * The assertion is the same each time: the wrong org changes nothing and reads
 * nothing, and the right org still works — a filter that rejected both would
 * pass the first half of this file and be useless.
 */

const OTHER_ORG = "org_someone_else";
const MODEL = "claude-opus-5" as const;

beforeAll(async () => {
  await resetDatabase();
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await emptyAll();
  await seedOrg();
});

async function seedRun(): Promise<string> {
  const jobId = await seedJob("echo", { text: "hello" });
  const run = await startRun(prisma, { orgId: ORG_ID, jobId, kind: "echo", model: MODEL });
  return run.id;
}

describe("org scoping in the agent-run repo", () => {
  it("will not close another org's run, and leaves it running", async () => {
    const runId = await seedRun();

    await expect(
      finishRun(prisma, { orgId: OTHER_ORG, runId, status: "done", costTotal: "1.000000" }),
    ).rejects.toThrow();

    const untouched = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(untouched.status).toBe("running");
    expect(untouched.finishedAt).toBeNull();
    expect(untouched.costTotal.equals(0)).toBe(true);

    // The owner still can, or the filter would be proving nothing.
    const closed = await finishRun(prisma, { orgId: ORG_ID, runId, status: "done", costTotal: "1.000000" });
    expect(closed.status).toBe("done");
  });

  it("will not finish or fail another org's tool step", async () => {
    const runId = await seedRun();
    const { step } = await beginToolStep(prisma, {
      orgId: ORG_ID,
      runId,
      index: 0,
      name: "shout",
      toolKey: "key-one",
      input: { text: "hello" },
    });

    await expect(
      finishToolStep(prisma, { orgId: OTHER_ORG, stepId: step.id, output: { text: "HELLO" } }),
    ).rejects.toThrow();
    await expect(
      failToolStep(prisma, { orgId: OTHER_ORG, stepId: step.id, failureKey: "__failed__", error: "Error" }),
    ).rejects.toThrow();

    const untouched = await prisma.agentRunStep.findUniqueOrThrow({ where: { id: step.id } });
    expect(untouched.output).toBeNull();
    expect(untouched.finishedAt).toBeNull();

    const finished = await finishToolStep(prisma, { orgId: ORG_ID, stepId: step.id, output: { text: "HELLO" } });
    expect(finished.output).toEqual({ text: "HELLO" });
  });

  it("lists no steps for another org", async () => {
    const runId = await seedRun();
    await beginToolStep(prisma, {
      orgId: ORG_ID,
      runId,
      index: 0,
      name: "shout",
      toolKey: "key-two",
      input: { text: "hello" },
    });

    expect(await listSteps(prisma, { orgId: OTHER_ORG, runId })).toEqual([]);
    expect((await listSteps(prisma, { orgId: ORG_ID, runId })).map((step) => step.name)).toEqual(["shout"]);
  });
});
