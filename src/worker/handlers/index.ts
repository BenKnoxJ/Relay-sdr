import type { Job, PrismaClient } from "@prisma/client";

import { echo } from "@/worker/handlers/echo";
import { research } from "@/worker/handlers/research";
import { noop } from "@/worker/handlers/noop";
import { sleep } from "@/worker/handlers/sleep";

/**
 * The registry: job kind → the function that does it.
 *
 * Three entries today, and none of them is real work. `noop` is what proof 5
 * runs to show a worker can claim and finish a job on Docker Postgres alone,
 * `sleep` is what proof 2 kills half-way through to show a retry does its side
 * effect once, and `echo` is proof 1's walking skeleton: the agent runtime end to
 * end on a stub definition, so that the loop, the step records and the cost
 * arithmetic are proved before a real specialist runs. The specialists are Tasks
 * 7 and 12 and land as more entries in this object; nothing else about the loop
 * changes when they do, which is the point of the shape.
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

export const handlers: Record<string, Handler> = { noop, sleep, echo, research };

/**
 * The handler for a kind, or undefined. The loop REQUEUES an unknown kind
 * rather than failing it outright — see the comment at that branch in
 * `worker/main.ts` for why — so it still ends in `failed`, but only once the
 * attempts are spent.
 */
export function handlerFor(kind: string): Handler | undefined {
  // `Object.hasOwn`, not a plain index: `handlers["constructor"]` on a bare
  // object literal is a function, and a job whose kind is `constructor` or
  // `toString` would otherwise be "handled" by one.
  return Object.hasOwn(handlers, kind) ? handlers[kind] : undefined;
}
