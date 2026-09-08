import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db";
import { LEASE_EXPIRED_ERROR, enqueue, reapExpired } from "@/lib/jobs/queue";
import { mutate } from "@/lib/repo/mutate";

import { emptyAll, resetDatabase } from "../db/harness";
import { databaseNow, spawnWorker, waitFor } from "./harness";

/**
 * Proof 2 of the runtime spike rubric (§24): killing the worker mid-handler is
 * safe, and the retry does the side effect once.
 *
 * The sequence the rubric asks for, run against a real worker process:
 *
 *   SIGKILL during `sleep`  →  the job is still `running`, still holding a
 *   lease nobody will ever renew  →  the lease expires  →  `reapExpired`
 *   requeues it, attempt 1 spent  →  a fresh worker claims it as attempt 2 and
 *   finishes  →  exactly one `SideEffect` row for the key.
 *
 * `SIGKILL`, not `SIGTERM`: the drain path is a graceful stop and would prove
 * the opposite of what this is for. Nothing runs in the dying process — no
 * handler, no `finally`, no flush — which is the whole point. Everything that
 * makes the job recoverable is already in Postgres before the signal lands.
 *
 * `RELAY_WORKER_LEASE_MS` is 1500 here so that "wait for the lease to expire"
 * is a second and a half rather than the shipping two minutes. It also puts
 * the second worker's own run (a 4-second handler on a 1.5-second lease)
 * squarely on the lease-extension timer: without `withLease` renewing, the
 * retry would be reaped out from under itself and this test would never see
 * `done`.
 */

const ORG_ID = "org_worker_kill";
const LEASE_MS = 1_500;
const SLEEP_MS = 4_000;
const SIDE_EFFECT_KEY = "touch-1-for-alice";

const shortLease = { RELAY_WORKER_LEASE_MS: String(LEASE_MS), RELAY_WORKER_POLL_MS: "100" };

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

