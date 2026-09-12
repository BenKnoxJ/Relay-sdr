import { createHash } from "node:crypto";

import type { Prisma, PrismaClient } from "@prisma/client";

import { beginToolStep, failToolStep, finishToolStep, releaseToolStep } from "@/lib/repo/agentRuns";

/**
 * Tools that cannot be paid for twice.
 *
 * A job is retried. §24's whole durability story is that a worker can be killed
 * mid-run and the next one picks the job up — which means every tool call in the
 * run is about to happen a second time. For a search that costs a credit or a
 * fetch that costs a page, a second time is a second charge for an answer we
 * already have.
 *
 * So a tool call is keyed by what it *is* rather than by which attempt made it:
 * `sha256(orgId, jobId, runKind, toolName, the caller's discriminator)`. The key
 * is a unique index on `agent_run_steps`, scoped to the org for the same reason
 * `Job.idempotencyKey` is. A call whose key already has a step returns that
 * step's stored output and does not run. A call whose key is new writes its
 * input first, runs, and writes its output — so a worker killed mid-call leaves
 * a row saying what was attempted rather than no trace at all.
 *
 * The key deliberately does **not** include the run id, and deliberately **does**
 * include the job id. Both halves matter, and the second is a departure from the
 * brief, which specified `(orgId, runKind, name, discriminator)`:
 *
 *   * no run id, because a retry is a *new run* of the same job, and a key that
 *     changed with the run would replay nothing — which is the bug this exists
 *     to prevent rather than a property of it;
 *   * the job id, because without it the key is a permanent org-wide cache of
 *     every search and fetch Relay has ever made. A `search("claims ops UK")`
 *     run for one campaign in March would be replayed verbatim into a new
 *     campaign in September, and research v2 §5 rule 1 is explicit that a prior
 *     claim may enter a pack "only with a fresh URL found **this run**". The
 *     rubric row the key has to satisfy (§8 row 9) is "re-run **after a
 *     simulated kill** makes zero new search or fetch calls", which is one job,
 *     so the narrower scope passes it and the wider one buys staleness nobody
 *     asked for. Flagged for Benny-san: widening it back is a one-line change
 *     and a decision, not a fix.
 *
 * ## A failed call does not replay as an answer
 *
 * A tool that threw stores its failure on the step, and a replay of that key
 * must not hand the failure back as if the tool had returned it: a model given
 * `{ error: "TypeError" }` as a search result reasons over it as data. Failures
 * are stored under the reserved key {@link FAILURE_KEY}, which a tool's own
 * output cannot collide with, and a replay that finds one rethrows.
 *
 * ## A failure is permanent — unless the tool says it spent nothing
 *
 * The stored failure is keyed the same way a success is, so a call that
 * failed is not retried within the job by default: the second attempt replays
 * the stored failure instead of running. The cautious direction, because the
 * wrapper cannot see inside a tool and a failure after a charge is the one
 * that must never repeat.
 *
 * Task 12 gave the tool contract the one word it needed: a spec may declare
 * `unspent(error)`, and an error it answers `true` for **releases the key**
 * — the row stays as the record of the attempt, its key is cleared, and a
 * retry runs the call. Research's budget cap and a provider's refusal are the
 * two cases; a fetch that returned a page after a charge is not one.
 *
 * ## What the model sees on a replay
 *
 * The stored output, verbatim — **not** the stored output with a `replayed: true`
 * field added, which is what the brief asked for. Adding a field would make the
 * model's input differ between the first run and the replay, so the replayed
 * run would take a different path than the one whose steps it is reusing, and
 * "the retry does not re-spend" would have been bought by making the retry a
 * different run. The replay is instead reported out of band: `ToolRecorder`
 * counts it and `runAgent` returns the count, which is what the tests assert on
 * and what a reviewer reading a run needs.
 */

/** The stored failure on a step, or null when the step holds a real result. */
function failureOf(output: unknown): string | null {
  if (output === null || typeof output !== "object" || Array.isArray(output)) return null;
  const value = (output as Record<string, unknown>)[FAILURE_KEY];
  return typeof value === "string" ? value : null;
}

/** A tool's own view of the recording machinery. One per agent run. */
export type ToolRecorder = {
  readonly orgId: string;
  readonly jobId: string;
  readonly runId: string;
  readonly runKind: string;
  /** How many calls this run served from a stored step instead of running. */
  readonly replayed: number;
  /** The next step index for this run. Allocated synchronously, so parallel tool calls cannot collide. */
  takeIndex(): number;
  /** Hash the four parts into the key stored on the step. */
  key(toolName: string, discriminator: string): string;
  beginCall(input: BeginCallInput): Promise<BeginCallResult>;
  endCall(stepId: string, output: unknown): Promise<void>;
  failCall(stepId: string, error: string): Promise<void>;
  /** The call failed before it spent anything: keep the row, free the key. */
  releaseCall(stepId: string, error: string): Promise<void>;
  noteReplay(): void;
  /**
   * End the run from inside a tool, with a reason the run reports.
   *
   * A tool has no other way to stop the loop: on the Agent SDK a tool error is
   * text the model reads and reasons past. Research's budget cap uses this, so
   * a capped run ends as `cap` with the field named and no partial answer.
   */
  abortRun(reason: "cap", message: string): void;
  /** How many model steps the run has recorded so far; the budget's re-plan reads it. */
  readonly modelSteps: number;
  /** What the run has cost so far, in dollars, read live from the ledger; research's spend rail reads it. */
  readonly spendUsd: number;
};

