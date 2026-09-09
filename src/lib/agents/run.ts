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
import {
  asRunModel,
  type AgentSdkModelUsage,
  type AgentSdkObserver,
  type AgentSdkResult,
  type AnthropicUsage,
  type ModelTransport,
  type RunModel,
} from "@/lib/agents/model";
import { costMicroDollars, formatMicroDollars, isPricedModel, type PricedModel, type StepUsage } from "@/lib/agents/pricing";
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
 *
 * ## Two transports, one ledger
 *
 * On the Messages API the AI SDK owns the loop and the paragraph above is the
 * whole story. On the Claude Agent SDK (the subscription transport, Task 6c)
 * the loop runs inside the SDK's subprocess and the AI SDK sees **one** call
 * for the whole run, with the usage summed. A row per model call therefore
 * comes from the SDK's own message stream instead: `provider.agentSdkSettings`
 * hands every assistant message and the closing result to an observer built
 * here, and the observer appends one `model` step per assistant turn — the
 * Messages API's own usage block, per message, priced from the pinned table —
 * and skips the summed call. Tool steps need nothing: the MCP server the model
 * calls runs the tools' own `execute`, in this process, through `withReplay`.
 *
 * The SDK's closing `modelUsage` is the reconciliation. It is the SDK's own
 * per-model totals for the query, and it includes calls the message stream does
 * not show — the subprocess makes a small Haiku call of its own on every run.
 * Whatever a model's totals exceed the turns already recorded by is written as
 * one more `model` step under that model's canonical id, so the run total is
 * the whole run and not the visible part of it; a model the price table does
 * not know fails the run (`step-record`), because a cost that cannot be
 * computed must not be recorded as zero. The observer's failures abort the run
 * the same way a swallowed callback's do — and they *are* swallowed: the bridge
 * calls `onSdkMessage` synchronously as it reads each message off the SDK's
 * stream and does **not** await it (`invokeObservabilityCallback` in
 * `ai-sdk-provider-claude-code/dist/index.js`: `void Promise.resolve(result)
 * .catch(logError)`), so a throw there is a log line and nothing more.
 *
 * ## Why a tool step never takes a lower index than the turn that asked for it
 *
 * On the Messages API the paragraph above ("Why `onLanguageModelCallEnd`") is
 * the whole argument. On the Agent SDK the two writes come from two channels:
 * the assistant message reaches `onTurn` through the SDK's message stream, and
 * the tool call reaches the tool's `execute` through the SDK's control channel
 * (an `mcp_message` control request that the SDK dispatches from the same read
 * loop). The stream order is fixed — the CLI emits the assistant message before
 * it calls the tool — and `onTurn` takes its index **synchronously**, before
 * its first `await`, so in practice the order holds (every live run so far:
 * model, tool, model). But "in practice" is not the standard this file keeps,
 * so on this transport the tools are gated: a tool may not take an index until
 * the ledger has seen at least as many `tool_use` blocks as tool executions
 * have started. If a control request ever overtook its own assistant message,
 * the tool would wait for the turn rather than write ahead of it.
 * `tests/agents/agentSdk.test.ts` plays that inversion and shows the order.
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
  /**
   * The model handle, from `provider.makeModel`, or a bare model.
   *
   * A bare `LanguageModel` is the in-process shape (the scripted model the
   * tests use, or the Messages API); a `RunModel` says which transport it is
   * on, which decides where the ledger reads a model call from. See
   * `src/lib/agents/model.ts`.
   */
  model: LanguageModel | RunModel;
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
  /** Which transport the run went over. */
  transport: ModelTransport;
  /** The Agent SDK's closing result, when that was the transport: its own totals, to reconcile against. */
  sdk?: AgentSdkResult;
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

  const handle = asRunModel(ctx.model);
  // On the Agent SDK the ledger reads the SDK's message stream; see the module
  // comment. Built after the run row exists because its rows carry the run id.
  const sdk =
    handle.transport === "agent-sdk"
      ? agentSdkLedger({
          ctx,
          runId: run.id,
          takeIndex,
          addCost: (micro) => {
            costMicro += micro;
          },
          fail: noteCallbackFailure,
          signal: controller.signal,
        })
      : null;
  const model =
    handle.transport === "agent-sdk"
      ? handle.forRun({
          tools: sdk!.gateTools(tools),
          maxTurns: definition.budget.maxModelSteps,
          observe: sdk!.observer,
        })
      : handle.model;

  try {
    let generated: Awaited<ReturnType<typeof generateText>>;
    try {
      generated = await generateText({
        model,
        system: definition.prompt,
        // The input as the user turn. JSON rather than prose because the input
        // is a schema and the agent's prompt is written against that schema.
        prompt: JSON.stringify(parsedInput, null, 2),
        // On the Agent SDK the tools are already on the model, as an MCP server
        // (`provider.agentSdkSettings`); given here as well, the AI SDK would
        // try to run a call the subprocess has already run.
        ...(sdk === null ? { tools } : {}),
        stopWhen: stepCountIs(definition.budget.maxModelSteps),
        abortSignal: controller.signal,
        // `output`, not `experimental_output`: read off the installed types.
        // With tools in play the structured answer arrives as the final model
        // call's text, so it is a step like any other and is counted like one.
        output: Output.object({ schema: definition.output }),
        onLanguageModelCallEnd: async (event) => {
          // On the Agent SDK this fires once, for the whole run, with the usage
          // summed over every turn — the rows were written per turn by the
          // observer, and this would be the same tokens a second time.
          if (sdk !== null) return;
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
      // The SDK's cap. Its closing message said `error_max_turns` before the
      // bridge threw, and the observer noted it; the throw itself is a generic
      // API error whose message is not something to match on.
      if (sdk?.capped === true) {
        throw await failRun(
          ctx,
          run,
          costMicro,
          "cap",
          `stopped at the ${definition.budget.maxModelSteps}-step cap with no answer`,
          error,
          scrub,
        );
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
        const capped = sdk === null ? generated.steps.length >= definition.budget.maxModelSteps : sdk.capped;
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
      transport: handle.transport,
      ...(sdk?.result === undefined ? {} : { sdk: sdk.result }),
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
  // The one-hour share of the cache writes is not in the SDK's shape; it is in
  // the provider's raw block, which `@ai-sdk/anthropic` passes through as
  // `raw`. Absent means none, which is the five-minute default.
  const raw = usage.raw as AnthropicUsage | undefined;
  return {
    tokensIn: zero(usage.inputTokens),
    tokensInUncached: zero(usage.inputTokenDetails?.noCacheTokens),
    tokensCacheRead: zero(usage.inputTokenDetails?.cacheReadTokens),
    tokensCacheWrite: zero(usage.inputTokenDetails?.cacheWriteTokens),
    tokensCacheWrite1h: zero(raw?.cache_creation?.ephemeral_1h_input_tokens),
    tokensOut: zero(usage.outputTokens),
    tokensReasoning: zero(usage.outputTokenDetails?.reasoningTokens),
  };
}

/**
 * The Messages API's own usage block, as the Agent SDK relays it per assistant
 * message, flattened the same way. `input_tokens` on the wire is the
 * **non-cached** count, so the total is built from the three parts, exactly as
 * `@ai-sdk/anthropic` builds it.
 */
export function usageFromAnthropic(usage: AnthropicUsage): StepUsage & { tokensReasoning: number } {
  const input = usage.input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  return {
    tokensIn: input + cacheRead + cacheWrite,
    tokensInUncached: input,
    tokensCacheRead: cacheRead,
    tokensCacheWrite: cacheWrite,
    tokensCacheWrite1h: usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    tokensOut: usage.output_tokens ?? 0,
    tokensReasoning: usage.output_tokens_details?.thinking_tokens ?? 0,
  };
}

/** A model id as the price table spells it: the SDK keys some usage by a dated alias. */
export function canonicalModelId(id: string): string {
  return id.replace(/-\d{8}$/, "");
}

type Totals = { tokensInUncached: number; tokensCacheRead: number; tokensCacheWrite: number; tokensOut: number };

/**
 * The Agent SDK half of the ledger. See the module comment, "Two transports".
 */
function agentSdkLedger(args: {
  ctx: RunAgentContext;
  runId: string;
  takeIndex: () => number;
  addCost: (micro: bigint) => void;
  fail: (error: unknown) => void;
  /** The run's own signal: a parked tool is released with an error when it fires. */
  signal: AbortSignal;
}): {
  observer: AgentSdkObserver;
  /** The run's tools, each made to wait for the turn that asked for it. See the module comment. */
  gateTools(tools: ToolSet): ToolSet;
  readonly capped: boolean;
  readonly result: AgentSdkResult | undefined;
} {
  const { ctx, runId, takeIndex, addCost, fail, signal } = args;
  /** Tokens already written as turn steps, by canonical model id. */
  const recorded = new Map<string, Totals>();
  let capped = false;
  let result: AgentSdkResult | undefined;

  // The ordering gate. `toolUsesSeen` counts `tool_use` blocks on the turns
  // the ledger has indexed; `toolStarts` counts executions that have begun. A
  // tool may begin only while the first exceeds the second; otherwise it waits
  // for the next turn to be indexed.
  //
  // A parked tool is released one of three ways, and never left hanging: the
  // next turn is indexed (it runs); the run's signal fires — a lost lease, a
  // failed write on an earlier turn, the caller — (it fails with `aborted`);
  // or the SDK's closing result arrives with no turn having asked for it (it
  // fails, because a run that has ended has no turn coming). The bridge tears
  // the subprocess down on abort, but the tool's promise is this process's,
  // and a promise that never settles is a leak at best and, if anything
  // upstream awaited it, a hang.
  let toolUsesSeen = 0;
  let toolStarts = 0;
  let closed: Error | null = null;
  let waiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  const releaseWaiters = (): void => {
    const pending = waiters;
    waiters = [];
    for (const waiter of pending) waiter.resolve();
  };
  const closeGate = (error: Error): void => {
    closed ??= error;
    const pending = waiters;
    waiters = [];
    for (const waiter of pending) waiter.reject(error);
  };
  const turnIndexed = (): Promise<void> =>
    new Promise((resolve, reject) => {
      if (closed !== null) {
        reject(closed);
        return;
      }
      waiters.push({ resolve, reject });
    });
  const abortedError = (): Error =>
    new Error("aborted: the run ended while a tool was waiting for the turn that asked for it", {
      cause: signal.reason,
    });
  if (signal.aborted) closeGate(abortedError());
  else signal.addEventListener("abort", () => closeGate(abortedError()), { once: true });

  const note = (id: string, usage: StepUsage): void => {
    const totals = recorded.get(id) ?? { tokensInUncached: 0, tokensCacheRead: 0, tokensCacheWrite: 0, tokensOut: 0 };
    totals.tokensInUncached += usage.tokensInUncached;
    totals.tokensCacheRead += usage.tokensCacheRead;
    totals.tokensCacheWrite += usage.tokensCacheWrite;
    totals.tokensOut += usage.tokensOut;
    recorded.set(id, totals);
  };

  const observer: AgentSdkObserver = {
    async onTurn(turn) {
      // Everything up to the write is synchronous on purpose: the bridge calls
      // this as it reads the message, and the index has to be taken before the
      // loop can read the control request that follows. See the module comment.
      let index: number;
      try {
        index = takeIndex();
        toolUsesSeen += turn.blocks.filter((block) => block.startsWith("tool_use:")).length;
        releaseWaiters();
      } catch (error) {
        fail(error);
        return;
      }
      try {
        const usage = usageFromAnthropic(turn.usage);
        // Priced under the pinned id, as on the other transport: the row says
        // which price-table entry produced its cost, and a response naming a
        // different model shows up as `responseModelId`.
        const micro = costMicroDollars(usage, ctx.modelId);
        addCost(micro);
        note(canonicalModelId(turn.model), usage);
        await appendModelStep(ctx.db, {
          orgId: ctx.orgId,
          runId,
          index,
          name: ctx.modelId,
          tokensIn: usage.tokensIn,
          tokensOut: usage.tokensOut,
          tokensCached: usage.tokensCacheRead,
          tokensReasoning: usage.tokensReasoning,
          cost: formatMicroDollars(micro),
          providerMeta: JSON.parse(
            JSON.stringify({
              provider: "claude-code",
              responseModelId: turn.model,
              responseId: turn.messageId,
              finishReason: turn.stopReason,
              blocks: turn.blocks,
              usage,
              rawUsage: turn.usage,
              // The SDK relays the message, not the transport's metadata: there
              // is no per-call provider block on this path, and the row says so
              // rather than leaving the key off.
              providerMetadata: null,
            }),
          ) as Prisma.InputJsonValue,
        });
      } catch (error) {
        fail(error);
      }
    },
    async onResult(closing) {
      // No further turn is coming, so nothing parked can be released by one.
      closeGate(new Error(`the run ended (${closing.subtype}) before the turn that asked for a waiting tool was seen`));
      try {
        result = closing;
        capped = closing.subtype === "error_max_turns";
        for (const [key, entry] of Object.entries(closing.modelUsage)) {
          const id = canonicalModelId(entry.canonicalModel ?? key);
          const remainder = remainderOf(entry, recorded.get(id));
          if (remainder === null) continue;
          if (!isPricedModel(id)) {
            throw new Error(`the Agent SDK reports usage on ${JSON.stringify(id)}, which the price table does not know`);
          }
          const usage: StepUsage = {
            tokensIn: remainder.tokensInUncached + remainder.tokensCacheRead + remainder.tokensCacheWrite,
            ...remainder,
            // The SDK gives no TTL split for its own calls; every cache write it
            // has been seen to make is a one-hour one, so the higher rate is the
            // safe assumption and `sdkCostUsd` beside it is the check.
            tokensCacheWrite1h: remainder.tokensCacheWrite,
          };
          const micro = costMicroDollars(usage, id);
          addCost(micro);
          note(id, usage);
          await appendModelStep(ctx.db, {
            orgId: ctx.orgId,
            runId,
            index: takeIndex(),
            name: id,
            tokensIn: usage.tokensIn,
            tokensOut: usage.tokensOut,
            tokensCached: usage.tokensCacheRead,
            tokensReasoning: 0,
            cost: formatMicroDollars(micro),
            providerMeta: JSON.parse(
              JSON.stringify({
                provider: "claude-code",
                source: "modelUsage remainder: calls the SDK made that its message stream did not show",
                responseModelId: key,
                usage,
                // No wire block: this row is a difference between two totals.
                // `sdkModelUsage` is what it was reconciled against.
                rawUsage: null,
                sdkModelUsage: entry,
                providerMetadata: null,
              }),
            ) as Prisma.InputJsonValue,
          });
        }
      } catch (error) {
        fail(error);
      }
    },
  };

  const gateTools = (tools: ToolSet): ToolSet => {
    const gated: ToolSet = {};
    for (const [name, tool] of Object.entries(tools)) {
      const execute = tool.execute;
      if (execute === undefined) {
        gated[name] = tool;
        continue;
      }
      gated[name] = {
        ...tool,
        execute: async (input: unknown, options: Parameters<typeof execute>[1]) => {
          while (toolUsesSeen <= toolStarts) {
            if (closed !== null) throw closed;
            await turnIndexed();
          }
          toolStarts += 1;
          return execute(input as never, options);
        },
      } as typeof tool;
    }
    return gated;
  };

  return {
    observer,
    gateTools,
    get capped() {
      return capped;
    },
    get result() {
      return result;
    },
  };
}

/** What the SDK's totals for one model exceed the recorded turns by, or null when nothing does. */
function remainderOf(entry: AgentSdkModelUsage, recorded: Totals | undefined): Totals | null {
  const seen = recorded ?? { tokensInUncached: 0, tokensCacheRead: 0, tokensCacheWrite: 0, tokensOut: 0 };
  const remainder: Totals = {
    tokensInUncached: Math.max(0, entry.inputTokens - seen.tokensInUncached),
    tokensCacheRead: Math.max(0, entry.cacheReadInputTokens - seen.tokensCacheRead),
    tokensCacheWrite: Math.max(0, entry.cacheCreationInputTokens - seen.tokensCacheWrite),
    tokensOut: Math.max(0, entry.outputTokens - seen.tokensOut),
  };
  return Object.values(remainder).some((count) => count > 0) ? remainder : null;
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
