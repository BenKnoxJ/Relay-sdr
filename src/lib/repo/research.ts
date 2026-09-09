import { Prisma, type Event, type PrismaClient } from "@prisma/client";

import { mutate } from "./mutate";

/**
 * Where a research pack lands, until Task 6d gives it a table.
 *
 * A completed research job writes one `research.completed` Event whose
 * `after` is the validated pack, its provenance report and what it ran under
 * (facts version and hash, breadth, the budget it used, the run id). A
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
  breadth: string;
};

export type RecordResearchCompletedResult = { event: Event; duplicate: boolean };

export async function recordResearchCompleted(
  db: PrismaClient,
  input: RecordResearchCompletedInput,
): Promise<RecordResearchCompletedResult> {
  const existing = await findResearchCompletedForJob(db, { orgId: input.orgId, jobId: input.jobId });
  if (existing !== null) return { event: existing, duplicate: true };
  try {
    await mutate(db, {
      orgId: input.orgId,
      actor: { kind: "system" },
      kind: RESEARCH_COMPLETED,
      after: {
        jobId: input.jobId,
        runId: input.runId,
        pack: input.pack,
        report: input.report,
        facts: input.facts,
        breadth: input.breadth,
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

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