describe("a worker killed mid-handler", () => {
  it("@proof leaves the job to be reaped, retried once, and its side effect done once", async () => {
    const { job } = await enqueue(prisma, {
      orgId: ORG_ID,
      kind: "sleep",
      idempotencyKey: "proof-2",
      input: { ms: SLEEP_MS, sideEffectKey: SIDE_EFFECT_KEY },
    });

    // ── the kill ──────────────────────────────────────────────────────────
    const first = spawnWorker([], shortLease);
    const claimed = await waitFor("the worker to claim the job", async () => {
      const row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
      return row.status === "running" ? row : null;
    });
    expect(claimed.attempts).toBe(1);
    expect(claimed.workerId).not.toBeNull();

    first.child.kill("SIGKILL");
    const died = await first.done;
    expect(died.signal).toBe("SIGKILL");

    // Nothing changed on the way out. A worker that tidied up here would be
    // hiding the case the reaper exists for.
    const abandoned = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(abandoned.status).toBe("running");
    expect(abandoned.workerId).toBe(claimed.workerId);
    expect(abandoned.leaseUntil).not.toBeNull();
    // The effect had not happened yet: the handler was still waiting.
    expect(await prisma.sideEffect.count({ where: { orgId: ORG_ID } })).toBe(0);

    // ── the reap ──────────────────────────────────────────────────────────
    // Waited on the database's clock, not the test runner's: the lease was
    // written by Postgres and only Postgres can say it has passed.
    await waitFor(
      "the lease to expire",
      async () => {
        const now = await databaseNow();
        const row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
        return row.leaseUntil !== null && row.leaseUntil <= now;
      },
      { timeoutMs: LEASE_MS * 10 },
    );

    const reaped = await reapExpired(prisma);
    expect(reaped.requeued).toEqual([job.id]);

    const requeued = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(requeued.status).toBe("queued");
    // The attempt is spent. A worker that dies without saying anything has
    // still had its go, which is what stops a crash loop retrying for ever.
    expect(requeued.attempts).toBe(1);
    expect(requeued.workerId).toBeNull();
    expect(requeued.leaseUntil).toBeNull();
    expect(requeued.error).toBe(LEASE_EXPIRED_ERROR);

    // ── the retry ─────────────────────────────────────────────────────────
    const second = spawnWorker(["--once"], shortLease);
    const finished = await second.done;
    expect(finished.stderr).toBe("");
    expect(finished.code).toBe(0);

    const done = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(done.status).toBe("done");
    expect(done.attempts).toBe(2);
    expect(done.error).toBeNull();

    const effects = await prisma.sideEffect.findMany({ where: { orgId: ORG_ID } });
    expect(effects).toHaveLength(1);
    expect(effects[0]?.key).toBe(SIDE_EFFECT_KEY);
    expect(effects[0]?.jobId).toBe(job.id);

    // And its Event, in the same transaction as the row (§25 rule 4).
    expect(await prisma.event.count({ where: { orgId: ORG_ID, kind: "side_effect.recorded" } })).toBe(1);
  }, 120_000);

  it("does not lose a job whose handler outlives its lease, because the lease is extended", async () => {
    // The same 4-second handler on the same 1.5-second lease, this time left
    // alone. It can only finish if something renewed the lease three times
    // over — and if it does not, the reaper takes the job and the status is
    // `queued`, which is the failure this asserts against.
    const { job } = await enqueue(prisma, {
      orgId: ORG_ID,
      kind: "sleep",
      idempotencyKey: "long-handler",
      input: { ms: SLEEP_MS, sideEffectKey: "touch-2" },
    });

    const finished = await spawnWorker(["--once"], shortLease).done;
    expect(finished.code).toBe(0);

    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe("done");
    expect(after.attempts).toBe(1);
  }, 120_000);

  it("drains on SIGTERM: the in-flight handler finishes and the worker exits 0", async () => {
    const { job } = await enqueue(prisma, {
      orgId: ORG_ID,
      kind: "sleep",
      idempotencyKey: "drain",
      input: { ms: SLEEP_MS, sideEffectKey: "touch-3" },
    });

    const worker = spawnWorker([], shortLease);
    await waitFor("the worker to claim the job", async () =>
      (await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status === "running",
    );

    worker.child.kill("SIGTERM");
    const finished = await worker.done;
    expect(finished.code).toBe(0);

    // The difference from SIGKILL, stated as an assertion: the handler ran to
    // the end and the job is done on its first attempt.
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe("done");
    expect(after.attempts).toBe(1);
    expect(await prisma.sideEffect.count({ where: { orgId: ORG_ID, key: "touch-3" } })).toBe(1);
  }, 120_000);

  it("gives the job back when the drain deadline passes before the handler finishes", async () => {
    const { job } = await enqueue(prisma, {
      orgId: ORG_ID,
      kind: "sleep",
      idempotencyKey: "drain-timeout",
      input: { ms: SLEEP_MS, sideEffectKey: "touch-4" },
    });

    // A deadline far shorter than the handler, so the drain runs out first.
    const worker = spawnWorker([], { ...shortLease, RELAY_WORKER_DRAIN_MS: "200" });
    await waitFor("the worker to claim the job", async () =>
      (await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status === "running",
    );

    worker.child.kill("SIGTERM");
    const finished = await worker.done;
    expect(finished.code).toBe(0);

    // Handed back rather than abandoned to the reaper: another worker can pick
    // it up now instead of waiting out a lease nobody holds.
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe("queued");
    expect(after.workerId).toBeNull();
    expect(after.error).toContain("drained");
    // And the attempt the claim spent is given back: a deploy is not a failed
    // attempt, and a job on its last one must not be marked `failed` by a
    // restart.
    expect(after.attempts).toBe(0);
    expect(after.nextAt.getTime()).toBeLessThanOrEqual((await databaseNow()).getTime());
    // The effect never happened, so nothing has to be undone.
    expect(await prisma.sideEffect.count({ where: { orgId: ORG_ID, key: "touch-4" } })).toBe(0);
  }, 120_000);
});

describe("a worker whose database blinks", () => {
  it("keeps polling after its connection is dropped, and still exits 0", async () => {
    const worker = spawnWorker([], { ...shortLease, RELAY_WORKER_POLL_MS: "200" });
    await waitFor("the worker to start", async () => worker.output().includes('"event":"started"'));

    // Cut every connection to the test database from underneath it. A pooler
    // recycling, a Postgres restart and a network blip all look like this, and
    // the worker used to answer all three by exiting — which under
    // `Restart=always` is how a flapping database becomes a failed unit.
    await prisma.$executeRawUnsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()`,
    );

    // The proof it survived: work enqueued afterwards still gets done.
    const { job } = await waitFor("the enqueue to go through", async () => {
      try {
        return await enqueue(prisma, {
          orgId: ORG_ID,
          kind: "noop",
          idempotencyKey: "after-the-blink",
          input: {},
        });
      } catch {
        // The test's own client was cut too, and reconnects on the next try.
        return null;
      }
    });
    await waitFor(
      "the job to be done",
      async () => (await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status === "done",
      { timeoutMs: 30_000 },
    );

    worker.child.kill("SIGTERM");
    const finished = await worker.done;
    expect(finished.code).toBe(0);
    // And it said so rather than swallowing the fault.
    expect(finished.stdout).toContain('"event":"poll.failed"');
  }, 120_000);

  it("stops now when it is asked to stop twice", async () => {
    const { job } = await enqueue(prisma, {
      orgId: ORG_ID,
      kind: "sleep",
      idempotencyKey: "twice",
      input: { ms: SLEEP_MS, sideEffectKey: "touch-5" },
    });

    // A nine-minute drain deadline, so only the second signal can end this.
    const worker = spawnWorker([], { ...shortLease, RELAY_WORKER_DRAIN_MS: "540000" });
    await waitFor("the worker to claim the job", async () =>
      (await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status === "running",
    );

    worker.child.kill("SIGTERM");
    await waitFor("the worker to acknowledge the first signal", async () =>
      worker.output().includes('"event":"stopping"'),
    );
    worker.child.kill("SIGTERM");

    const finished = await worker.done;
    expect(finished.code).toBe(0);
    expect(finished.stdout).toContain('"event":"stopping.forced"');

    // Given back, not failed: an operator in a hurry is not a job that went wrong.
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe("queued");
    expect(after.attempts).toBe(0);
    expect(await prisma.sideEffect.count({ where: { orgId: ORG_ID, key: "touch-5" } })).toBe(0);
  }, 120_000);
});