export type BeginCallInput = {
  toolName: string;
  toolKey: string;
  index: number;
  input: unknown;
};

export type BeginCallResult =
  /** Nobody has spent this key: run the tool and call `endCall` with what it gave. */
  | { replayed: false; stepId: string }
  /** Already spent: this is what it produced, and the tool must not run. */
  | { replayed: true; output: unknown }
  /** Already spent, and it failed. The tool must not run, and the failure is the answer. */
  | { replayed: true; failure: string };

/**
 * The reserved key a failed tool step's output is stored under.
 *
 * `$` cannot start a JSON key any tool here produces, and nothing reads it but
 * the replay path. A plain `error` key would be ambiguous: a tool is entitled to
 * return `{ error: … }` as a perfectly good result.
 */
export const FAILURE_KEY = "$toolError";

export type ToolRecorderDeps = {
  db: PrismaClient;
  orgId: string;
  jobId: string;
  runId: string;
  runKind: string;
  takeIndex: () => number;
  /** How `abortRun` reaches the run's controller. `runAgent` supplies it. */
  abortRun?: (reason: "cap", message: string) => void;
  /** The run's model-step count, read live. `runAgent` supplies it. */
  modelSteps?: () => number;
  /** The run's cost so far in dollars, read live. `runAgent` supplies it. */
  spendUsd?: () => number;
};

export function createToolRecorder(deps: ToolRecorderDeps): ToolRecorder {
  let replayed = 0;
  return {
    orgId: deps.orgId,
    jobId: deps.jobId,
    runId: deps.runId,
    runKind: deps.runKind,
    get replayed() {
      return replayed;
    },
    takeIndex: deps.takeIndex,
    key: (toolName, discriminator) => toolKey(deps.orgId, deps.jobId, deps.runKind, toolName, discriminator),
    noteReplay() {
      replayed += 1;
    },
    abortRun(reason, message) {
      if (deps.abortRun === undefined) throw new Error(`abortRun(${reason}): this recorder cannot end the run — ${message}`);
      deps.abortRun(reason, message);
    },
    get modelSteps() {
      return deps.modelSteps?.() ?? 0;
    },
    get spendUsd() {
      return deps.spendUsd?.() ?? 0;
    },
    async releaseCall(stepId, error) {
      await releaseToolStep(deps.db, { orgId: deps.orgId, stepId, failureKey: FAILURE_KEY, error });
    },
    async beginCall(input) {
      const result = await beginToolStep(deps.db, {
        orgId: deps.orgId,
        runId: deps.runId,
        index: input.index,
        name: input.toolName,
        toolKey: input.toolKey,
        input: asJson(input.input),
      });
      if (result.replayed) {
        replayed += 1;
        const stored: unknown = result.step.output;
        const failure = failureOf(stored);
        if (failure !== null) return { replayed: true, failure };
        if (stored === null || stored === undefined) {
          // The row was written and never finished — a worker killed between the
          // claim and the answer. The charge may already have been made, so the
          // call must not repeat; but there is no answer to hand back either, and
          // handing back `null` would let the model treat "we do not know" as
          // "nothing found". Reported as a failure, with the step's null output
          // standing as the evidence a reviewer needs.
          return { replayed: true, failure: "the first attempt of this call was interrupted before it answered" };
        }
        return { replayed: true, output: stored };
      }
      return { replayed: false, stepId: result.step.id };
    },
    async endCall(stepId, output) {
      await finishToolStep(deps.db, { orgId: deps.orgId, stepId, output: asJson(output) });
    },
    async failCall(stepId, error) {
      await failToolStep(deps.db, { orgId: deps.orgId, stepId, failureKey: FAILURE_KEY, error });
    },
  };
}

/**
 * The key, over five parts.
 *
 * Hashed from a JSON array rather than a joined string: `["a:b", "c"]` and
 * `["a", "b:c"]` join to the same text under any single separator, and two
 * different calls sharing a key is a charge silently skipped.
 */
export function toolKey(
  orgId: string,
  jobId: string,
  runKind: string,
  toolName: string,
  discriminator: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([orgId, jobId, runKind, toolName, discriminator]))
    .digest("hex");
}

/** A replayed call whose first attempt failed. Thrown rather than returned as data. */
export class ReplayedToolFailure extends Error {
  readonly toolName: string;
  constructor(toolName: string, detail: string) {
    super(`${toolName}: ${detail}`);
    this.name = "ReplayedToolFailure";
    this.toolName = toolName;
  }
}

