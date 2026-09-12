import { Prisma, type AgentRunStep, type Event, type PrismaClient } from "@prisma/client";

import { mutate } from "./mutate";

/**
 * Where a research pack lands, until Task 6d gives it a table.
 *
 * A completed research job writes one `research.completed` Event whose
 * `after` is the validated pack, its provenance report and what it ran under
 * (facts and knowledge versions and hashes, the rails it ran under, whether a
 * rail cut it short, the run id). A
 * `SideEffect` row keyed `research:<jobId>` is written in the same
 * transaction, and its unique index is what makes a retry of a job that had
 * already completed find the first pack rather than write a second — the
 * pattern Task 7 set with `draft.ready`. When `research_packs` exists (6d),
 * this function writes the row instead and the Event stays as the record;
 * nothing that reads the pack changes shape.
 */

export const RESEARCH_COMPLETED = "research.completed";

export function researchGuardKey(jobId: string): string {
  return `research:${jobId}`;
}

export type RecordResearchCompletedInput = {
  orgId: string;
  jobId: string;
  runId: string;
  /** The validated pack, as `researchOutputSchema` parsed it. */
  pack: Prisma.InputJsonValue;
  /** The provenance report and the run's actuals; a reviewer's evidence. */
  report: Prisma.InputJsonValue;
  facts: { product: string; version: number; hash: string; draft: boolean };
  knowledge: { product: string; version: number; hash: string };
  /** True when a rail ended the run before every module was written (v3 §6). */
  partial: boolean;
  missingModules: string[];
  /** v3.2 (§10 note 28): how the research ended, and the rep's locked scope it was held to. */
  outcome: "complete" | "partial" | "insufficient";
  scope: Prisma.InputJsonValue;
};

export type RecordResearchCompletedResult = { event: Event; duplicate: boolean };

