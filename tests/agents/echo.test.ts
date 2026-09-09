import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db";
import { enqueue } from "@/lib/jobs/queue";

import { emptyAll, resetDatabase } from "../db/harness";
import { logLines, spawnWorker } from "../worker/harness";
import { seedOrg } from "./harness";

/**
 * The agent runtime, end to end, through the worker's own loop.
 *
 * Not `runAgent` called from a test: the real worker process, started the way
 * `npm run worker -- --once` starts it, claiming the job under a lease and
 * completing it with a digest. What is being proved is the wiring — the handler
 * registry, the definition loaded off disk, the run and its steps recorded under
 * the job's org, the cost totalled, the job reaching `done`.
 *
 * The model is scripted through `RELAY_AGENT_STUB_MODEL`, because a spawned
 * process has no seam but its environment and no credential is available in CI.
 * That variable is refused outright by `env()` unless `NODE_ENV` is explicitly
 * `development` or `test` — see `src/lib/agents/stubModel.ts`.
 */

const ORG_ID = "org_agents";

/** Two model calls asking for the tool, then the answer. */
const SCRIPT = JSON.stringify({
  calls: [
    { tool: { name: "shout", args: { text: "hello" } }, usage: { in: 2_000, out: 40 } },
    { tool: { name: "shout", args: { text: "world" } }, usage: { in: 2_400, out: 48 } },
    { text: JSON.stringify({ text: "HELLO" }), usage: { in: 2_800, out: 60 } },
  ],
});

beforeAll(async () => {
  await resetDatabase();
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await emptyAll();
  await seedOrg(ORG_ID);
});

describe("the echo job under the worker", () => {
  it("@proof claims, runs the agent loop, records every step and completes", async () => {
    const { job } = await enqueue(prisma, {
      orgId: ORG_ID,
      kind: "echo",
      idempotencyKey: "echo-end-to-end",
      input: { text: "hello" },
    });

    const worker = spawnWorker(["--once"], {
      NODE_ENV: "test",
      RELAY_AGENT_STUB_MODEL: SCRIPT,
    });
    const finished = await worker.done;

    expect(finished.stderr).toBe("");
    expect(finished.code).toBe(0);

    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe("done");
    expect(after.attempts).toBe(1);
    // A digest, because the handler returned something to fingerprint.
    expect(after.responseDigest).toMatch(/^[0-9a-f]{64}$/);

    const runs = await prisma.agentRun.findMany({ where: { jobId: job.id } });
    expect(runs).toHaveLength(1);
    const run = runs[0];
    if (run === undefined) throw new Error("no run");
    expect(run.status).toBe("done");
    expect(run.kind).toBe("echo");
    expect(run.model).toBe("claude-opus-5");
    expect(run.orgId).toBe(ORG_ID);
    expect(run.finishedAt).not.toBeNull();

    const steps = await prisma.agentRunStep.findMany({ where: { runId: run.id }, orderBy: { index: "asc" } });
    expect(steps.length).toBeGreaterThanOrEqual(3);
    expect(steps.map((step) => `${step.index}:${step.kind}`)).toEqual([
      "0:model",
      "1:tool",
      "2:model",
      "3:tool",
      "4:model",
    ]);
    expect(steps.every((step) => step.orgId === ORG_ID)).toBe(true);

    // Cost above zero, and the run's total is the steps' sum — the whole point of
    // proof 1, now through the real process rather than a function call.
    expect(run.costTotal.greaterThan(0)).toBe(true);
    const summed = steps.reduce((total, step) => total.add(step.cost), new Prisma.Decimal(0));
    expect(run.costTotal.equals(summed)).toBe(true);

    // The loop said what it did, and said nothing about the input — `job.input` is
    // a rep's pipeline and a log is where tenant data leaks without a decision.
    const lines = logLines(finished.stdout);
    const events = lines.map((line) => line.event);
    expect(events).toContain("job.claimed");
    expect(events).toContain("job.done");
    expect(finished.stdout).not.toContain("hello");
  });

  it("@proof fails terminally on an input the definition rejects, with nothing spent", async () => {
    const { job } = await enqueue(prisma, {
      orgId: ORG_ID,
      kind: "echo",
      idempotencyKey: "echo-bad-input",
      // `text` is required and must be a string.
      input: { text: 42 },
    });

    const worker = spawnWorker(["--once"], { NODE_ENV: "test", RELAY_AGENT_STUB_MODEL: SCRIPT });
    const finished = await worker.done;
    expect(finished.code).toBe(0);

    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    // Terminal on the first attempt: three more attempts read the same input.
    expect(after.status).toBe("failed");
    expect(after.attempts).toBe(1);
    expect(after.error).toMatch(/echo: bad input/);
    // No run was opened, so nothing was charged for a job that could not start.
    expect(await prisma.agentRun.count()).toBe(0);
  });
});
