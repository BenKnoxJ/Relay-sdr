import { Prisma, type AgentRun, type AgentRunStep, type PrismaClient } from "@prisma/client";

/**
 * The write path for the two agent tables.
 *
 * It is in `src/lib/repo/` because that is where writes live (the lint in
 * `eslint.config.mjs` closes every other route), and it writes **directly**
 * rather than through `mutate`, which is a deliberate departure worth stating.
 *
 * `mutate` records an Event in the same transaction as the row, and that is
 * right for a domain change — a side effect, a user placed in an org. A step is
 * not a domain change; it is a line in a meter. A research run makes forty
 * model calls and twenty-five fetches, so an Event per step would put sixty-five
 * rows in `events` for one thing the rep did, and Task 11's timeline would be
 * unreadable for exactly the reason the queue is allowed to write without an
 * Event: "a `job.enqueued` Event per retry would bury the record it exists to
 * be". The domain Events for a run — `research.completed`, `research.stopped` —
 * belong to the orchestrator (Task 7), which has the campaign context to name
 * them, and they are one per run rather than one per step.
 *
 * Nothing here is deleted and every row carries its `orgId`, so both of §25's
 * other rules hold unchanged. Every `where` in this file is scoped on `orgId`
 * as well as on the id, so a caller that is handed a run id cannot reach across
 * a tenant boundary with it; `appendModelStep` is the exception and says why.
 */

export type StartRunInput = {
  orgId: string;
  jobId: string;
  /** Which definition is running — `research`, `echo`, … */
  kind: string;
  /** The pinned model id, as the price table spells it. */
  model: string;
};

export async function startRun(db: PrismaClient, input: StartRunInput): Promise<AgentRun> {
  // The same shape of guard the queue and `mutate` keep: the types say these
  // are non-empty and a JavaScript caller says otherwise, and a run with a
  // blank `orgId` is a row no tenant can ever read back.
  requireText("startRun", { orgId: input.orgId, jobId: input.jobId, kind: input.kind, model: input.model });
  return db.agentRun.create({
    data: { orgId: input.orgId, jobId: input.jobId, kind: input.kind, model: input.model },
  });
}

export type FinishRunInput = {
  /**
   * The tenant that owns the run.
   *
   * Part of the `where`, not just of the data. §25 rule 3 is that every read and
   * every write is org-scoped, and an id on its own is a caller-supplied handle:
   * today every run id in this file is minted by the same statement that closes
   * it, and from Task 7 the router closes runs it was handed the id of. Scoping
   * now means the id never becomes the only thing standing between one tenant
   * and another's row. A mismatch updates nothing and Prisma raises P2025.
   */
  orgId: string;
  runId: string;
  status: "done" | "failed";
  /** The sum of the steps' cost, as a `Decimal(12,6)` string. */
  costTotal: string;
  /** Bounded and scrubbed by the caller. */
  error?: string;
};

export async function finishRun(db: PrismaClient, input: FinishRunInput): Promise<AgentRun> {
  return db.agentRun.update({
    where: { id: input.runId, orgId: input.orgId },
    data: {
      status: input.status,
      costTotal: new Prisma.Decimal(input.costTotal),
      finishedAt: new Date(),
      ...(input.error === undefined ? {} : { error: input.error }),
    },
  });
}

export type ModelStepInput = {
  orgId: string;
  runId: string;
  index: number;
  /** The model id, so a step says which model answered it. */
  name: string;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  tokensReasoning: number;
  /** `Decimal(12,6)` as a string. */
  cost: string;
  /** Whatever the provider returned alongside the result, plus the normalised usage. */
  providerMeta: Prisma.InputJsonValue;
};

/**
 * One completed model call.
 *
 * Inserted whole rather than begun-and-finished, because a model call's tokens
 * and cost are only known once it has returned: there is no half-written state
 * worth a row. `startedAt` and `finishedAt` are both now, and the duration of
 * the call itself lives in `providerMeta.performance`.
 *
 * The only write here with no `where` to scope: a create carries its `orgId` in
 * the row it writes, and the row is what a later read is filtered on. What a
 * create cannot check is that `runId` belongs to `orgId` — that would cost a
 * read per step to prove something the caller already knows, since `runAgent`
 * mints both from one context. If a caller ever appends a step to a run id it
 * did not open, this is where the check goes.
 */
export async function appendModelStep(db: PrismaClient, input: ModelStepInput): Promise<AgentRunStep> {
  return db.agentRunStep.create({
    data: {
      orgId: input.orgId,
      runId: input.runId,
      index: input.index,
      kind: "model",
      name: input.name,
      tokensIn: input.tokensIn,
      tokensOut: input.tokensOut,
      tokensCached: input.tokensCached,
      tokensReasoning: input.tokensReasoning,
      cost: new Prisma.Decimal(input.cost),
      providerMeta: input.providerMeta,
      finishedAt: new Date(),
    },
  });
}

