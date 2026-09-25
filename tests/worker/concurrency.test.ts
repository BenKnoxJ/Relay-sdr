import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db";
import { enqueue } from "@/lib/jobs/queue";
import { mutate } from "@/lib/repo/mutate";

import { emptyAll, resetDatabase } from "../db/harness";
import { logLines, spawnWorker, waitFor } from "./harness";

/**
 * Trial fix 1 (25 Sep 2026): one worker runs several jobs at once. One at a time, seven people took about 65
 * minutes to draft in the live trial. A real worker process, three `sleep` jobs, and the proof is that all
 * three are running at the same moment, then all three finish, each once.
 */

const ORG_ID = "org_worker_concurrency";
const SLEEP_MS = 3_000;

beforeAll(async () => {
  await resetDatabase();
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await emptyAll();
  await mutate(prisma, {
    orgId: ORG_ID,
    actor: { kind: "system" },
    kind: "org.created",
    apply: (tx) => tx.org.create({ data: { id: ORG_ID, name: ORG_ID } }),
  });
});

async function sleeps(count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const { job } = await enqueue(prisma, { orgId: ORG_ID, kind: "sleep", idempotencyKey: `sleep-${index}`, input: { ms: SLEEP_MS, sideEffectKey: `effect-${index}` } });
    ids.push(job.id);
  }
  return ids;
}

const running = async (ids: string[]) => prisma.job.count({ where: { id: { in: ids }, status: "running" } });

describe("a worker running jobs at once", () => {
  it("runs up to RELAY_WORKER_CONCURRENCY jobs at the same moment, and finishes each once", async () => {
    const ids = await sleeps(3);
    const worker = spawnWorker([], { RELAY_WORKER_POLL_MS: "100", RELAY_WORKER_CONCURRENCY: "3" });
    await waitFor("three jobs running at once", async () => (await running(ids)) === 3);
    await waitFor("every job done", async () => (await prisma.job.count({ where: { id: { in: ids }, status: "done" } })) === 3, { timeoutMs: 30_000 });

    worker.child.kill("SIGTERM");
    const finished = await worker.done;
    expect(finished.code).toBe(0);
    expect(logLines(finished.stdout).find((line) => line.event === "started")).toMatchObject({ concurrency: 3 });
    for (const [index, id] of ids.entries()) {
      expect((await prisma.job.findUniqueOrThrow({ where: { id } })).attempts).toBe(1);
      expect(await prisma.sideEffect.count({ where: { orgId: ORG_ID, key: `effect-${index}` } })).toBe(1);
    }
  }, 120_000);

  it("never runs more than its limit", async () => {
    const ids = await sleeps(3);
    const worker = spawnWorker([], { RELAY_WORKER_POLL_MS: "100", RELAY_WORKER_CONCURRENCY: "2" });
    await waitFor("two jobs running", async () => (await running(ids)) === 2);
    let most = 0;
    while ((await prisma.job.count({ where: { id: { in: ids }, status: "done" } })) < 3) {
      most = Math.max(most, await running(ids));
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(most).toBe(2);
    worker.child.kill("SIGTERM");
    expect((await worker.done).code).toBe(0);
  }, 120_000);

  it("drains every job in flight on SIGTERM before it exits", async () => {
    const ids = await sleeps(2);
    const worker = spawnWorker([], { RELAY_WORKER_POLL_MS: "100", RELAY_WORKER_CONCURRENCY: "3" });
    await waitFor("both jobs running", async () => (await running(ids)) === 2);
    worker.child.kill("SIGTERM");
    expect((await worker.done).code).toBe(0);
    expect(await prisma.job.count({ where: { id: { in: ids }, status: "done" } })).toBe(2);
  }, 120_000);
});