/** What a wrapped tool's `execute` is given and must return. */
export type ReplayableTool<ARGS, OUT> = {
  /** Must match the key this tool is registered under, and the definition's declared list. */
  name: string;
  /**
   * What makes two calls the same call. A stable rendering of the arguments
   * that matter — a query and its region, a url — and nothing that varies
   * between attempts.
   */
  toolKey: (args: ARGS) => string;
  execute: (args: ARGS) => Promise<OUT>;
  /**
   * The tool's own output shape, used to validate a **replayed** payload.
   *
   * Optional but wanted. A replayed result comes out of a `Json` column written
   * by an earlier version of the code, and `output as OUT` is an unchecked
   * assertion about a row on disk: a tool whose shape changed between deploys
   * would hand the model last week's shape and claim this week's type. Given a
   * schema, the replay is parsed and a mismatch is a failure rather than a lie.
   */
  output?: { safeParse: (value: unknown) => { success: true; data: OUT } | { success: false } };
  /**
   * True when a thrown error means the call spent nothing, so its key may be
   * released and a retry may run it. Absent means every failure is permanent.
   */
  unspent?: (error: unknown) => boolean;
};

/**
 * Wrap a tool's `execute` so the call is keyed, recorded and never repeated.
 *
 * The recorder comes in as an argument rather than being reached for, because a
 * tool has no business holding a database handle: everything it can do to the
 * database is the methods on the recorder, bound to one run.
 *
 * Three things happen that are easy to miss:
 *
 *   * **Identical calls in flight at once are collapsed.** A model may ask for
 *     the same tool twice in one step, and the SDK executes a step's tool calls
 *     concurrently. Without this, the second call loses the race on the unique
 *     index, is handed the winner's row before it has an output, and returns
 *     nothing. So the first caller's promise is shared, in-process, per key.
 *   * **A replayed failure is rethrown**, never returned. See the module note.
 *   * **A throwing tool keeps its key claimed.** A tool that failed after
 *     spending a credit must not be retried into a second charge, and one that
 *     failed before spending anything is a bug to fix rather than a charge to
 *     repeat blindly. The failure is stored on the step and rethrown, so the
 *     SDK's own tool-error handling decides what the model is told.
 */
export function withReplay<ARGS, OUT>(
  recorder: ToolRecorder,
  spec: ReplayableTool<ARGS, OUT>,
  scrub: (error: unknown) => string = describeError,
): (args: ARGS) => Promise<OUT> {
  const inFlight = new Map<string, Promise<OUT>>();

  return async (args: ARGS): Promise<OUT> => {
    const key = recorder.key(spec.name, spec.toolKey(args));
    const already = inFlight.get(key);
    if (already !== undefined) {
      recorder.noteReplay();
      return already;
    }
    const attempt = call(key, args);
    inFlight.set(key, attempt);
    try {
      return await attempt;
    } finally {
      // Dropped once settled: the map exists to collapse *concurrent* calls, and
      // keeping a resolved promise would make it a second, unbounded cache of
      // everything the run ever did — in memory, beside the one on disk that is
      // the actual record.
      inFlight.delete(key);
    }
  };

  async function call(key: string, args: ARGS): Promise<OUT> {
    const index = recorder.takeIndex();
    const claim = await recorder.beginCall({ toolName: spec.name, toolKey: key, index, input: args });
    if (claim.replayed) {
      if ("failure" in claim) throw new ReplayedToolFailure(spec.name, claim.failure);
      if (spec.output === undefined) return claim.output as OUT;
      const parsed = spec.output.safeParse(claim.output);
      if (!parsed.success) {
        throw new ReplayedToolFailure(
          spec.name,
          "the stored result of this call no longer matches the tool's output shape",
        );
      }
      return parsed.data;
    }

    let output: OUT;
    try {
      output = await spec.execute(args);
    } catch (error) {
      if (spec.unspent?.(error) === true) await recorder.releaseCall(claim.stepId, scrub(error));
      else await recorder.failCall(claim.stepId, scrub(error));
      throw error;
    }
    await recorder.endCall(claim.stepId, output);
    return output;
  }
}

/**
 * Anything a tool returned, as a value Prisma will store.
 *
 * `undefined` is not JSON, and a tool that returns nothing is a tool whose step
 * has a null output rather than a write that throws after the call was already
 * made.
 */
function asJson(value: unknown): Prisma.InputJsonValue {
  return (value === undefined ? null : JSON.parse(JSON.stringify(value))) as Prisma.InputJsonValue;
}

/**
 * The safe default for a tool failure: the error's name, never its message.
 *
 * A provider client's exception message carries the request, and the request
 * carries the credential. `src/worker/errors.ts` has the scrubber that can read
 * a message safely; it lives on the worker side of the boundary, so a caller
 * that wants it passes it in. Until then the name alone is what gets stored.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.name;
  return typeof error === "string" ? "Error" : "non-Error thrown";
}
