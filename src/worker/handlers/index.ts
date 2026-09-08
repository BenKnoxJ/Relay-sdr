import type { Job, PrismaClient } from "@prisma/client";

import { noop } from "@/worker/handlers/noop";
import { sleep } from "@/worker/handlers/sleep";

/**
 * The registry: job kind → the function that does it.
 *
 * Two entries today, and neither of them is real work. `noop` is what proof 5
 * runs to show a worker can claim and finish a job on Docker Postgres alone,
 * and `sleep` is what proof 2 kills half-way through to show a retry does its
 * side effect once. The agent runtime is Task 6 and lands as more entries in
 * this object; nothing else about the loop changes when it does, which is the
 * point of the shape.
 */

/** What every handler is given. The database is passed in, never imported: the
 * worker's entry point opens it dynamically so a misconfigured environment
 * comes out as the JSON error line rather than a stack trace on load. */
export type HandlerContext = {
  db: PrismaClient;
  job: Job;
  /**
   * Aborted when this worker loses the job's lease, or when a draining worker
   * runs out of time. A handler that ignores it keeps working on a job someone
   * else now owns, so anything that waits must take it.
   */
  signal: AbortSignal;
};

/**
 * What a handler returns: whatever it wants to say about what it did, as JSON.
 * It is hashed into `Job.responseDigest` and never stored whole — the digest
 * is there to tell two attempts' outputs apart, not to be a record of them.
 */
export type HandlerResult = unknown;

export type Handler = (context: HandlerContext) => Promise<HandlerResult>;

export const handlers: Record<string, Handler> = { noop, sleep };

/** The handler for a kind, or undefined — which the loop fails the job for. */
export function handlerFor(kind: string): Handler | undefined {
  // `Object.hasOwn`, not a plain index: `handlers["constructor"]` on a bare
  // object literal is a function, and a job whose kind is `constructor` or
  // `toString` would otherwise be "handled" by one.
  return Object.hasOwn(handlers, kind) ? handlers[kind] : undefined;
}
