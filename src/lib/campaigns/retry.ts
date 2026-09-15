import type { JobStatus } from "@prisma/client";

/**
 * What can be tried again, decided once (product-truth foundation, 2026-09-15).
 *
 * The campaign screens and the mutations behind them both read these, so a
 * page can never offer a Try again the server will refuse, and the server can
 * never accept one the page did not offer. Pure: nothing here reads the
 * database.
 */

/** The parts of a job these decisions read. */
export type JobFacts = { status: JobStatus; error: string | null; attempts: number; maxAttempts: number };

export const inFlight = (job: Pick<JobFacts, "status"> | null): boolean => job !== null && (job.status === "queued" || job.status === "running");

/**
 * Research's Try again puts the failed job back on the queue (`reopenFailed`),
 * which takes a `failed` job only. A cancelled job, a done job with no pack,
 * and a pack Relay could not read are changed with Edit brief instead.
 */
export function researchRetryable(job: Pick<JobFacts, "status"> | null, hasResult: boolean): boolean {
  return job !== null && !hasResult && job.status === "failed";
}

/**
 * The lead gen and reveal handlers' own terminal failures: another run reads
 * the same input and fails the same way (`src/worker/handlers/leadGen.ts`,
 * `reveal.ts`). Matched on the words those handlers write, and nothing wider.
 */
const TERMINAL = [
  /\blead gen: bad input\b/,
  /\blead gen: the frozen handoff does not parse\b/,
  /\blead gen: the handoff does not belong to this job\b/,
  /\blead gen: the pricing model is not the one Confirm froze\b/,
  /\blead gen: no people provider is set up\b/,
  /\breveal: bad input\b/,
  /\breveal: the reveal confirm does not parse\b/,
  /\breveal: the reveal confirm does not belong to this job\b/,
  /\breveal: the pricing model is not the one the reveal was approved with\b/,
  /\breveal: no people provider is set up\b/,
  /\breveal: the kept people are not the ones the reveal was approved for\b/,
];

export function isTerminalFailure(error: string | null): boolean {
  const text = error ?? "";
  return TERMINAL.some((pattern) => pattern.test(text));
}

/** A lead gen result, as far as retrying reads it. */
export type LeadGenResultFacts = { kind: "picked" } | { kind: "halted"; reason: string; choices?: number } | { kind: "unreadable" };

const RETRY_HALTS = new Set(["provider_busy", "took_too_long"]);

/**
 * Finding people again is a new run under the same Confirm and the same cap
 * (`rerunPeople`), so what matters is whether another run could come out
 * differently: a busy provider or a timeout could, and so could a job that
 * failed or was cancelled for any reason but its own terminal ones.
 */
export function leadGenRetryable(job: Pick<JobFacts, "status" | "error"> | null, result: LeadGenResultFacts | null): boolean {
  if (result !== null) return result.kind === "halted" && RETRY_HALTS.has(result.reason);
  if (job === null) return false;
  return (job.status === "failed" || job.status === "cancelled") && !isTerminalFailure(job.error);
}

/** The reveal ledger for one reveal approval, as row counts by state. */
export type LedgerCounts = { reserved: number; unreconciled: number; reconciled: number; released: number };
export const NO_LEDGER: LedgerCounts = { reserved: 0, unreconciled: 0, reconciled: 0, released: 0 };

/**
 * Why a reveal that stopped before recording its result needs the rep, and
 * whether Try again is safe.
 *
 *   * `spend_unresolved`: a request may have reached the provider (a
 *     reservation still open or unknown, or a charge with no result recorded).
 *     Buying again could buy the same emails twice, so nothing is bought again
 *     automatically and there is no Try again.
 *   * `failed`: the job failed and no request ever left Relay (every ledger
 *     row, if any, was released). Try again puts the same job back on the
 *     queue for the same kept people and the same approval.
 *   * `failed_terminal`: the job failed for a reason another attempt cannot
 *     fix.
 *   * `stopped`: cancelled, or finished with no result, and nothing left Relay.
 *     There is no job to put back; Edit brief is the way on.
 */
export type RevealRecovery = { reason: "spend_unresolved" | "failed" | "failed_terminal" | "stopped"; retryable: boolean };

export function revealRecovery(job: Pick<JobFacts, "status" | "error"> | null, ledger: LedgerCounts): RevealRecovery {
  if (ledger.reserved + ledger.unreconciled + ledger.reconciled > 0) return { reason: "spend_unresolved", retryable: false };
  if (job === null || job.status !== "failed") return { reason: "stopped", retryable: false };
  if (isTerminalFailure(job.error)) return { reason: "failed_terminal", retryable: false };
  return { reason: "failed", retryable: true };
}

/**
 * Edit brief moves the campaign to a new brief version. Never while any of
 * its work at the current version is still on the queue or running: research
 * reading, people being found, or emails being revealed.
 */
export function editAllowed(work: { researchInFlight: boolean; leadGenInFlight: boolean; revealInFlight: boolean }): boolean {
  return !work.researchInFlight && !work.leadGenInFlight && !work.revealInFlight;
}
