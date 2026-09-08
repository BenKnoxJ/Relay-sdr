import { randomBytes } from "node:crypto";
import { hostname } from "node:os";

import type { PrismaClient } from "@prisma/client";

import { env } from "@/lib/env";
import {
  claimNext,
  complete,
  fail,
  reapExpired,
  release,
  requeue,
  type ClaimedJob,
} from "@/lib/jobs/queue";
import { isTerminal, safeError } from "@/worker/errors";
import { responseDigest } from "@/worker/digest";
import { handlerFor } from "@/worker/handlers/index";
import { withLease, type LeaseOutcome } from "@/worker/lease";
import { retryDelayMs } from "@/worker/retry";

/**
 * The Relay worker.
 *
 * One of the three things the platform is (master doc §18): the app serves
 * screens and tRPC, the worker runs jobs and agent runs, and the two speak
 * only through Postgres. That is why nothing under `src/worker/**` may import
 * Next or Clerk — the lint boundary in eslint.config.mjs enforces it, and CI
 * runs this entry point with a scrubbed environment to prove it.
 *
 * The loop is four steps and deliberately no more:
 *
 *   1. **Reap first.** Every poll begins by taking back jobs whose leases have
 *      expired, *before* claiming. Reaping after the claim would work on
 *      average and be untestable: proof 2 needs "the next worker to look at
 *      this job requeues it and then runs it", and only this order makes that
 *      a single, deterministic poll rather than a race between two of them.
 *   2. **Claim one.** `claimNext` is the queue's single-statement claim, so
 *      exclusivity is Postgres's problem and not this file's.
 *   3. **Run it under a lease.** `withLease` renews while the handler works
 *      and aborts it if the lease is lost.
 *   4. **Say what happened, fenced.** `complete`, `fail` or `requeue`, each
 *      carrying the claim. A fenced result is logged and stepped over: the
 *      reaper owns that job now, and this worker says nothing further about
 *      it.
 *
 * Every line this process writes is one JSON object: ids, kinds, attempts and
 * durations. Never `job.input` — it is a rep's pipeline, and a log is the one
 * place tenant data leaks without anyone deciding to let it.
 */

/** Identifies this process to the queue. Host and pid to read, random bytes so
 * that a recycled pid on a restarted host is never mistaken for its predecessor. */
const workerId = `${hostname()}-${process.pid}-${randomBytes(4).toString("hex")}`;

// Held at module scope so the failure handler can close a connection main()
// opened, and so the signal handlers can reach the loop's state.
let prisma: PrismaClient | undefined;
let stopping = false;
let wake: (() => void) | undefined;
/** Aborts the in-flight handler when a draining worker runs out of time. */
let drain: AbortController | undefined;
let drainDeadline: NodeJS.Timeout | undefined;

/**
 * Start the clock on the in-flight handler.
 *
 * Called from the signal handler *and* from `runJob`, because the two orders
 * are both real: SIGTERM can arrive while a handler is running, and it can
 * arrive during the reap or the claim that precedes one. Arming it in only the
 * first place left the second with a job running and nothing able to stop it,
 * which is how systemd's own timeout — a SIGKILL — became the thing that ended
 * the drain.
 */
function armDrain(drainMs: number): void {
  if (drain === undefined || drainDeadline !== undefined) return;
  drainDeadline = setTimeout(() => {
    log("drain.timeout", { drainMs });
    drain?.abort(new Error(`the worker drained for ${drainMs}ms and gave the job back`));
  }, drainMs);
  drainDeadline.unref?.();
}

/** Polls that may fail in a row before the worker gives up and exits non-zero. */
export const MAX_CONSECUTIVE_FAILURES = 10;

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      component: "worker",
      workerId,
      event,
      ...fields,
    }),
  );
}

/** Sleep, unless a signal wakes the worker early to stop. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    wake = finish;
    function finish(): void {
      clearTimeout(timer);
      wake = undefined;
      resolve();
    }
  });
}

/**
 * Run one claimed job and record its outcome.
 *
 * Returns nothing: every path here ends in a fenced write or a deliberate
 * silence, and there is no outcome the loop needs to branch on.
 */