/** A stored tool step for this org and key, or null. */
export async function findToolStep(
  db: PrismaClient,
  where: { orgId: string; toolKey: string },
): Promise<AgentRunStep | null> {
  return db.agentRunStep.findUnique({
    where: { orgId_toolKey: { orgId: where.orgId, toolKey: where.toolKey } },
  });
}

export type BeginToolStepInput = {
  orgId: string;
  runId: string;
  index: number;
  name: string;
  toolKey: string;
  input: Prisma.InputJsonValue;
};

export type BeginToolStepResult = {
  step: AgentRunStep;
  /**
   * True when this key already had a step and that row is what is returned.
   *
   * The caller must not execute the tool in that case — the row is the claim
   * "this has already been spent", which is the whole point of the key.
   */
  replayed: boolean;
};

/**
 * Claim a tool step for a key, or report that someone already has.
 *
 * The input is written **before** the tool runs and the output after, so a
 * worker killed mid-call leaves a row saying what was attempted. The unique
 * index on `(org_id, tool_key)` is what makes the claim safe; the read in
 * `findToolStep` is only there to keep the ordinary replay off the exception
 * path, exactly as `recordSideEffect` does it.
 */
export async function beginToolStep(
  db: PrismaClient,
  input: BeginToolStepInput,
): Promise<BeginToolStepResult> {
  requireText("beginToolStep", { orgId: input.orgId, runId: input.runId, name: input.name, toolKey: input.toolKey });
  const existing = await findToolStep(db, { orgId: input.orgId, toolKey: input.toolKey });
  if (existing !== null) return { step: existing, replayed: true };
  try {
    const step = await db.agentRunStep.create({
      data: {
        orgId: input.orgId,
        runId: input.runId,
        index: input.index,
        kind: "tool",
        name: input.name,
        toolKey: input.toolKey,
        input: input.input,
      },
    });
    return { step, replayed: false };
  } catch (error) {
    // P2002 on `(org_id, tool_key)` is the index doing its job: a concurrent
    // call claimed the key between the read above and this insert. Its row is
    // the answer. Any other unique violation — `(run_id, index)` — is a bug in
    // the index allocation and must not be swallowed as a replay.
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== "P2002" ||
      !targetsToolKey(error)
    ) {
      throw error;
    }
    const winner = await findToolStep(db, { orgId: input.orgId, toolKey: input.toolKey });
    if (winner === null) throw error;
    return { step: winner, replayed: true };
  }
}

/** Which constraint a P2002 names, as Prisma reports it. */
function targetsToolKey(error: Prisma.PrismaClientKnownRequestError): boolean {
  const target: unknown = error.meta?.target;
  const fields = Array.isArray(target) ? target.map(String) : typeof target === "string" ? [target] : [];
  return fields.some((field) => field.includes("tool_key") || field.includes("toolKey"));
}

export type FinishToolStepInput = {
  /** Scoped for the same reason `FinishRunInput.orgId` is. */
  orgId: string;
  stepId: string;
  output: Prisma.InputJsonValue;
  /** Tools spend credits, not tokens; Phase 1 records zero and slice 1 fills it in. */
  cost?: string;
};

export async function finishToolStep(db: PrismaClient, input: FinishToolStepInput): Promise<AgentRunStep> {
  return db.agentRunStep.update({
    where: { id: input.stepId, orgId: input.orgId },
    data: {
      output: input.output,
      finishedAt: new Date(),
      ...(input.cost === undefined ? {} : { cost: new Prisma.Decimal(input.cost) }),
    },
  });
}

/**
 * Record that a tool threw.
 *
 * The error goes in `output` rather than in a column of its own: the step's
 * output *is* what the tool produced, and for a failed call what it produced is
 * a failure. The key it goes under is `src/lib/agents/tools.ts`'s reserved
 * `FAILURE_KEY`, not a plain `error` — a tool is entitled to return
 * `{ error: … }` as a perfectly good result, and a replay must be able to tell
 * the two apart. The caller scrubs and bounds the text.
 */
export async function failToolStep(
  db: PrismaClient,
  input: { orgId: string; stepId: string; failureKey: string; error: string },
): Promise<AgentRunStep> {
  return db.agentRunStep.update({
    where: { id: input.stepId, orgId: input.orgId },
    data: { output: { [input.failureKey]: input.error }, finishedAt: new Date() },
  });
}

/** Every step of a run, in the order they happened. Org-scoped, as every read is. */
export async function listSteps(
  db: PrismaClient,
  where: { orgId: string; runId: string },
): Promise<AgentRunStep[]> {
  return db.agentRunStep.findMany({
    where: { orgId: where.orgId, runId: where.runId },
    orderBy: { index: "asc" },
  });
}

function requireText(caller: string, fields: Record<string, string>): void {
  for (const [name, value] of Object.entries(fields)) {
    if (value.trim() === "") throw new Error(`${caller}: ${name} is required`);
  }
}
