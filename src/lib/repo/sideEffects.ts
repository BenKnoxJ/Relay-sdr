import { Prisma, type PrismaClient, type SideEffect } from "@prisma/client";

import { mutate } from "@/lib/repo/mutate";

/**
 * Recording that a job did something the world can see.
 *
 * A `SideEffect` row is the claim "this has already happened" — the thing a
 * retry has to read before it acts, and the reason §25 rule 2 can promise a
 * send happens once rather than once per attempt. The key is the job's, not
 * the attempt's, so every attempt of the same job competes for the same row
 * and exactly one of them wins.
 *
 * It lives in `src/lib/repo/` rather than beside the handler that calls it
 * because that is where writes live (the lint in `eslint.config.mjs` closes
 * every other route), and because it is a domain event: `mutate` records the
 * Event in the same transaction as the row, so a timeline that shows a send
 * cannot disagree with the table that says it happened.
 */

/**
 * Whether an error is Postgres refusing a duplicate through a unique index.
 *
 * Exported because this table's unique key is now a guard for more than one
 * caller: `recordSideEffect` below writes the row that says a send already
 * happened, and `recordDraftReady` writes one purely so that "one draft per
 * job" is a constraint rather than a hope. Both have to tell "somebody else
 * won" apart from every other way an insert can fail, and a second hand-written
 * copy of that test is how one of them ends up checking the wrong code.
 */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export type RecordSideEffectInput = {
  orgId: string;
  /** What happened, named so a retry can recognise it. Unique per org. */
  key: string;
  jobId: string;
  /** When it happened, if that is not now — a provider's own timestamp. */
  at?: Date;
};

export type RecordSideEffectResult = {
  sideEffect: SideEffect;
  /** True when this key was already recorded, and that row is what is returned. */
  duplicate: boolean;
};

/**
 * Record a side effect, or report that this key already has one.
 *
 * The duplicate is returned rather than thrown, and the decision of what a
 * duplicate *means* is left to the caller: for a send it means "someone else
 * already did this, do nothing more", and for the `sleep` handler that proves
 * the mechanism it means the input was wrong and the job is terminally failed.
 * Deciding here would force one of those readings on both.
 */
export async function recordSideEffect(
  db: PrismaClient,
  input: RecordSideEffectInput,
): Promise<RecordSideEffectResult> {
  if (input.orgId.trim() === "") throw new Error("recordSideEffect: orgId is required");
  if (input.key.trim() === "") throw new Error("recordSideEffect: key is required");
  if (input.jobId.trim() === "") throw new Error("recordSideEffect: jobId is required");

  // Read before write, so the ordinary duplicate does not have to travel as a
  // thrown constraint violation. It is not the check that makes this safe —
  // two attempts can both read nothing — the unique index is, and the `catch`
  // below is where a genuine race lands.
  const existing = await db.sideEffect.findUnique({
    where: { orgId_key: { orgId: input.orgId, key: input.key } },
  });
  if (existing !== null) return { sideEffect: existing, duplicate: true };

  try {
    const sideEffect = await mutate(db, {
      orgId: input.orgId,
      actor: { kind: "system" },
      kind: "side_effect.recorded",
      after: { key: input.key, jobId: input.jobId },
      apply: (tx) =>
        tx.sideEffect.create({
          data: {
            orgId: input.orgId,
            key: input.key,
            jobId: input.jobId,
            ...(input.at === undefined ? {} : { at: input.at }),
          },
        }),
    });
    return { sideEffect, duplicate: false };
  } catch (error) {
    // P2002 is the unique index doing its job: the other attempt got there
    // between the read above and this insert. Its row is the answer, and this
    // transaction rolled back — including its Event — so there is exactly one
    // of each.
    if (!isUniqueViolation(error)) throw error;
    const winner = await db.sideEffect.findUniqueOrThrow({
      where: { orgId_key: { orgId: input.orgId, key: input.key } },
    });
    return { sideEffect: winner, duplicate: true };
  }
}
