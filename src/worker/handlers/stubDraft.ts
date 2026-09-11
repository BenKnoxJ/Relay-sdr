import { echoTools } from "../../../agents/echo/tools";
import { loadDefinition } from "@/lib/agents/definitions";
import { makeModel } from "@/lib/agents/provider";
import { AgentRunFailedError, runAgent } from "@/lib/agents/run";
import { findDraftReadyForJob, recordDraftReady } from "@/lib/repo/approvals";
import { AGENT_MODEL } from "@/worker/handlers/echo";
import { TerminalError, safeError } from "@/worker/errors";
import type { Handler } from "@/worker/handlers/index";

/**
 * The first half of the approval hand-off: draft something, then stop.
 *
 * Proof 3 of the runtime rubric is about where a run *ends*. This handler runs
 * a real agent loop through `runAgent` — the same loop `echo` runs, on the same
 * definition, because what is being proved is not the drafting — and then does
 * the one thing that makes it a draft rather than an answer: it records a
 * `draft.ready` Event and completes the job. No approval is waited for. No
 * state is held. The worker is free the moment this returns, and the process
 * that runs the other half has not been started yet.
 *
 * The run reaching "drafts ready" is a *phase*, not an `AgentRunStatus`: the
 * run itself is `done`, because it finished everything it was asked to do. What
 * stops is the work, and the Event is where that is written down. Adding a
 * fourth run status for it was considered and rejected — a run that ended
 * normally is `done`, and a status that means "done, but there is more later"
 * would have to be interpreted by everything that reads a run.
 *
 * Task 14 replaces the loop with the real outreach specialist and the Event
 * with a Draft row. Neither the handler's shape nor `approveStubDraft` changes
 * when it does, which is the point of proving it here.
 */
export const stubDraft: Handler = async ({ db, job, signal }) => {
  const definition = loadDefinition("echo");
  const parsed = definition.input.safeParse(job.input);
  if (!parsed.success) {
    // Terminal, like `echo`'s: three more attempts read the same input three
    // lease-lengths apart and reach the same conclusion.
    throw new TerminalError(
      `stub_draft: bad input (${parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")})`,
    );
  }

  // Before the model call, not after it. `recordDraftReady` is idempotent per
  // job, so a retry of a job that already drafted would otherwise pay for a
  // whole `claude-opus-5` run and then throw the answer away — the most
  // expensive possible way to reach the row that was already there.
  const drafted = await findDraftReadyForJob(db, job.orgId, job.id);
  if (drafted !== null) return { draftEventId: drafted.id };

  let text: string;
  let runId: string;
  try {
    const result = await runAgent({
      definition,
      input: parsed.data,
      ctx: {
        db,
        orgId: job.orgId,
        jobId: job.id,
        model: makeModel(AGENT_MODEL),
        modelId: AGENT_MODEL,
        signal,
        // The definition's declared tools, not an empty set: `runAgent` checks
        // the supplied names against `agents/echo/definition.md` §4 and refuses
        // a run whose implementation and signed definition disagree.
        tools: (recorder) => echoTools(recorder),
        scrub: safeError,
      },
    });
    text = result.object.text;
    runId = result.run.id;
  } catch (error) {
    if (error instanceof AgentRunFailedError) {
      switch (error.reason) {
        case "cap":
        case "schema":
          // Deterministic in the definition and the input: a retry spends a
          // second run's tokens to learn the same thing.
          throw new TerminalError(`stub_draft: ${error.message}`, { cause: error });
        case "aborted":
        case "step-record":
        case "error":
        case "close":
          // Retryable. Same reasoning as `echo`, including `close`: the answer
          // never reached this handler, so there is no draft to record and a
          // terminal job would strand the work over a transient write.
          throw error;
        default: {
          // Exhaustive, so a new `FailureReason` fails the typecheck here
          // rather than falling through to the retryable path unclassified.
          const unhandled: never = error.reason;
          throw new TerminalError(
            `stub_draft: unhandled failure reason ${String(unhandled)}`,
            { cause: error },
          );
        }
      }
    }
    throw error;
  }

  // The draft, written down. After the run and not inside it: `runAgent` records
  // what a run *cost*, and what a run *produced* is a domain event that belongs
  // in the repository layer with the rest of the writes.
  const draft = await recordDraftReady(db, {
    orgId: job.orgId,
    jobId: job.id,
    runId,
    text,
  });

  // The draft's id, and not the text. `Job.responseDigest` is hashed over this,
  // and it exists to tell two attempts' outputs apart — `recordDraftReady` is
  // idempotent per job, so a retry that gets this far returns the same id and
  // the same digest, which is the honest answer for work that did not repeat.
  return { draftEventId: draft.id };
};
