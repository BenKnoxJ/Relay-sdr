/**
 * How long a failed attempt waits before the next one.
 *
 * Its own module for the same reason as `digest.ts`: `main.ts` runs on import.
 */

/** Base of the retry back-off, doubled per attempt and capped. */
export const RETRY_BASE_MS = 10_000;
export const RETRY_MAX_MS = 300_000;

/** How long a retried attempt waits, given the attempt that just failed. */
export function retryDelayMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(exponent, 20));
}
