import type { Handler } from "@/worker/handlers/index";

/**
 * The job that does nothing, successfully.
 *
 * Proof 5 of the runtime rubric is this handler and nothing else: `npm run
 * worker -- --once` against the compose Postgres, with no `NEXT_*`, `CLERK_*`
 * or `VERCEL_*` in the environment, claims one of these and completes it. What
 * is being proved is the loop and the boundary, so the work has to be empty —
 * anything it did would be a second thing that could fail.
 */
export const noop: Handler = () => Promise.resolve({ ok: true });
