import type { AgentRun, AgentRunStep, Prisma, PrismaClient } from "@prisma/client";
import {
  generateText,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  TypeValidationError,
  stepCountIs,
  type LanguageModel,
  type LanguageModelUsage,
  type ToolSet,
} from "ai";

import type { AgentDefinition } from "@/lib/agents/definitions";
import { costMicroDollars, formatMicroDollars, type PricedModel, type StepUsage } from "@/lib/agents/pricing";
import { createToolRecorder, type ToolRecorder } from "@/lib/agents/tools";
import { appendModelStep, finishRun, listSteps, startRun } from "@/lib/repo/agentRuns";

/**
 * The agent loop.
 *
 * §24's design law is that every agent run is a first-class record: inputs,
 * steps, tool calls, outputs, cost. This is the function that makes that true.
 * One `AgentRun` per call, one `AgentRunStep` per model call and per tool call,
 * tokens taken from the provider's own usage block rather than counted here,
 * cost from the pinned table in `pricing.ts`, and a final answer that is the
 * definition's output schema or nothing at all.
 *
 * ## Why `onLanguageModelCallEnd` and not `onStepFinish`
 *
 * The brief named `onStepFinish`. Two things are wrong with it, both read off
 * the installed `ai@7.0.93`:
 *
 *   * it is a **deprecated alias** for `onStepEnd`; and
 *   * `onStepEnd` fires *after* the step's tool calls have executed, so a model
 *     step recorded there takes a higher index than the tool calls it asked
 *     for, and the step table reads in the wrong order — the request after its
 *     own consequences.
 *
 * `onLanguageModelCallEnd` fires immediately after each model call and before
 * any tool runs, and it carries the usage, the finish reason, the response id
 * and the provider metadata. It is awaited, so the model step is committed
 * before the tools it triggered claim their indexes. Verified empirically, not
 * inferred: three model calls and two tool calls come out as indexes 0…4 in the
 * order they happened.
 *
 * ## The callback that must not be swallowed
 *
 * `ai` dispatches these callbacks through a helper that awaits them inside
 * `try { … } catch {}` — an exception in a callback is **discarded** and the
 * loop carries on. For a callback whose job is "record what this call cost",
 * that is the worst possible default: the run would keep spending with a step
 * missing and `costTotal` short, and nothing would say so. So every callback
 * here captures its own failure and aborts the run's controller. The run ends
 * `failed`, with the first failure as the reason, and the API stops being
 * called.
 */

/** Why a run ended without an answer. */
export type FailureReason =
  /** The step cap was reached before the model produced the output schema. */
  | "cap"
  /** The caller's signal aborted, or the lease was lost. */
  | "aborted"
  /** The model answered, and the answer did not validate against the definition's schema. */
  | "schema"
  /** A step could not be recorded. The run is stopped rather than continued uncosted. */
  | "step-record"
  /**
   * The answer was good and the run row could not be closed as `done`.
   *
   * The work happened and the tokens were spent; only the closing write failed.
   * A distinct reason rather than `error` because a handler reads these to
   * decide what to do, and this is the one failure where retrying the *job*
   * re-spends a run that had already produced its answer. Whether that is worth
   * paying is the handler's call — `src/worker/handlers/echo.ts` pays it, and
   * says why — but it cannot be made at all if the reason is `error`.
   */
  | "close"
  /** Anything else: a provider error, a tool that threw, a bug. */
  | "error";

/** A run that ended without a validated answer. The run row is closed before this is thrown. */
export class AgentRunFailedError extends Error {
  readonly reason: FailureReason;
  readonly runId: string;
  constructor(reason: FailureReason, runId: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AgentRunFailedError";
    this.reason = reason;
    this.runId = runId;
  }
}

