import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db";
import { claimNext, complete, enqueue, reapExpired } from "@/lib/jobs/queue";
import { mutate } from "@/lib/repo/mutate";
import { LeaseLostError, withLease } from "@/worker/lease";

import { emptyAll, resetDatabase } from "../db/harness";

/**
 * `withLease` on its own: the timer that keeps a claim alive, and what happens
 * when it cannot.
 *
 * The kill proof exercises this through a whole worker process; these are the
 * two cases stated directly, because "the handler outran its lease and the job
 * survived" and "the handler outran its lease and was told to stop" differ by
 * one row's worth of state and are worth being able to fail separately.
 */

const ORG_ID = "org_worker_lease";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

const queueOne = async (key: string) => {
  await enqueue(prisma, { orgId: ORG_ID, kind: "noop", idempotencyKey: key, input: {} });
  const claim = await claimNext(prisma, `worker-${key}`, { leaseMs: 600 });
  if (claim === null) throw new Error("tests: the claim returned nothing");
  return claim;
};

describe("withLease", () => {
  it("keeps a handler that outlives its lease alive by extending it", async () => {
    const claim = await queueOne("long");

    const outcome = await withLease(
      prisma,
      claim,
      async () => {
        // Half-way through, and well past the 600ms lease the claim was taken
        // on: the reaper must find nothing, because the timer has moved the
        // lease forward.
        await delay(1_000);
        expect(await reapExpired(prisma)).toEqual({ requeued: [], failed: [] });
        await delay(1_000);
        return { ok: true };
      },
      { leaseMs: 600, extendEveryMs: 150 },
    );

    expect(outcome).toEqual({ ok: true, lost: false, result: { ok: true } });
    // Still ours to finish.
    expect(await complete(prisma, claim, {})).toEqual({ ok: true, fenced: false });
  }, 30_000);

  it("aborts the handler and reports the job lost once the claim is superseded", async () => {
    const claim = await queueOne("superseded");

    // Age the lease and let the reaper have it, then let a second worker take
    // it. Done before the handler starts so the sequence is deterministic: an
    // extension landing first would push the lease forward and there would be
    // nothing for the reaper to find.
    await prisma.$executeRawUnsafe(
      `UPDATE jobs SET lease_until = (now() AT TIME ZONE 'UTC') - interval '1 second' WHERE id = $1`,
      claim.id,
    );
    expect((await reapExpired(prisma)).requeued).toEqual([claim.id]);
    const second = await claimNext(prisma, "worker-two", { leaseMs: 60_000 });
    expect(second?.id).toBe(claim.id);
    expect(second?.attempts).toBe(2);

    let sawAbort = false;
    const outcome = await withLease(
      prisma,
      claim,
      async (signal) => {
        // Five seconds it will never spend: the first extension is fenced.
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 5_000);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              sawAbort = signal.reason instanceof LeaseLostError;
              reject(signal.reason as Error);
            },
            { once: true },
          );
        });
        return { ok: true };
      },
      { leaseMs: 600, extendEveryMs: 50 },
    );

    expect(sawAbort).toBe(true);
    expect(outcome).toEqual({ ok: false, lost: true });
    // And the worker that lost it cannot write to it. This is the assertion
    // the loop's silence rests on: a `complete` from here is fenced, so the
    // job the second worker holds is untouched.
    expect(await complete(prisma, claim, {})).toEqual({ ok: false, fenced: true });
    const row = await prisma.job.findUniqueOrThrow({ where: { id: claim.id } });
    expect(row.status).toBe("running");
    expect(row.workerId).toBe("worker-two");
  }, 30_000);


  it.each([
    ["never settles", () => new Promise<never>(() => undefined)],
    ["keeps failing", () => Promise.reject(new Error("connection terminated"))],
  ])("stops the handler when the extension %s", async (_name, behaviour) => {
    const claim = await queueOne(`stuck-${_name.replace(/\s+/g, "-")}`);

    // A database that answers neither way is the case the in-flight guard
    // hides: with the give-up check living in the failure path, an extension
    // that never settles would leave the guard latched and the check
    // unreachable, and the handler would run on past the reaper.
    const stuck = { $queryRaw: behaviour } as unknown as PrismaClient;

    const outcome = await withLease(
      stuck,
      claim,
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("the handler was never stopped")), 5_000);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(signal.reason as Error);
            },
            { once: true },
          );
        }),
      { leaseMs: 400, extendEveryMs: 100 },
    );

    expect(outcome).toEqual({ ok: false, lost: true });
    // The job is still this worker's as far as the database knows — nothing
    // reaped it — which is exactly why stopping had to be decided locally.
    await complete(prisma, claim, {});
  }, 30_000);

  it("re-throws a handler's own failure rather than calling it a lost lease", async () => {
    const claim = await queueOne("throws");
    await expect(
      withLease(prisma, claim, () => Promise.reject(new Error("boom")), {
        leaseMs: 60_000,
        extendEveryMs: 30_000,
      }),
    ).rejects.toThrow("boom");
  }, 30_000);

  it("re-throws an abort that came from the caller, which is the drain and not the lease", async () => {
    const claim = await queueOne("drained");
    const drain = new AbortController();
    setTimeout(() => drain.abort(new Error("the worker drained")), 50);

    await expect(
      withLease(
        prisma,
        claim,
        (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
          }),
        { leaseMs: 60_000, extendEveryMs: 30_000, signal: drain.signal },
      ),
    ).rejects.toThrow("the worker drained");

    // The distinction matters: the loop requeues on this path and says nothing
    // at all on the lost-lease one.
    expect(await complete(prisma, claim, {})).toEqual({ ok: true, fenced: false });
  }, 30_000);
});