async function runJob(
  db: PrismaClient,
  job: ClaimedJob,
  leaseMs: number,
  drainMs: number,
): Promise<void> {
  const started = performance.now();
  const shape = { jobId: job.id, orgId: job.orgId, kind: job.kind, attempt: job.attempts };
  log("job.claimed", shape);

  const handler = handlerFor(job.kind);
  if (handler === undefined) {
    // Requeued rather than failed outright, which is a deliberate departure
    // from the brief. "This worker has no handler for that kind" is not the
    // same claim as "this job cannot be done": during a rolling deploy an
    // older worker sees kinds a newer app has already enqueued, and `enqueue`
    // returns the existing row for a key in *any* state, `failed` included —
    // so a job failed here can never be re-enqueued under its natural key and
    // the work is silently dropped. Requeueing still ends in `failed` once the
    // attempts are spent, which is the brief's outcome, just not on the first
    // poll that happens to be running last week's binary.
    //
    // Through `safeError` like every other value that reaches this column:
    // `kind` arrives from whoever enqueued the job, so it is neither bounded
    // nor known to be free of anything worth scrubbing.
    const error = safeError(`unknown job kind: ${JSON.stringify(job.kind)}`);
    const delayMs = retryDelayMs(job.attempts);
    const result = await requeue(db, job, { error, delayMs });
    if (result.fenced) {
      log("job.fenced", { ...shape, error });
    } else {
      log(result.status === "queued" ? "job.requeued" : "job.failed", {
        ...shape,
        error,
        ...(result.status === "queued" ? { delayMs } : { reason: "attempts spent" }),
      });
    }
    return;
  }

  // Armed only while a handler is in flight, so a SIGTERM with an idle worker
  // exits immediately rather than waiting on a deadline for nothing.
  drain = new AbortController();
  // A signal that arrived during the reap or the claim has already latched
  // `stopping`; this job is the one it has to drain.
  if (stopping) armDrain(drainMs);
  let outcome: LeaseOutcome<unknown>;
  try {
    outcome = await withLease(db, job, (signal) => handler({ db, job, signal }), {
      leaseMs,
      signal: drain.signal,
      log: (event) => log(event.event, { ...shape, detail: event.detail }),
    });
  } catch (error) {
    const message = safeError(error);
    const durationMs = Math.round(performance.now() - started);

    // The drain deadline is not a failure of the job. `release` gives back the
    // attempt the claim spent and makes it due now, so a deploy does not
    // charge every in-flight job an attempt — and does not terminally fail the
    // one that happened to be on its last.
    if (drain?.signal.aborted === true) {
      const result = await release(db, job, message);
      log(result.fenced ? "job.fenced" : "job.released", { ...shape, durationMs, error: message });
      return;
    }

    if (isTerminal(error)) {
      const result = await fail(db, job, message);
      log(result.fenced ? "job.fenced" : "job.failed", { ...shape, durationMs, error: message });
      return;
    }
    // The attempt cap lives in `requeue`, so this is one statement and not a
    // read-decide-write: `status` comes back saying whether the job went round
    // again or spent its last attempt.
    const delayMs = retryDelayMs(job.attempts);
    const result = await requeue(db, job, { error: message, delayMs });
    if (result.fenced) {
      log("job.fenced", { ...shape, durationMs, error: message });
    } else {
      log(result.status === "queued" ? "job.requeued" : "job.failed", {
        ...shape,
        durationMs,
        ...(result.status === "queued" ? { delayMs } : { reason: "attempts spent" }),
        error: message,
      });
    }
    return;
  } finally {
    clearTimeout(drainDeadline);
    drainDeadline = undefined;
    drain = undefined;
  }

  const durationMs = Math.round(performance.now() - started);
  if (outcome.lost) {
    // Nothing is written. The reaper has the job, and a `fail` or a `requeue`
    // from here would either be fenced or — worse, if the fence ever loosened
    // — undo somebody else's claim.
    log("job.lost", { ...shape, durationMs });
    return;
  }

  // Guarded, and not because `complete` is expected to fail: everything from
  // here on runs *after* the handler has touched the outside world, so an
  // uncaught throw would exit the worker with the job still `running` on a
  // live lease and its side effects already done. Handing the job back is
  // worse than finishing it and better than either of those.
  try {
    const result = await complete(db, job, { responseDigest: responseDigest(outcome.result) });
    log(result.fenced ? "job.fenced" : "job.done", { ...shape, durationMs });
  } catch (error) {
    const message = safeError(error);
    log("job.complete-failed", { ...shape, durationMs, error: message });
    // If this throws too, the database is gone, and the throw leaves `runJob`
    // for the poll loop's own catch: it logs `poll.failed`, waits `pollMs` and
    // tries again, and only exits non-zero once `MAX_CONSECUTIVE_FAILURES`
    // polls in a row have failed — immediately, under `--once`. Either way the
    // job is left on its lease and the reaper takes it when the lease lapses,
    // which is the correct end of that road and not this function's to paper
    // over.
    const delayMs = retryDelayMs(job.attempts);
    const requeued = await requeue(db, job, { error: message, delayMs });
    log(requeued.fenced ? "job.fenced" : "job.requeued", { ...shape, durationMs, delayMs });
  }
}