export type RunAgentContext = {
  db: PrismaClient;
  orgId: string;
  jobId: string;
  /** The model handle, from `provider.makeModel`. */
  model: LanguageModel;
  /** The pinned id the price table knows. Recorded on the run and on every model step. */
  modelId: PricedModel;
  /** Aborted when the lease is lost or the worker drains. */
  signal?: AbortSignal;
  /**
   * The tool set, built against the recorder this run creates.
   *
   * Passed in rather than looked up, because a tool is the one part of a
   * definition that is code: `agents/echo/tools.ts` owns `shout`, and `runAgent`
   * owns only the recording. The names it returns are checked against the
   * definition's declared list, so an implementation and a signed definition
   * cannot quietly disagree.
   */
  tools?: (recorder: ToolRecorder) => ToolSet;
  /**
   * How an unknown thrown value becomes a line safe to store in `AgentRun.error`.
   *
   * Injected because the scrubber that can read an exception's message safely is
   * `safeError` in `src/worker/errors.ts`, and `src/lib` does not import the
   * worker. The default returns the error's **name only** — never its message,
   * which is where a provider client puts the Authorization header. A worker
   * handler passes `safeError` and gets the useful version.
   */
  scrub?: (error: unknown) => string;
};

export type RunAgentResult<OUT> = {
  /** The validated answer. */
  object: OUT;
  /** The closed run row, with `costTotal` and `status: done`. */
  run: AgentRun;
  /** Every step, in index order. */
  steps: AgentRunStep[];
  /** How many tool calls were served from a stored step instead of run. */
  replayedToolCalls: number;
};

export type RunAgentOptions<IN, OUT> = {
  definition: AgentDefinition<IN, OUT>;
  input: IN;
  ctx: RunAgentContext;
};

/**
 * Run a definition and record everything it did.
 *
 * Throws {@link AgentRunFailedError} when there is no validated answer. The run
 * row is always closed first — `done` with a cost, or `failed` with a cost and a
 * reason — because a run left `running` is a row the reaper cannot reason about
 * and a cost nobody is charged.
 */
