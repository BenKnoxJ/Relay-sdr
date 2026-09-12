import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db";
import {
  MAX_ATTEMPTS,
  claimNext,
  complete,
  enqueue,
  extendLease,
  fail,
  requeue,
  reapExpired,
  release,
} from "@/lib/jobs/queue";
import { mutate } from "@/lib/repo/mutate";

import { emptyAll, resetDatabase } from "../db/harness";

// Proof 4 of the runtime spike rubric (§24): two workers never claim the same
// job, and a worker whose lease has been reaped can no longer write to it.
// These are the rubric's conditions, not a description of the module.

const ORG_ID = "org_queue_test";
const OTHER_ORG_ID = "org_queue_test_other";

/**
 * The race needs a genuinely separate client: two connections, so the two
 * claims are two sessions competing for the same rows rather than one session
 * serialising itself. `src/lib/db.ts` is still the only `new PrismaClient()`
 * in `src/**` — this one lives in the test, which is what the second worker
 * process will be in real life.
 */
let second: PrismaClient;

beforeAll(async () => {
  await resetDatabase();
  second = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
}, 120_000);

afterAll(async () => {
  await second.$disconnect();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await emptyAll();
  for (const id of [ORG_ID, OTHER_ORG_ID]) {
    await mutate(prisma, {
      orgId: id,
      actor: { kind: "system" },
      kind: "org.created",
      apply: (tx) => tx.org.create({ data: { id, name: id } }),
    });
  }
});

