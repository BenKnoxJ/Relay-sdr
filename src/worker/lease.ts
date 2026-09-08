import type { PrismaClient } from "@prisma/client";

import { EXTEND_EVERY_MS, LEASE_MS, extendLease, type Claim } from "@/lib/jobs/queue";
import { safeError } from "@/worker/errors";

/**
 * Holding a job's lease open for as long as its handler runs.
 *
 * The plan's top risk, stated plainly: a handler outlives `LEASE_MS`, the
 * reaper decides the worker is dead and requeues the job, a second worker
 * starts the same work — and the first is still running, still about to send
 * the email the second is also about to send. `extendLease` is the queue's
 * answer to the first half; this file is the other half, which is that
 * somebody has to call it, on a timer, and has to react when it says no.
 *
 * Reacting is the part that is easy to leave out. A fenced extension is not a
 * failure to be logged and retried: it is the definitive statement that this
 * worker no longer holds the job. The handler must stop, and it must stop
 * *without* the worker writing anything about the job afterwards — no
 * `complete`, no `fail`, no `requeue`. The reaper already owns the row, and
 * every one of those writes would be fenced anyway. So the handler is aborted
 * through an `AbortSignal` and `withLease` reports `lost`.
 */

/**
 * Why a handler's signal aborted. `withLease` distinguishes the two, because
 * they end differently: a lost lease means say nothing about the job, and an
 * outside abort (the drain deadline) is the worker's own decision and is
 * reported to the caller as a thrown error to handle.
 */
export class LeaseLostError extends Error {
  constructor(readonly jobId: string) {
    super("the lease on this job was lost");
    this.name = "LeaseLostError";
  }
}

export type LeaseOutcome<T> =
  /** The handler finished while this worker still held the job. */
  | { ok: true; lost: false; result: T }
  /** The lease went; the reaper owns the job and the caller must not write to it. */
  | { ok: false; lost: true };

export type WithLeaseOptions = {
  leaseMs?: number;
  extendEveryMs?: number;
  /** Aborts the handler for a reason of the caller's own — the drain deadline. */
  signal?: AbortSignal;
  /** One JSON line per lease event. Omitted, the lease keeps quiet. */
  log?: (event: { event: string; jobId: string; detail?: string }) => void;
};

/**
 * Run `handler` while keeping this claim's lease alive.
 *
 * Returns `{lost: true}` when the lease went, and throws whatever the handler
 * threw otherwise. The timer is cleared in a `finally`, so a handler that
 * throws does not leave a worker renewing a lease on a job nobody is doing.
 */
export async function withLease<T>(
  db: PrismaClient,
  claim: Claim,
  handler: (signal: AbortSignal) => Promise<T>,
  options: WithLeaseOptions = {},
): Promise<LeaseOutcome<T>> {
  const leaseMs = options.leaseMs ?? LEASE_MS;
  // A quarter of the lease by default, matching the queue's own constant: two
  // extensions can be lost to a slow database before the job is reaped out
  // from under a worker that is alive and working.
  const extendEveryMs = options.extendEveryMs ?? Math.max(1, Math.min(EXTEND_EVERY_MS, Math.floor(leaseMs / 4)));
  const log = options.log ?? (() => undefined);

  const keeper = new AbortController();
  // `AbortSignal.any` so the handler sees one signal whichever side fires, and
  // `reason` says which: a `LeaseLostError` is the lease, anything else is the
  // caller's abort and is re-thrown rather than swallowed as a lost lease.
  const signal =
    options.signal === undefined
      ? keeper.signal
      : AbortSignal.any([keeper.signal, options.signal]);

  let lost = false;
  // Set once the handler has returned. An `extendLease` still in flight at
  // that moment settles *after* `complete` has moved the row, so it comes back
  // fenced — and calling that a lost lease would log the module's most
  // alarming event for a job that finished cleanly.
  let settled = false;
  // Durations, never instants, and from a monotonic clock: this is the one
  // place the worker reasons about time without asking the database, and it is
  // allowed to because it compares two readings of its own clock rather than
  // one of its own against one of Postgres's.
  let lastExtendedAt = performance.now();
  let extending = false;

  /**
   * How long without a *successful* extension before the handler is stopped.
   *
   * One tick short of the lease, not the whole lease: the lease in the
   * database was set at the last success, so waiting the full `leaseMs` to
   * give up means giving up at the earliest moment the reaper could already
   * have taken the job — an overlap window where two workers are doing the
   * same job, which is the entire thing this file exists to prevent.
   */
  const staleAfterMs = Math.max(1, leaseMs - extendEveryMs);

  const lose = (why: string): void => {
    if (lost || settled) return;
    lost = true;
    log({ event: "lease.lost", jobId: claim.id, detail: why });
    keeper.abort(new LeaseLostError(claim.id));
  };

  const timer = setInterval(() => {
    if (lost) return;

    // Checked first, and outside the in-flight guard below. An `extendLease`
    // that throws is not the dangerous case — the next tick retries it. The
    // dangerous case is one that never settles at all (a connection gone away
    // with no timeout), because then `extending` is true for ever and a check
    // living inside the failure path would never run again. So the age of the
    // last success is the thing that decides, and it is read on every tick
    // whatever the previous one is doing.
    const elapsed = performance.now() - lastExtendedAt;
    if (elapsed >= staleAfterMs) {
      lose(`the lease has not been extended for ${Math.round(elapsed)}ms`);
      return;
    }

    // An extension that has not come back yet must not have a second one
    // stacked on top of it: a database slow enough to need that is a database
    // about to receive a queue of them.
    if (extending) return;
    extending = true;

    void extendLease(db, claim, { leaseMs })
      .then((result) => {
        if (result.fenced) {
          lose("the extension was fenced");
          return;
        }
        lastExtendedAt = performance.now();
      })
      .catch((error: unknown) => {
        // Logged, not fatal: the database blinked and the next tick may well
        // succeed. Whether this becomes fatal is the staleness check above,
        // which does not care why the extensions stopped landing.
        //
        // Scrubbed, though it goes to stdout rather than `Job.error`. This is
        // the worker's only error string on that path, and the failure that
        // reaches it most often is Prisma's — which quotes the connection
        // string it could not reach, password and all.
        log({
          event: "lease.extend-failed",
          jobId: claim.id,
          detail: safeError(error),
        });
      })
      .finally(() => {
        extending = false;
      });
  }, extendEveryMs);
  // Node keeps the process alive for a pending timer; this one must never be
  // the reason a finished worker will not exit.
  timer.unref?.();

  try {
    const result = await handler(signal);
    // Checked after the handler as well as inside it: a handler that ignores
    // its signal and returns anyway must still not be allowed to `complete` a
    // job someone else now holds.
    if (lost) return { ok: false, lost: true };
    return { ok: true, lost: false, result };
  } catch (error) {
    if (error instanceof LeaseLostError || lost) return { ok: false, lost: true };
    throw error;
  } finally {
    settled = true;
    clearInterval(timer);
  }
}
