import { z } from "zod";

import { recordSideEffect } from "@/lib/repo/sideEffects";
import { TerminalError } from "@/worker/errors";
import type { Handler } from "@/worker/handlers/index";

/**
 * Wait, then record that it happened. The job proof 2 kills.
 *
 * It is the smallest thing shaped like the work Relay actually does: it takes
 * long enough to be interrupted half-way, and it ends in a side effect that
 * must happen once however many times the job is attempted. Kill the worker
 * during the wait and the side effect has not happened; the reaper requeues
 * the job, a fresh worker waits again and records it, and there is one row.
 * That is the whole of §24's kill-mid-run question, with the send replaced by
 * a row so the test can assert on it.
 */

const input = z.object({
  /** How long to wait. Bounded: an unbounded value is a lease this handler cannot hold. */
  ms: z.number().int().min(0).max(600_000),
  /**
   * Names the effect, not the attempt. Derived by whoever enqueued the job
   * from what the job is *about*, exactly like the idempotency key, because a
   * key that changed between attempts would record the effect twice and prove
   * nothing.
   */
  sideEffectKey: z.string().min(1),
});

export const sleep: Handler = async ({ db, job, signal }) => {
  const parsed = input.safeParse(job.input);
  if (!parsed.success) {
    // Terminal, not retryable: three more attempts will read the same input
    // and reach the same conclusion, three lease-lengths apart.
    throw new TerminalError(
      `sleep: bad input (${parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")})`,
    );
  }
  const { ms, sideEffectKey } = parsed.data;

  await wait(ms, signal);

  const { duplicate } = await recordSideEffect(db, {
    orgId: job.orgId,
    key: sideEffectKey,
    jobId: job.id,
  });
  if (duplicate) {
    // For a real send this would be "someone already did it, stop quietly".
    // Here it is an error on purpose, so that a test can distinguish "the
    // retry re-recorded the effect" (which would be the bug) from "the retry
    // found it already recorded" — a handler that returned success either way
    // could not tell the two apart.
    throw new TerminalError(`sleep: the side effect ${JSON.stringify(sideEffectKey)} is already recorded`);
  }

  return { ok: true, sleptMs: ms };
};

/**
 * `setTimeout` that gives up when the signal does.
 *
 * The signal is checked before the timer is armed as well as after: a handler
 * started on a lease that was already lost would otherwise wait the full
 * duration before noticing.
 */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(asError(signal.reason));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(asError(signal.reason));
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}