const databaseNow = async (): Promise<Date> => {
  const rows = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT (now() AT TIME ZONE 'UTC') AS now`;
  return rows[0]!.now;
};

const add = (key: string, over: { orgId?: string; priority?: number; nextAt?: Date } = {}) =>
  enqueue(prisma, {
    orgId: over.orgId ?? ORG_ID,
    kind: "noop",
    idempotencyKey: key,
    input: { key },
    ...(over.priority === undefined ? {} : { priority: over.priority }),
    ...(over.nextAt === undefined ? {} : { nextAt: over.nextAt }),
  });

describe("enqueue", () => {
  it("returns the same job for a repeated key in one org", async () => {
    const first = await add("touch-1");
    const again = await add("touch-1");

    expect(first.deduped).toBe(false);
    expect(again.deduped).toBe(true);
    expect(again.job.id).toBe(first.job.id);
    expect(await prisma.job.count()).toBe(1);
  });

  it("lets a second org use the same key", async () => {
    const mine = await add("touch-1");
    const theirs = await add("touch-1", { orgId: OTHER_ORG_ID });

    expect(theirs.deduped).toBe(false);
    expect(theirs.job.id).not.toBe(mine.job.id);
    expect(await prisma.job.count()).toBe(2);
  });

  it("makes one job when two clients enqueue the same key at once", async () => {
    // The read-first path in `enqueue` is a quiet-logs optimisation, not the
    // safety: two concurrent callers can both find nothing and both insert.
    // What makes that safe is the unique index and the `P2002` branch, so race
    // them and check the invariant rather than trusting the fast path.
    const both = await Promise.all([
      enqueue(prisma, { orgId: ORG_ID, kind: "noop", idempotencyKey: "race", input: {} }),
      enqueue(second, { orgId: ORG_ID, kind: "noop", idempotencyKey: "race", input: {} }),
    ]);

    expect(both[0].job.id).toBe(both[1].job.id);
    expect(both.filter((result) => result.deduped)).toHaveLength(1);
    expect(await prisma.job.count()).toBe(1);
  });

  it("refuses a blank org, kind or key", async () => {
    const base = { orgId: ORG_ID, kind: "noop", idempotencyKey: "k", input: {} };

    await expect(enqueue(prisma, { ...base, orgId: " " })).rejects.toThrow("orgId is required");
    await expect(enqueue(prisma, { ...base, kind: "" })).rejects.toThrow("kind is required");
    await expect(enqueue(prisma, { ...base, idempotencyKey: "  " })).rejects.toThrow(
      "idempotencyKey is required",
    );
    expect(await prisma.job.count()).toBe(0);
  });

  it("records the rep a job belongs to", async () => {
    const user = await prisma.user.create({
      data: { orgId: ORG_ID, email: "rep@example.test", name: "Rep", role: "rep" },
    });

    const { job } = await enqueue(prisma, {
      orgId: ORG_ID,
      ownerUserId: user.id,
      kind: "noop",
      idempotencyKey: "mine",
      input: {},
    });

    expect(job.ownerUserId).toBe(user.id);
    expect((await claimNext(prisma, "worker-a"))?.ownerUserId).toBe(user.id);
  });

  it("stamps the job with the database's clock, not the caller's", async () => {
    // Prisma fills `@default(now())` from the process it runs in, so a host
    // whose clock is fast would enqueue jobs that `claimNext` cannot see yet.
    // Bracketing the call with two database reads is the assertion that holds
    // whatever the app clock says; here the two clocks are the same machine, so
    // this passes either way today and exists to fail when they are not.
    const before = await databaseNow();
    const { job } = await add("touch-1");
    const after = await databaseNow();

    expect(job.nextAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(job.nextAt.getTime()).toBeLessThanOrEqual(after.getTime());
    expect(job.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(job.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("commits with the transaction it is given", async () => {
    // §25 rule 2: the Job is the outbox for an external write, so it has to be
    // able to commit with the state change that asks for it. `mutate` opens the
    // only transaction in the codebase, so this is the shape every caller has.
    await expect(
      mutate(prisma, {
        orgId: ORG_ID,
        actor: { kind: "system" },
        kind: "account.connected",
        apply: async (tx) => {
          await enqueue(tx, {
            orgId: ORG_ID,
            kind: "noop",
            idempotencyKey: "rolled-back",
            input: {},
          });
          throw new Error("the state change failed");
        },
      }),
    ).rejects.toThrow("the state change failed");

    expect(await prisma.job.count()).toBe(0);

    await mutate(prisma, {
      orgId: ORG_ID,
      actor: { kind: "system" },
      kind: "account.connected",
      apply: (tx) =>
        enqueue(tx, { orgId: ORG_ID, kind: "noop", idempotencyKey: "committed", input: {} }),
    });

    expect(await prisma.job.count()).toBe(1);
  });

  it("@proof dedupes inside a transaction without losing the transaction", async () => {
    // The reason the insert is `ON CONFLICT DO NOTHING` and not a caught
    // `P2002`: a failed statement aborts the whole Postgres transaction, so the
    // recovery read would fail too and take the caller's state change and its
    // Event down with it.
    await add("touch-1");

    const user = await mutate(prisma, {
      orgId: ORG_ID,
      actor: { kind: "system" },
      kind: "user.upserted",
      apply: async (tx) => {
        const result = await enqueue(tx, {
          orgId: ORG_ID,
          kind: "noop",
          idempotencyKey: "touch-1",
          input: {},
        });
        expect(result.deduped).toBe(true);
        return tx.user.create({
          data: { orgId: ORG_ID, email: "still-committed@example.test", role: "rep" },
        });
      },
    });

    expect(user.email).toBe("still-committed@example.test");
    expect(await prisma.job.count()).toBe(1);
    expect(await prisma.user.count()).toBe(1);
  });

  it("starts a job queued, unclaimed and on attempt zero", async () => {
    const { job } = await add("touch-1");

    expect(job.status).toBe("queued");
    expect(job.attempts).toBe(0);
    expect(job.workerId).toBeNull();
    expect(job.leaseUntil).toBeNull();
    expect(job.input).toEqual({ key: "touch-1" });
    // The constant the worker budgets retries on is the column's default, not a
    // number that happens to agree with it today.
    expect(job.maxAttempts).toBe(MAX_ATTEMPTS);
  });
});

describe("claimNext", () => {
  it("claims the job, counting the attempt", async () => {
    await add("touch-1");

    const job = await claimNext(prisma, "worker-a");

    expect(job?.status).toBe("running");
    expect(job?.workerId).toBe("worker-a");
    expect(job?.attempts).toBe(1);
    expect(job?.leaseUntil).toBeInstanceOf(Date);
    expect(await claimNext(prisma, "worker-b")).toBeNull();
  });

  it("takes the highest priority first", async () => {
    await add("low", { priority: 0 });
    await add("high", { priority: 5 });

    const first = await claimNext(prisma, "worker-a");

    expect((first?.input as { key: string }).key).toBe("high");
  });

  it("leaves a job whose next_at is in the future", async () => {
    await add("later", { nextAt: new Date(Date.now() + 60_000) });

    expect(await claimNext(prisma, "worker-a")).toBeNull();
  });

  it("@proof never hands the same job to two workers", async () => {
    for (let run = 0; run < 3; run += 1) {
      await emptyAll();
      await mutate(prisma, {
        orgId: ORG_ID,
        actor: { kind: "system" },
        kind: "org.created",
        apply: (tx) => tx.org.create({ data: { id: ORG_ID, name: ORG_ID } }),
      });
      for (let index = 0; index < 200; index += 1) await add(`job-${index}`);

      const drain = async (db: PrismaClient, workerId: string): Promise<string[]> => {
        const claimed: string[] = [];
        for (;;) {
          const job = await claimNext(db, workerId);
          if (job === null) return claimed;
          claimed.push(job.id);
        }
      };

      const [a, b] = await Promise.all([drain(prisma, "worker-a"), drain(second, "worker-b")]);

      const union = new Set([...a, ...b]);
      const intersection = a.filter((id) => b.includes(id));
      expect(intersection).toEqual([]);
      expect(union.size).toBe(200);
      expect(a.length + b.length).toBe(200);
    }
  }, 120_000);
});

describe("extendLease", () => {
  it("moves the lease forward for the worker holding it", async () => {
    await add("touch-1");
    const job = await claimNext(prisma, "worker-a", { leaseMs: 1_000 });

    const result = await extendLease(prisma, job!, { leaseMs: 600_000 });
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job!.id } });

    expect(result.ok).toBe(true);
    expect(after.leaseUntil!.getTime()).toBeGreaterThan(job!.leaseUntil!.getTime());
  });

  it("refuses a claim from an earlier attempt", async () => {
    await add("touch-1");
    const stale = await claimNext(prisma, "worker-a", { leaseMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await reapExpired(prisma);
    const fresh = await claimNext(prisma, "worker-a");

    expect(await extendLease(prisma, stale!, { leaseMs: 600_000 })).toEqual({
      ok: false,
      fenced: true,
    });
    const after = await prisma.job.findUniqueOrThrow({ where: { id: stale!.id } });
    expect(after.leaseUntil!.getTime()).toBe(fresh!.leaseUntil.getTime());
  });

  it("refuses a worker that does not hold the job", async () => {
    await add("touch-1");
    const job = await claimNext(prisma, "worker-a");

    const result = await extendLease(
      prisma,
      { ...job!, workerId: "worker-b" },
      { leaseMs: 600_000 },
    );
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job!.id } });

    expect(result).toEqual({ ok: false, fenced: true });
    expect(after.leaseUntil!.getTime()).toBe(job!.leaseUntil!.getTime());
  });
});

describe("complete and fail", () => {
  it("marks the job done for the holder", async () => {
    await add("touch-1");
    const job = await claimNext(prisma, "worker-a");

    expect(await complete(prisma, job!, { responseDigest: "sha256:abc" })).toEqual({
      ok: true,
      fenced: false,
    });
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job!.id } });
    expect(after.status).toBe("done");
    expect(after.responseDigest).toBe("sha256:abc");
    expect(after.workerId).toBeNull();
    expect(after.leaseUntil).toBeNull();
  });

  it("marks the job failed for the holder", async () => {
    await add("touch-1");
    const job = await claimNext(prisma, "worker-a");

    expect(await fail(prisma, job!, "unusable input")).toEqual({
      ok: true,
      fenced: false,
    });
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job!.id } });
    expect(after.status).toBe("failed");
    expect(after.error).toBe("unusable input");
  });

  it("@proof refuses a zombie whose lease was reaped, and writes nothing", async () => {
    await add("touch-1");
    const job = await claimNext(prisma, "worker-a", { leaseMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const reaped = await reapExpired(prisma);
    expect(reaped.requeued).toEqual([job!.id]);

    const before = await prisma.job.findUniqueOrThrow({ where: { id: job!.id } });
    const result = await complete(prisma, job!, { responseDigest: "sha256:abc" });
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job!.id } });

    expect(result).toEqual({ ok: false, fenced: true });
    expect(after.status).toBe("queued");
    expect(after.responseDigest).toBeNull();
    expect(after).toEqual(before);
  });

  it("@proof refuses the reaped worker once a second worker holds the job", async () => {
    // The case `status = 'running'` alone cannot see: the job is running again,
    // just not for worker-a. This is what `worker_id` in the fence is for, and
    // the duplicate-completion the whole module exists to prevent.
    await add("touch-1");
    const first = await claimNext(prisma, "worker-a", { leaseMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await reapExpired(prisma);
    const second_ = await claimNext(second, "worker-b");
    expect(second_?.id).toBe(first!.id);

    const zombie = await complete(prisma, first!, { responseDigest: "zombie" });
    const after = await prisma.job.findUniqueOrThrow({ where: { id: first!.id } });

    expect(zombie).toEqual({ ok: false, fenced: true });
    expect(after.status).toBe("running");
    expect(after.workerId).toBe("worker-b");
    expect(after.responseDigest).toBeNull();

    // And the worker that does hold it can still finish.
    expect(await complete(second, second_!, {})).toEqual({ ok: true, fenced: false });
  });

  it("refuses a stale claim on fail as well as on complete", async () => {
    await add("touch-1");
    const stale = await claimNext(prisma, "worker-a", { leaseMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await reapExpired(prisma);
    const fresh = await claimNext(second, "worker-b");

    expect(await fail(prisma, stale!, "attempt-1 gave up")).toEqual({ ok: false, fenced: true });
    const after = await prisma.job.findUniqueOrThrow({ where: { id: stale!.id } });
    expect(after.status).toBe("running");
    expect(after.error).toBe("lease expired");
    expect(await fail(second, fresh!, "attempt-2 gave up")).toEqual({ ok: true, fenced: false });
  });

  it("@proof refuses a claim from before the reap, even from the same worker", async () => {
    // The case `worker_id` alone cannot see. A worker whose lease expired is
    // reaped and then claims the same job back on its very next poll — same id,
    // new attempt — and the first attempt is still in flight.
    await add("touch-1");
    const stale = await claimNext(prisma, "worker-a", { leaseMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await reapExpired(prisma);
    const fresh = await claimNext(prisma, "worker-a");
    expect(fresh?.attempts).toBe(stale!.attempts + 1);

    const late = await complete(prisma, stale!, { responseDigest: "attempt-1" });
    const after = await prisma.job.findUniqueOrThrow({ where: { id: stale!.id } });

    expect(late).toEqual({ ok: false, fenced: true });
    expect(after.status).toBe("running");
    expect(after.responseDigest).toBeNull();
    expect(await complete(prisma, fresh!, { responseDigest: "attempt-2" })).toEqual({
      ok: true,
      fenced: false,
    });
  });

  it("still lets the holder finish between the lease expiring and the reaper running", async () => {
    // The deliberate hole in the fence. Nobody else can hold this job until the
    // reaper has run, so refusing the holder here would not prevent a second
    // worker from anything — it would only turn a slow send into a repeated
    // one. See the fence note at the top of `queue.ts`.
    await add("touch-1");
    const job = await claimNext(prisma, "worker-a", { leaseMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await complete(prisma, job!, {})).toEqual({ ok: true, fenced: false });
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job!.id } })).status).toBe("done");
  });
});

describe("requeue", () => {
  it("clears the claim and holds the job until the delay has passed", async () => {
    await add("touch-1");
    const job = await claimNext(prisma, "worker-a");

    const result = await requeue(prisma, job!, {
      error: "rate limited",
      delayMs: 60_000,
    });
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job!.id } });

    expect(result).toEqual({ ok: true, fenced: false, status: "queued" });
    expect(after.status).toBe("queued");
    expect(after.workerId).toBeNull();
    expect(after.leaseUntil).toBeNull();
    expect(after.error).toBe("rate limited");
    expect(after.nextAt.getTime()).toBeGreaterThan(Date.now() + 30_000);
    expect(await claimNext(prisma, "worker-a")).toBeNull();
  });

  it("fails the job instead once the attempts are spent", async () => {
    await add("touch-1");
    const job = await claimNext(prisma, "worker-a");
    await prisma.job.update({ where: { id: job!.id }, data: { maxAttempts: job!.attempts } });

    const result = await requeue(prisma, job!, { error: "still down", delayMs: 0 });
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job!.id } });

    expect(result).toEqual({ ok: true, fenced: false, status: "failed" });
    expect(after.status).toBe("failed");
  });

  it("refuses a claim from an earlier attempt", async () => {
    await add("touch-1");
    const stale = await claimNext(prisma, "worker-a", { leaseMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await reapExpired(prisma);
    await claimNext(prisma, "worker-a");

    expect(await requeue(prisma, stale!, { error: "x", delayMs: 60_000 })).toEqual({
      ok: false,
      fenced: true,
    });
    expect((await prisma.job.findUniqueOrThrow({ where: { id: stale!.id } })).status).toBe(
      "running",
    );
  });

  it("refuses a worker that does not hold the job", async () => {
    await add("touch-1");
    const job = await claimNext(prisma, "worker-a");

    expect(
      await requeue(prisma, { ...job!, workerId: "worker-b" }, { error: "x", delayMs: 0 }),
    ).toEqual({
      ok: false,
      fenced: true,
    });
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job!.id } })).status).toBe("running");
  });
});

describe("reapExpired", () => {
  it("puts an expired lease back on the queue and leaves a live one alone", async () => {
    await add("dead");
    await add("alive");
    const dead = await claimNext(prisma, "worker-a", { leaseMs: 1 });
    const alive = await claimNext(prisma, "worker-b", { leaseMs: 600_000 });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const result = await reapExpired(prisma);
    const after = await prisma.job.findUniqueOrThrow({ where: { id: dead!.id } });

    expect(result).toEqual({ requeued: [dead!.id], failed: [] });
    expect(after.status).toBe("queued");
    expect(after.workerId).toBeNull();
    expect(after.leaseUntil).toBeNull();
    expect(after.error).toBe("lease expired");
    expect((await prisma.job.findUniqueOrThrow({ where: { id: alive!.id } })).status).toBe(
      "running",
    );
    expect(await claimNext(prisma, "worker-c")).not.toBeNull();
  });

  it("fails a job that has spent its attempts", async () => {
    await add("touch-1");
    const job = await claimNext(prisma, "worker-a", { leaseMs: 1 });
    await prisma.job.update({ where: { id: job!.id }, data: { attempts: MAX_ATTEMPTS } });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const result = await reapExpired(prisma);
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job!.id } });

    expect(result).toEqual({ requeued: [], failed: [job!.id] });
    expect(after.status).toBe("failed");
    expect(after.error).toBe("lease expired");
  });
});

describe("enqueue and the job's owner", () => {
  const makeUser = (orgId: string, id: string) =>
    mutate(prisma, {
      orgId,
      actor: { kind: "system" },
      kind: "user.upserted",
      apply: (tx) => tx.user.create({ data: { id, orgId, email: `${id}@example.com` } }),
    });

  it("accepts an owner who is a user of the job's org", async () => {
    await makeUser(ORG_ID, "user_owner");
    const { job } = await enqueue(prisma, {
      orgId: ORG_ID,
      kind: "noop",
      idempotencyKey: "owned",
      ownerUserId: "user_owner",
      input: {},
    });
    expect(job.ownerUserId).toBe("user_owner");
  });

  it("refuses an owner from another org", async () => {
    // The foreign key does not check this: `owner_user_id` references
    // `users(id)` with no regard for the tenant, so without the check in
    // `enqueue` a caller could hang one org's job off another org's rep and
    // the "my jobs" screen would show it to them (§25, rule 3).
    await makeUser(OTHER_ORG_ID, "user_elsewhere");
    await expect(
      enqueue(prisma, {
        orgId: ORG_ID,
        kind: "noop",
        idempotencyKey: "cross-tenant",
        ownerUserId: "user_elsewhere",
        input: {},
      }),
    ).rejects.toThrow("ownerUserId is not a user of this org");
    expect(await prisma.job.count()).toBe(0);
  });

  it("refuses an owner who does not exist", async () => {
    await expect(
      enqueue(prisma, {
        orgId: ORG_ID,
        kind: "noop",
        idempotencyKey: "ghost",
        ownerUserId: "user_missing",
        input: {},
      }),
    ).rejects.toThrow("ownerUserId is not a user of this org");
    expect(await prisma.job.count()).toBe(0);
  });
});

describe("enqueue and the job's campaign", () => {
  /** A campaign row put in directly: this file is about the queue, not the campaign write path. */
  const makeCampaign = async (orgId: string, id: string, briefVersion = 1) => {
    const userId = `user_${id}`;
    await prisma.user.create({ data: { id: userId, orgId, email: `${userId}@example.com` } });
    await prisma.campaign.create({
      data: { id, orgId, ownerUserId: userId, name: id, briefVersion, brief: {}, startRequestId: `req_${id}` },
    });
  };
  const research = (over: { orgId?: string; campaignId?: string; briefVersion?: number; key?: string }) =>
    enqueue(prisma, {
      orgId: over.orgId ?? ORG_ID,
      kind: "research",
      idempotencyKey: over.key ?? "research-1",
      input: {},
      ...(over.campaignId === undefined ? {} : { campaignId: over.campaignId }),
      ...(over.briefVersion === undefined ? {} : { briefVersion: over.briefVersion }),
    });

  it("records the campaign and brief version, on the insert and on a dedupe", async () => {
    await makeCampaign(ORG_ID, "camp_one");
    const first = await research({ campaignId: "camp_one", briefVersion: 1 });
    const again = await research({ campaignId: "camp_one", briefVersion: 1 });

    expect(first.job).toMatchObject({ campaignId: "camp_one", briefVersion: 1 });
    expect(again).toMatchObject({ deduped: true, job: { id: first.job.id, campaignId: "camp_one", briefVersion: 1 } });
    // What `claimNext` reads back through `RETURNING *` carries them too.
    expect(await claimNext(prisma, "worker-a")).toMatchObject({ campaignId: "camp_one", briefVersion: 1 });
  });

  it("refuses a campaign without a brief version, and a version without a campaign", async () => {
    await makeCampaign(ORG_ID, "camp_two");
    await expect(research({ campaignId: "camp_two" })).rejects.toThrow("campaignId and briefVersion come together");
    await expect(research({ briefVersion: 1 })).rejects.toThrow("campaignId and briefVersion come together");
    expect(await prisma.job.count()).toBe(0);
  });

  it("refuses another org's campaign, and one that does not exist", async () => {
    // The foreign key says the campaign exists, not whose it is.
    await makeCampaign(OTHER_ORG_ID, "camp_elsewhere");
    await expect(research({ campaignId: "camp_elsewhere", briefVersion: 1 })).rejects.toThrow(
      "campaignId is not a campaign of this org",
    );
    await expect(research({ campaignId: "camp_missing", briefVersion: 1 })).rejects.toThrow(
      "campaignId is not a campaign of this org",
    );
    expect(await prisma.job.count()).toBe(0);
  });

  it("refuses a brief version the campaign has not reached, and one below the first", async () => {
    await makeCampaign(ORG_ID, "camp_three", 2);
    await expect(research({ campaignId: "camp_three", briefVersion: 3 })).rejects.toThrow("ahead of the campaign's own");
    await expect(research({ campaignId: "camp_three", briefVersion: 0 })).rejects.toThrow("positive whole number");
    await expect(research({ campaignId: "camp_three", briefVersion: 2 })).resolves.toMatchObject({ deduped: false });
  });
});

describe("release", () => {
  it("gives the job back without spending the attempt", async () => {
    await add("released");
    const claim = await claimNext(prisma, "worker-one");
    expect(claim?.attempts).toBe(1);
    if (claim === null) throw new Error("tests: the claim returned nothing");

    expect(await release(prisma, claim, "worker drained")).toEqual({ ok: true, fenced: false });

    const row = await prisma.job.findUniqueOrThrow({ where: { id: claim.id } });
    expect(row.status).toBe("queued");
    // Back where it started. A deploy is not an attempt.
    expect(row.attempts).toBe(0);
    expect(row.workerId).toBeNull();
    expect(row.leaseUntil).toBeNull();
    expect(row.nextAt.getTime()).toBeLessThanOrEqual((await databaseNow()).getTime());
  });

  it("does not fail a job that was on its last attempt", async () => {
    await add("last-attempt");
    let claim = await claimNext(prisma, "worker-one");
    for (let spent = 1; spent < MAX_ATTEMPTS; spent += 1) {
      if (claim === null) throw new Error("tests: the claim returned nothing");
      await requeue(prisma, claim, { error: "transient", delayMs: 0 });
      claim = await claimNext(prisma, "worker-one");
    }
    if (claim === null) throw new Error("tests: the claim returned nothing");
    expect(claim.attempts).toBe(MAX_ATTEMPTS);

    // `requeue` here would cap out and mark the job `failed`, which for a send
    // is work dropped by a restart.
    expect(await release(prisma, claim, "worker drained")).toEqual({ ok: true, fenced: false });
    const row = await prisma.job.findUniqueOrThrow({ where: { id: claim.id } });
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(MAX_ATTEMPTS - 1);
  });

  it("is fenced once the claim is superseded", async () => {
    await add("released-zombie");
    const claim = await claimNext(prisma, "worker-one", { leaseMs: 1 });
    if (claim === null) throw new Error("tests: the claim returned nothing");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await reapExpired(prisma);
    const second = await claimNext(prisma, "worker-two");

    expect(await release(prisma, claim, "worker drained")).toEqual({ ok: false, fenced: true });
    const row = await prisma.job.findUniqueOrThrow({ where: { id: claim.id } });
    expect(row.status).toBe("running");
    expect(row.attempts).toBe(second?.attempts);
  });
});