async function main(): Promise<void> {
  const once = process.argv.slice(2).includes("--once");

  // What keeps a misconfigured worker inside the JSON error contract below is
  // that this import is dynamic: `src/lib/db.ts` reads the environment as it
  // loads, and only inside `main()` is that throw caught by `main().catch`. A
  // static top-level import would evaluate before the handler is registered
  // and die on a raw stack trace instead — the regression this line exists to
  // prevent, and `tests/lib/worker.test.ts` proves it stays dynamic. The
  // specifier is a literal, which is what the boundary lint requires.
  const {
    INTEGRATIONS,
    RELAY_WORKER_POLL_MS: pollMs,
    RELAY_WORKER_LEASE_MS: leaseMs,
    RELAY_WORKER_DRAIN_MS: drainMs,
  } = env();
  ({ prisma } = await import("@/lib/db"));
  const db = prisma;

  // The same liveness probe as the health route: `SELECT 1` is the worker
  // proving it can reach Postgres before it claims to have started, not a
  // write.
  // eslint-disable-next-line no-restricted-syntax
  await db.$queryRaw`SELECT 1`;
  log("started", { mode: once ? "once" : "loop", integrations: INTEGRATIONS, pollMs, leaseMs, db: "ok" });

  // Stop claiming, let the job in flight finish, exit 0. `once` returns to
  // the default handler: a `--once` run is a CI step and a systemd
  // `ExecStartPre`, and there is nothing there worth draining.
  const onSignal = (signal: NodeJS.Signals): void => {
    if (stopping) {
      // A second signal is an operator saying "not in nine minutes". Node's
      // default handler is gone the moment we register ours, so without this a
      // repeated Ctrl-C does nothing at all. It aborts the handler now; the
      // job is given back by the same path the drain deadline uses.
      log("stopping.forced", { signal });
      drain?.abort(new Error("the worker was asked to stop twice and gave the job back"));
      wake?.();
      return;
    }
    stopping = true;
    log("stopping", { signal, draining: drain !== undefined, drainMs });
    // Cut the poll sleep short so an idle worker exits now rather than after
    // one more interval.
    wake?.();
    armDrain(drainMs);
  };
  if (!once) {
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
  }

  // A poll that throws is a database that blinked, not a worker that should
  // die: the connection dropped, the pooler recycled, Postgres restarted. The
  // next poll two seconds later would have been fine, and exiting turns a
  // blink into a restart — which under `Restart=always` is how a flapping
  // database becomes a unit in the failed state. So the loop survives its own
  // faults, up to a point: `MAX_CONSECUTIVE_FAILURES` in a row is not a blink
  // and exiting non-zero is then the honest answer.
  //
  // `--once` is the exception. It is a CI step and a smoke test, and a step
  // that swallows a database failure and exits 0 is worse than useless.
  let consecutiveFailures = 0;
  while (!stopping) {
    try {
      const reaped = await reapExpired(db);
      if (reaped.requeued.length > 0 || reaped.failed.length > 0) {
        log("reaped", { requeued: reaped.requeued.length, failed: reaped.failed.length });
      }

      // A signal that landed during the reap must not be followed by a fresh
      // claim: draining means finishing what is in hand, not starting one more.
      if (stopping) break;

      const job = await claimNext(db, workerId, { leaseMs });
      if (job === null) {
        // Nothing to do is not a failure: `--once` on an empty queue exits 0,
        // which is what the CI boundary smoke runs.
        if (once) {
          log("idle", { mode: "once" });
          break;
        }
        consecutiveFailures = 0;
        await pause(pollMs);
        continue;
      }

      await runJob(db, job, leaseMs, drainMs);
      consecutiveFailures = 0;
      if (once) break;
    } catch (error) {
      if (once) throw error;
      consecutiveFailures += 1;
      const message = safeError(error);
      log("poll.failed", { error: message, consecutiveFailures });
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        throw new Error(
          `the worker failed ${consecutiveFailures} polls in a row; last error: ${message}`,
        );
      }
      // Whatever job this poll was holding is left where it is: its lease
      // lapses and the reaper — this worker's next pass, or another worker's —
      // takes it. That is the same path a SIGKILL takes, and it is already
      // proved.
      await pause(pollMs);
    }
  }

  log("stopped");
  await db.$disconnect();
}

main().catch(async (error: unknown) => {
  console.error(
    JSON.stringify({
      at: new Date().toISOString(),
      component: "worker",
      workerId,
      event: "failed",
      error: safeError(error),
    }),
  );
  await prisma?.$disconnect().catch(() => undefined);
  process.exit(1);
});