export async function recordResearchCompleted(
  db: PrismaClient,
  input: RecordResearchCompletedInput,
): Promise<RecordResearchCompletedResult> {
  const existing = await findResearchCompletedForJob(db, { orgId: input.orgId, jobId: input.jobId });
  if (existing !== null) return { event: existing, duplicate: true };
  // Integration metadata, not research: a job run for a campaign files its
  // completion on that campaign's timeline (`Event.campaignId`, indexed), read
  // off the job row itself so the research runtime passes nothing new. A
  // bench or other campaignless job leaves it null.
  const job = await db.job.findFirst({ where: { id: input.jobId, orgId: input.orgId }, select: { campaignId: true } });
  try {
    await mutate(db, {
      orgId: input.orgId,
      actor: { kind: "system" },
      kind: RESEARCH_COMPLETED,
      campaignId: job?.campaignId ?? null,
      after: {
        jobId: input.jobId,
        runId: input.runId,
        pack: input.pack,
        report: input.report,
        facts: input.facts,
        knowledge: input.knowledge,
        partial: input.partial,
        missingModules: input.missingModules,
        outcome: input.outcome,
        scope: input.scope,
      },
      // The guard row and the Event commit together; the Event is read back
      // below because `mutate` writes it after `apply` returns.
      apply: (tx) => tx.sideEffect.create({ data: { orgId: input.orgId, key: researchGuardKey(input.jobId), jobId: input.jobId } }),
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // The other attempt got there first; its Event is the pack.
  }
  const written = await findResearchCompletedForJob(db, { orgId: input.orgId, jobId: input.jobId });
  if (written === null) throw new Error(`research: the completion Event for job ${input.jobId} was not found after writing it`);
  return { event: written, duplicate: false };
}

/**
 * The completion Event for a job, or null.
 *
 * A JSON-path read on `after.jobId`, org-scoped. Unindexed, and fine while a
 * job has at most one such Event and a worker asks once per attempt; 6d's
 * table gives it a column and an index.
 */
export async function findResearchCompletedForJob(
  db: PrismaClient,
  where: { orgId: string; jobId: string },
): Promise<Event | null> {
  return db.event.findFirst({
    where: { orgId: where.orgId, kind: RESEARCH_COMPLETED, after: { path: ["jobId"], equals: where.jobId } },
    orderBy: { at: "asc" },
  });
}

/**
 * Every tool step of every run of a job, in the order they happened (runs by
 * creation, steps by index). Research v3 assembles the pack from the
 * `writeModule` steps and rebuilds the corpus from the search and fetch steps
 * across runs, so a retry keeps what an earlier run wrote and read.
 */
export async function listJobToolSteps(db: PrismaClient, where: { orgId: string; jobId: string }): Promise<AgentRunStep[]> {
  const runs = await db.agentRun.findMany({ where: { orgId: where.orgId, jobId: where.jobId }, orderBy: { createdAt: "asc" }, select: { id: true } });
  if (runs.length === 0) return [];
  const order = new Map(runs.map((run, i) => [run.id, i]));
  const steps = await db.agentRunStep.findMany({ where: { orgId: where.orgId, runId: { in: runs.map((run) => run.id) }, kind: "tool" } });
  return steps.sort((a, b) => (order.get(a.runId) ?? 0) - (order.get(b.runId) ?? 0) || a.index - b.index);
}

/** A job's totals across every run it has had (v3.2): what the rails and the rubric read, not one attempt's. */
export type JobActuals = {
  runs: number;
  searches: number;
  fetches: number;
  fetchedChars: number;
  modelSteps: number;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  /** Summed from the steps in micro-dollars, so it never drifts. */
  costUsd: number;
  /** From the first run's start to now. */
  elapsedSeconds: number;
  /** Each run from its start to its last step, summed: the time something was working. */
  activeSeconds: number;
  /** Runs never closed (killed or stopped mid-way). Their cost is what their steps recorded: a lower bound. */
  unfinishedRuns: string[];
};

/**
 * The totals of every run of a job, read from the stored steps (v3.2): a job
 * resumed after a kill reports the whole job, not the attempt that finished
 * it. A search or fetch counts once per stored step, as the rails charged it;
 * a replayed call writes no step and costs nothing. A failed call (its output
 * the reserved `$toolError`) is not a search or a fetch.
 */
export async function jobActuals(db: PrismaClient, where: { orgId: string; jobId: string }, now: Date = new Date()): Promise<JobActuals> {
  const runs = await db.agentRun.findMany({ where: { orgId: where.orgId, jobId: where.jobId }, orderBy: { startedAt: "asc" } });
  const empty: JobActuals = { runs: 0, searches: 0, fetches: 0, fetchedChars: 0, modelSteps: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0, costUsd: 0, elapsedSeconds: 0, activeSeconds: 0, unfinishedRuns: [] };
  if (runs.length === 0) return empty;
  const steps = await db.agentRunStep.findMany({
    where: { orgId: where.orgId, runId: { in: runs.map((run) => run.id) } },
    select: { runId: true, kind: true, name: true, output: true, cost: true, tokensIn: true, tokensOut: true, tokensCached: true, createdAt: true },
  });
  const out = { ...empty, runs: runs.length };
  let micros = 0;
  const lastStep = new Map<string, number>();
  for (const step of steps) {
    micros += Math.round(Number(step.cost.toString()) * 1_000_000);
    lastStep.set(step.runId, Math.max(lastStep.get(step.runId) ?? 0, step.createdAt.getTime()));
    if (step.kind === "model") {
      out.modelSteps += 1;
      out.tokensIn += step.tokensIn;
      out.tokensOut += step.tokensOut;
      out.tokensCached += step.tokensCached;
      continue;
    }
    const output = step.output as Record<string, unknown> | null;
    if (output === null || typeof output !== "object" || "$toolError" in output) continue;
    if (step.name === "search" && Array.isArray(output.hits)) out.searches += 1;
    if (step.name === "fetch" && typeof output.url === "string") {
      out.fetches += 1;
      if (typeof output.markdown === "string") out.fetchedChars += output.markdown.length;
    }
  }
  out.costUsd = micros / 1_000_000;
  out.elapsedSeconds = Math.max(0, Math.round((now.getTime() - runs[0]!.startedAt.getTime()) / 1000));
  out.activeSeconds = runs.reduce((sum, run) => sum + Math.max(0, Math.round(((lastStep.get(run.id) ?? run.startedAt.getTime()) - run.startedAt.getTime()) / 1000)), 0);
  out.unfinishedRuns = runs.filter((run) => run.status === "running").map((run) => run.id);
  return out;
}

/** This org's completed research packs by Event id, oldest first: the prior packs a run may read (v3 §4). */
export async function findResearchPacks(db: PrismaClient, where: { orgId: string; ids: readonly string[] }): Promise<Event[]> {
  if (where.ids.length === 0) return [];
  return db.event.findMany({ where: { orgId: where.orgId, kind: RESEARCH_COMPLETED, id: { in: [...where.ids] } }, orderBy: { at: "asc" } });
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