export async function runAgent<IN, OUT>({
  definition,
  input,
  ctx,
}: RunAgentOptions<IN, OUT>): Promise<RunAgentResult<OUT>> {
  const scrub = ctx.scrub ?? describeErrorName;

  if (definition.prompt === null) {
    // Lead gen is code, not a model call (`agents/leadgen/definition.md` §0).
    // Refused here so that a brief which wires it to the runtime fails at once
    // rather than sending an empty system prompt to a paid API.
    throw new Error(`runAgent: the ${definition.kind} definition makes no model calls and cannot be run as a loop`);
  }
  if (definition.budget.maxModelSteps < 1) {
    throw new Error(`runAgent: ${definition.kind} has a model-step budget of ${definition.budget.maxModelSteps}`);
  }

  // Validated before a single token is spent: the input is the one thing we can
  // check for free, and a run that was always going to produce nothing should
  // not have cost anything.
  const parsedInput = definition.input.parse(input);

  // Both of these are refused **before** the run row exists. The rule this file
  // keeps is "a run row is never left `running`", and the cheapest way to keep it
  // is to do everything that can fail for free first: a mismatched tool set is a
  // programming error that will fail identically on every attempt, and a signal
  // that is already aborted means there was never a run to record.
  assertDeclaredTools(definition, ctx.tools?.(probeRecorder(ctx, definition.kind)) ?? {});
  if (aborted(ctx.signal)) {
    // `generateText` does not refuse an already-aborted signal — it dispatches
    // the request and lets the transport reject, which for a provider that does
    // not check is a call paid for on a lease this worker no longer holds. Same
    // reason `worker/handlers/sleep.ts` tests the signal before arming its timer.
    throw new AgentRunFailedError(
      "aborted",
      "",
      `aborted: the signal was already aborted before the ${definition.kind} run started`,
      { cause: ctx.signal?.reason },
    );
  }

  const run = await startRun(ctx.db, {
    orgId: ctx.orgId,
    jobId: ctx.jobId,
    kind: definition.kind,
    model: ctx.modelId,
  });

  // One counter for the whole run, read and incremented synchronously, so two
  // tool calls executing in parallel cannot take the same index — `(run_id,
  // index)` is unique and a collision would fail the run on a bookkeeping race.
  let nextIndex = 0;
  const takeIndex = (): number => nextIndex++;

  const recorder = createToolRecorder({
    db: ctx.db,
    orgId: ctx.orgId,
    jobId: ctx.jobId,
    runId: run.id,
    runKind: definition.kind,
    takeIndex,
  });

  const tools = ctx.tools?.(recorder) ?? {};

  // The run's own controller, so a failure to record a step can stop the loop.
  // Linked to the caller's signal rather than replacing it: losing the lease
  // must still abort, and so must a failed write.
  const controller = new AbortController();
  const unlink = link(ctx.signal, controller);

  let costMicro = 0n;
  /** The first thing that went wrong inside a swallowed callback. */
  let callbackError: unknown;

  const noteCallbackFailure = (error: unknown): void => {
    callbackError ??= error;
    controller.abort(error instanceof Error ? error : new Error(String(error)));
  };

  try {
    let generated: Awaited<ReturnType<typeof generateText>>;
    try {
      generated = await generateText({
        model: ctx.model,
        system: definition.prompt,
        // The input as the user turn. JSON rather than prose because the input
        // is a schema and the agent's prompt is written against that schema.
        prompt: JSON.stringify(parsedInput, null, 2),
        tools,
        stopWhen: stepCountIs(definition.budget.maxModelSteps),
        abortSignal: controller.signal,
        // `output`, not `experimental_output`: read off the installed types.
        // With tools in play the structured answer arrives as the final model
        // call's text, so it is a step like any other and is counted like one.
        output: Output.object({ schema: definition.output }),
        onLanguageModelCallEnd: async (event) => {
          try {
            const usage = normaliseUsage(event.usage);
            const micro = costMicroDollars(usage, ctx.modelId);
            costMicro += micro;
            await appendModelStep(ctx.db, {
              orgId: ctx.orgId,
              runId: run.id,
              index: takeIndex(),
              // The model we asked for and priced, not the one the response
              // names: the row has to say which price-table entry produced its
              // cost. A provider that answered on a different model shows up as
              // `providerMeta.responseModelId`, which is the discrepancy a
              // reviewer needs to be able to see.
              name: ctx.modelId,
              tokensIn: usage.tokensIn,
              tokensOut: usage.tokensOut,
              tokensCached: usage.tokensCacheRead,
              tokensReasoning: usage.tokensReasoning,
              cost: formatMicroDollars(micro),
              providerMeta: providerMeta(event, usage),
              // `rawUsage` is the provider's own block, untouched. See
              // `providerMeta` for why it is not optional in practice.
            });
          } catch (error) {
            noteCallbackFailure(error);
          }
        },
      });
    } catch (error) {
      // A recording failure is the real cause even though the SDK surfaced an
      // abort, so it is reported first.
      if (callbackError !== undefined) {
        throw await failRun(ctx, run, costMicro, "step-record", "a step could not be recorded", callbackError, scrub);
      }
      if (aborted(ctx.signal) || controller.signal.aborted) {
        throw await failRun(ctx, run, costMicro, "aborted", "the run was aborted", error, scrub);
      }
      // `Output.object` validates the final answer *inside* the loop, so a
      // malformed answer arrives here as a thrown validation error rather than
      // as a failed read below. Both paths are the same outcome — no answer in
      // the definition's schema — and both must report `schema`, or a handler
      // would retry a model that will produce the same shape again.
      if (isValidationFailure(error)) {
        throw await failRun(ctx, run, costMicro, "schema", "the answer does not validate", error, scrub);
      }
      throw await failRun(ctx, run, costMicro, "error", "the model loop failed", error, scrub);
    }

    if (callbackError !== undefined) {
      throw await failRun(ctx, run, costMicro, "step-record", "a step could not be recorded", callbackError, scrub);
    }

    let raw: unknown;
    try {
      raw = generated.output;
    } catch (error) {
      // No structured answer. The cap is the expected way to get here — the
      // model kept calling tools until `stopWhen` stopped it — and it is told
      // apart from a malformed answer by the step count, not by the message.
      if (isMissingOutput(error)) {
        const capped = generated.steps.length >= definition.budget.maxModelSteps;
        throw await failRun(
          ctx,
          run,
          costMicro,
          capped ? "cap" : "schema",
          capped
            ? `stopped at the ${definition.budget.maxModelSteps}-step cap with no answer`
            : "the model produced no answer in the output schema",
          error,
          scrub,
        );
      }
      throw await failRun(ctx, run, costMicro, "error", "reading the answer failed", error, scrub);
    }

    // Parsed again against the definition's own schema. `Output.object` has
    // already validated it, and this is not redundant: the schema the runtime
    // guarantees is the one in `agents/<kind>/output.schema.ts`, and proving
    // that here means a future change to how the SDK coerces an answer cannot
    // widen what a caller receives.
    const validated = definition.output.safeParse(raw);
    if (!validated.success) {
      throw await failRun(
        ctx,
        run,
        costMicro,
        "schema",
        `the answer does not validate: ${validated.error.issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`).join("; ")}`,
        validated.error,
        scrub,
      );
    }

    // The success close is guarded for the same reason every failure exit runs
    // through `failRun`: this file's rule is that a run row is never left
    // `running`, and an unguarded `finishRun` here is the one path that could
    // leave one. A throw at the commit moment would otherwise strand the row
    // and lose a cost that was really spent, so it is routed through the same
    // close-and-report path as any other failure and then rethrown.
    let closed: AgentRun;
    try {
      closed = await finishRun(ctx.db, {
        orgId: ctx.orgId,
        runId: run.id,
        status: "done",
        costTotal: formatMicroDollars(costMicro),
      });
    } catch (error) {
      throw await failRun(ctx, run, costMicro, "close", "the run could not be closed", error, scrub);
    }
    return {
      object: validated.data,
      run: closed,
      steps: await listSteps(ctx.db, { orgId: ctx.orgId, runId: run.id }),
      replayedToolCalls: recorder.replayed,
    };
  } finally {
    unlink();
  }
}

/**
 * Close the run as failed and return the error to throw.
 *
 * Returned rather than thrown so every call site reads `throw await
 * failRun(...)` — which makes it impossible to close the run and then forget to
 * stop. The cost so far is written: tokens spent before a failure were still
 * spent.
 */
async function failRun(
  ctx: RunAgentContext,
  run: AgentRun,
  costMicro: bigint,
  reason: FailureReason,
  summary: string,
  cause: unknown,
  scrub: (error: unknown) => string,
): Promise<AgentRunFailedError> {
  const detail = scrub(cause);
  const error = `${reason}: ${summary}${detail === "" ? "" : ` (${detail})`}`;
  try {
    await finishRun(ctx.db, {
      orgId: ctx.orgId,
      runId: run.id,
      status: "failed",
      costTotal: formatMicroDollars(costMicro),
      // Bounded here as well as by whatever the caller's scrubber does: the
      // summary is ours and short, but `detail` came from a library.
      error: error.length <= 200 ? error : `${error.slice(0, 199)}…`,
    });
  } catch {
    // The run row could not be closed. The original failure is what the caller
    // needs to hear about, and swallowing that in favour of a write error would
    // hide the reason the run ended. The row stays `running` and the reaper's
    // view of the job is unchanged.
  }
  return new AgentRunFailedError(reason, run.id, error, { cause });
}

/**
 * The AI SDK's usage block, flattened, with every `undefined` resolved to zero.
 *
 * `undefined` means "the provider did not say", and for a token count that is
 * zero for costing purposes. It is recorded as zero rather than left null so
 * that a sum over the column is a sum and not a sum-if.
 */
export function normaliseUsage(usage: LanguageModelUsage): StepUsage & { tokensReasoning: number } {
  const zero = (value: number | undefined): number => value ?? 0;
  return {
    tokensIn: zero(usage.inputTokens),
    tokensInUncached: zero(usage.inputTokenDetails?.noCacheTokens),
    tokensCacheRead: zero(usage.inputTokenDetails?.cacheReadTokens),
    tokensCacheWrite: zero(usage.inputTokenDetails?.cacheWriteTokens),
    tokensOut: zero(usage.outputTokens),
    tokensReasoning: zero(usage.outputTokenDetails?.reasoningTokens),
  };
}

/**
 * What goes in `providerMeta`.
 *
 * The provider's own block, plus the normalised usage this runtime priced from
 * and the response id — because the column exists so that "a cost figure can be
 * argued with" (the comment on the column), and arguing with one needs the
 * inputs to the arithmetic as well as the provider's raw answer. `cacheWrite`
 * in particular has no column of its own and is billed at 1.25x input, so
 * without it here a row's cost could not be re-derived from the row.
 */
function providerMeta(
  event: {
    provider: string;
    modelId: string;
    responseId: string;
    finishReason: string;
    usage: LanguageModelUsage;
    providerMetadata?: unknown;
    performance?: unknown;
  },
  usage: StepUsage & { tokensReasoning: number },
): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify({
      provider: event.provider,
      responseModelId: event.modelId,
      responseId: event.responseId,
      finishReason: event.finishReason,
      performance: event.performance ?? null,
      // What this runtime priced from…
      usage,
      // …and what the provider actually said, in the provider's own field names
      // (`input_tokens`, `cache_read_input_tokens`,
      // `output_tokens_details.thinking_tokens`). Without this, proof 1's live
      // script could only compare the recorded columns against the numbers the
      // same statement derived them from — which is a tautology that can never
      // fail. `usage.raw` is the provider's block as it arrived; it is absent
      // only for a model that reports none, which the script says rather than
      // passing.
      rawUsage: event.usage.raw ?? null,
      providerMetadata: event.providerMetadata ?? null,
    }),
  ) as Prisma.InputJsonValue;
}

/**
 * True when the thrown value is a schema failure, however deep it is wrapped.
 *
 * The SDK wraps: a `TypeValidationError` from the output specification arrives
 * as the `cause` of a `NoObjectGeneratedError`, or of nothing at all, depending
 * on where in the loop it was raised. Walking the chain is bounded so a cyclic
 * `cause` cannot hang the failure path.
 */
function isValidationFailure(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    if (TypeValidationError.isInstance(current) || NoObjectGeneratedError.isInstance(current)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** True when the thrown value is the SDK saying there is no structured answer. */
function isMissingOutput(error: unknown): boolean {
  return NoOutputGeneratedError.isInstance(error) || NoObjectGeneratedError.isInstance(error);
}

/**
 * The tool set must be exactly what the definition declares.
 *
 * Both directions. A tool implemented but not declared is a capability a signed
 * definition does not grant — research's "nothing spends" is a promise about a
 * list — and a tool declared but not implemented is an agent that will spend a
 * model call discovering it. Either is a mismatch between code and a signed
 * document, which is the thing this whole directory exists to prevent.
 */
function assertDeclaredTools(definition: AgentDefinition, tools: ToolSet): void {
  const supplied = Object.keys(tools).sort();
  const declared = [...definition.tools].sort();
  if (supplied.length === declared.length && supplied.every((name, i) => name === declared[i])) return;
  throw new Error(
    `runAgent: ${definition.kind} declares tools [${declared.join(", ")}] but was given [${supplied.join(", ")}]`,
  );
}

/**
 * A recorder that exists only to be asked for tool names.
 *
 * `ctx.tools` is a factory over a recorder, and the declared-tool check has to
 * run before the run row is created — so it is handed one whose every method
 * throws. A factory that called one would be doing work at construction time,
 * which is itself worth failing on.
 */
function probeRecorder(ctx: RunAgentContext, runKind: string): ToolRecorder {
  const refuse = (): never => {
    throw new Error("runAgent: a tool factory must not record anything while it is being built");
  };
  return {
    orgId: ctx.orgId,
    jobId: ctx.jobId,
    runId: "",
    runKind,
    replayed: 0,
    takeIndex: refuse,
    key: refuse,
    beginCall: refuse,
    endCall: refuse,
    failCall: refuse,
    noteReplay: refuse,
  };
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Forward the caller's abort to ours, and stop listening when the run ends. */
function link(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (signal === undefined) return () => {};
  if (signal.aborted) {
    controller.abort(signal.reason);
    return () => {};
  }
  const onAbort = (): void => controller.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/** The safe default scrubber: a name, never a message. See `RunAgentContext.scrub`. */
function describeErrorName(error: unknown): string {
  if (error instanceof Error) return error.name;
  return typeof error === "string" ? "Error" : "non-Error thrown";
}
