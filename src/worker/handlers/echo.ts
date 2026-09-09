import { echoTools } from "../../../agents/echo/tools";
import { loadDefinition } from "@/lib/agents/definitions";
import { makeModel } from "@/lib/agents/provider";
import { AgentRunFailedError, runAgent } from "@/lib/agents/run";
import { TerminalError, safeError } from "@/worker/errors";
import type { Handler } from "@/worker/handlers/index";

/**
 * The `echo` job: the agent runtime, end to end, on a stub.
 *
 * It is the walking skeleton Task 6's exit condition names. A job is claimed, a
 * run is opened, a model call is recorded with its tokens and its cost, a tool
 * call is keyed and recorded, a structured answer is validated against the
 * definition's schema, the run is closed with a total, and the job completes with
 * a digest. Nothing in that sentence is about echo; all of it is about the
 * runtime, which is why the first handler to use it does as little as possible.
 *
 * Task 12 adds `research` beside it. Nothing else in this file changes when it
 * does, which is the point of the shape.
 */

/**
 * The model every agent run uses until a brief says otherwise.
 *
 * §24 pins two ids and this is the capable one. A constant rather than a knob:
 * the price table has two entries, the spike rubric names this one, and a model
 * chosen by configuration is a cost nobody reviewed.
 */
export const AGENT_MODEL = "claude-opus-5" as const;

export const echo: Handler = async ({ db, job, signal }) => {
  const definition = loadDefinition("echo");
  const parsed = definition.input.safeParse(job.input);
  if (!parsed.success) {
    // Terminal: three more attempts read the same input and reach the same
    // conclusion, three lease-lengths apart.
    throw new TerminalError(
      `echo: bad input (${parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")})`,
    );
  }

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
        tools: (recorder) => echoTools(recorder),
        // The scrubber the runtime cannot reach for itself: `safeError` lives on
        // the worker side of the app/worker boundary, so `runAgent` takes it as
        // an argument rather than importing it. See `RunAgentContext.scrub`.
        scrub: safeError,
      },
    });

    // The answer, and only the answer. `Job.responseDigest` is hashed over
    // whatever a handler returns, and it exists "to tell two attempts' outputs
    // apart" — so everything that varies between two attempts doing the same
    // work has to stay out of it. The run id, the cost and the step count all
    // vary (a retry that replays its tool calls records fewer steps and spends
    // less), and including any of them would make the digest differ on every
    // attempt and answer nothing. None of it is lost: `agent_runs` is keyed on
    // `jobId`, so the run, its cost and its steps are one query away.
    return { text: result.object.text };
  } catch (error) {
    if (error instanceof AgentRunFailedError) {
      switch (error.reason) {
        case "cap":
        case "schema":
          // Deterministic in the definition and the input: the cap will be the
          // same cap and the schema the same schema next time, and a retry would
          // spend a second run's tokens to learn it.
          throw new TerminalError(`echo: ${error.message}`, { cause: error });
        case "aborted":
        case "step-record":
        case "error":
          // Retryable. A lost lease, a database blip and a provider 500 are all
          // things another attempt can get past, and the run row already says
          // what happened to this one.
          throw error;
      }
    }
    throw error;
  }
};
