import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db";
import { enqueue } from "@/lib/jobs/queue";
import { mutate } from "@/lib/repo/mutate";

import { emptyAll, resetDatabase } from "../db/harness";
import { logLines, spawnWorker, waitFor, workerEnv } from "./harness";

/**
 * Proof 5 of the runtime spike rubric (§24): `npm run worker -- --once` runs
 * on Docker Postgres alone.
 *
 * The pass condition is a whole process: a `noop` job on the queue, a worker
 * started with `DATABASE_URL` and no `NEXT_*`, `CLERK_*` or `VERCEL_*`
 * anywhere in its environment, an exit code of 0, and the job `done`. CI runs
 * the same thing under `env -i` as the boundary smoke; this is the half that
 * also checks the work got done.
 */

const ORG_ID = "org_worker_once";

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

describe("npm run worker -- --once", () => {
  it("@proof claims and completes one noop job on Docker Postgres alone", async () => {
    const { job } = await enqueue(prisma, {
      orgId: ORG_ID,
      kind: "noop",
      idempotencyKey: "proof-5",
      input: {},
    });

    const worker = spawnWorker(["--once"]);
    const finished = await worker.done;

    expect(finished.stderr).toBe("");
    expect(finished.code).toBe(0);

    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe("done");
    expect(after.attempts).toBe(1);
    // The claim is released on completion, so nothing holds a lease on a
    // finished job.
    expect(after.workerId).toBeNull();
    expect(after.leaseUntil).toBeNull();
    // sha256 of `{"ok":true}` — the digest is of what the handler returned,
    // and it is a hash rather than the value itself.
    expect(after.responseDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(after.error).toBeNull();

    const lines = logLines(finished.stdout);
    expect(lines.map((line) => line.event)).toContain("job.done");
    // No line carries the job's input: a log is where tenant data leaks
    // without anyone deciding to let it.
    expect(finished.stdout).not.toContain("idempotencyKey");
  }, 60_000);

  it("@proof exits 0 on an empty queue, with no Next, Clerk or Vercel variables set", async () => {
    // The environment the child gets, asserted rather than assumed: this is
    // the actual content of proof 5's pass condition, and a helper that
    // quietly inherited `process.env` would make every other assertion here
    // meaningless.
    const environment = workerEnv();
    expect(Object.keys(environment).sort()).toEqual([
      "DATABASE_URL",
      "DIRECT_URL",
      "INTEGRATIONS",
      "PATH",
    ]);
    for (const name of Object.keys(environment)) {
      expect(name).not.toMatch(/^(NEXT_|CLERK_|VERCEL_)/);
    }

    const finished = await spawnWorker(["--once"]).done;
    expect(finished.code).toBe(0);
    expect(logLines(finished.stdout).map((line) => line.event)).toContain("idle");
  }, 60_000);

  it("requeues a job whose kind has no handler, in plain words, and fails it once the attempts are spent", async () => {
    const { job } = await enqueue(prisma, {
      orgId: ORG_ID,
      kind: "not_a_handler",
      idempotencyKey: "unknown-kind",
      input: {},
    });

    const finished = await spawnWorker(["--once"]).done;
    expect(finished.code).toBe(0);

    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    // Queued, not failed. "This worker has no handler for that kind" is a
    // statement about the binary, not the job — an older worker mid-deploy
    // says it about kinds the app is already enqueueing. And `enqueue` returns
    // the existing row for a key whatever state it is in, so a job failed here
    // could never be re-enqueued under its natural key.
    expect(after.status).toBe("queued");
    expect(after.error).toBe('unknown job kind: "not_a_handler"');
    expect(after.attempts).toBe(1);

    // It still ends in `failed`, which is the brief's outcome: the attempt cap
    // gets there, it just gives a redeployed worker the chance to get there
    // first.
    for (let attempt = 2; attempt <= 3; attempt += 1) {
      await prisma.$executeRawUnsafe(
        `UPDATE jobs SET next_at = (now() AT TIME ZONE 'UTC') WHERE id = $1`,
        job.id,
      );
      expect((await spawnWorker(["--once"]).done).code).toBe(0);
    }
    const spent = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(spent.status).toBe("failed");
    expect(spent.attempts).toBe(3);
  }, 120_000);

  it("fails terminally when the side effect is already recorded", async () => {
    const { job: first } = await enqueue(prisma, {
      orgId: ORG_ID,
      kind: "sleep",
      idempotencyKey: "sleep-a",
      input: { ms: 0, sideEffectKey: "touch-1" },
    });
    expect((await spawnWorker(["--once"]).done).code).toBe(0);
    await waitFor("the first job to be done", async () =>
      (await prisma.job.findUniqueOrThrow({ where: { id: first.id } })).status === "done",
    );

    // A second job, a different idempotency key, the same side-effect key: the
    // effect has happened, so this one must not claim to have done it again.
    const { job: second } = await enqueue(prisma, {
      orgId: ORG_ID,
      kind: "sleep",
      idempotencyKey: "sleep-b",
      input: { ms: 0, sideEffectKey: "touch-1" },
    });
    expect((await spawnWorker(["--once"]).done).code).toBe(0);

    const after = await prisma.job.findUniqueOrThrow({ where: { id: second.id } });
    expect(after.status).toBe("failed");
    expect(after.attempts).toBe(1);
    expect(after.error).toContain("already recorded");
    expect(await prisma.sideEffect.count({ where: { orgId: ORG_ID, key: "touch-1" } })).toBe(1);
  }, 60_000);

  it("fails terminally on input the handler cannot use", async () => {
    const { job } = await enqueue(prisma, {
      orgId: ORG_ID,
      kind: "sleep",
      idempotencyKey: "sleep-bad",
      input: { ms: -1 },
    });

    expect((await spawnWorker(["--once"]).done).code).toBe(0);

    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe("failed");
    expect(after.attempts).toBe(1);
    expect(after.error).toContain("sleep: bad input");
  }, 60_000);
});
