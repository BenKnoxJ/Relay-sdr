import type { Event, Job, PrismaClient } from "@prisma/client";

import { enqueue } from "@/lib/jobs/queue";
import { mutate } from "@/lib/repo/mutate";
import { isUniqueViolation } from "@/lib/repo/sideEffects";

/**
 * The approval hand-off: how a run that stopped at drafts ready becomes a run
 * that sends.
 *
 * §24 makes approval database state rather than a suspended process. A run ends
 * — the job completes, the worker is free, the process may exit — and the only
 * thing left behind is a `draft.ready` Event. Approving is a second, separate
 * act: it writes `draft.approved` and enqueues the job that acts on it, and a
 * *different* worker picks that up later. Nothing is carried between the two in
 * memory, in a file, or in an environment variable, because there is nothing
 * between them: the first run is over before the second is asked for.
 *
 * That is the whole shape, and it is deliberately the shape slice 1's Inbox
 * uses for a real approve. Only the two handlers either side of it are stubs.
 *
 * **Why not suspend the run and resume it.** Because a suspended run is process
 * memory with a nice name. It cannot survive a deploy, it cannot survive the
 * SIGKILL proof 2 fires, and it makes "the rep has not decided yet" a thing the
 * worker has to hold open rather than a row it can forget about. §24 rejected
 * it; this module is what was chosen instead.
 *
 * **Why the Event and not an approvals table.** There is no Draft entity until
 * slice 1, so a table now would be a schema shaped around a stub. The Event is
 * already the record §25 rule 4 requires, and it is already org-scoped and
 * already timestamped, so the record exists either way. When slice 1 lands its
 * Draft entity, these three functions change and their callers do not.
 */

/** The Event that says a run stopped with something to approve. */
export const DRAFT_READY = "draft.ready" as const;
/** The Event a rep's approval writes. */
export const DRAFT_APPROVED = "draft.approved" as const;
/** The Event the send half writes once it has recorded what it sent. */
export const SEND_RECORDED = "send.recorded" as const;

/** The job kind approval enqueues. */
export const STUB_SEND = "stub_send" as const;

/**
 * The idempotency key the send job gets, derived from the draft it acts on.
 *
 * Derived from *what the work is about* and not from when it was asked for,
 * which is the rule `enqueue` documents and the reason a second approve returns
 * the first job instead of making a second one. `campaignless:` because there
 * is no Campaign entity yet and the key space will be per-campaign when there
 * is: naming the absence now means the prefix changes rather than the shape.
 */
export function stubSendKey(draftEventId: string): string {
  return `campaignless:${STUB_SEND}:${draftEventId}`;
}

/**
 * The `SideEffect` key that makes "one `draft.ready` per job" a constraint.
 *
 * `(org_id, key)` is unique (Task 5), and it is the only per-org uniqueness
 * surface this task can reach without a migration: the job id lives inside the
 * Event's `after`, and `events` has no index on it. So the row is written in
 * the same transaction as the Event and the index decides which of two racing
 * attempts is allowed to have written one.
 *
 * `stubSend.ts` says it writes no `SideEffect` row on purpose, and that is not
 * in tension with this: the objection there is that the table is what a real
 * send's retry consults to decide whether to send, so a `stub_send:*` key would
 * suppress the send Task 14 adds. Nothing consults a `draft.ready:*` key except
 * the unique index itself, and what it claims (this job's draft has been
 * recorded) is true.
 */
export function draftReadyKey(jobId: string): string {
  return `${DRAFT_READY}:${jobId}`;
}

/** A draft id that names nothing this org can see. Both cases, deliberately. */
export class DraftNotFoundError extends Error {
  constructor(draftEventId: string) {
    // Names the id the caller already had and nothing else: a caller that
    // guessed an id from another tenant learns only that it was refused, never
    // that it exists. CWE-639 is exactly the gap this closes.
    super(`approvals: no draft ready under ${JSON.stringify(draftEventId)}`);
    this.name = "DraftNotFoundError";
  }
}

/**
 * Thrown inside the approve transaction when the enqueue deduplicated, to roll
 * the transaction back. Private: it never leaves this module, because it is not
 * a failure — it is how the race is resolved.
 */
class AlreadyApprovedError extends Error {}

export type RecordDraftReadyInput = {
  orgId: string;
  /** The job whose run produced the draft. */
  jobId: string;
  /** The run that produced it, so the cost of the draft is one query away. */
  runId: string;
  /** The drafted text itself. A stub's whole output. */
  text: string;
};

/**
 * Record that a run reached drafts ready.
 *
 * Idempotent per job for the ordinary retry: a job retried after the run
 * completed but before the worker could complete the row would otherwise leave
 * two `draft.ready` Events for one piece of work, and a rep would be shown the
 * same draft twice.
 *
 * **The guard is a unique index, not the read.** The read in front of it is
 * only there so the ordinary retry does not have to travel as a thrown
 * constraint violation; it cannot be what makes this safe, because two attempts
 * can both read nothing. `queue.ts` is explicit that a worker which lost its
 * lease "may still be alive, and it will still try to write", and the queue's
 * fence protects the *job* row rather than this Event, so a zombie attempt and
 * the attempt that replaced it really can arrive here together. What stops them
 * both writing is `side_effects (org_id, key)`: the Event and a row keyed
 * `draftReadyKey(jobId)` are written in one transaction, so the loser's insert
 * violates the index and takes its Event down with it. Exactly one
 * `draft.ready` survives, so exactly one send key can ever be derived.
 *
 * Task 14 replaces the Event with a Draft row and the constraint moves onto it,
 * which is where it belongs. Until then this is the same shape `sideEffects.ts`
 * uses and for the same stated reason: "It is not the check that makes this
 * safe... the unique index is."
 */
export async function recordDraftReady(
  db: PrismaClient,
  input: RecordDraftReadyInput,
): Promise<Event> {
  if (input.orgId.trim() === "") throw new Error("recordDraftReady: orgId is required");
  if (input.jobId.trim() === "") throw new Error("recordDraftReady: jobId is required");
  if (input.runId.trim() === "") throw new Error("recordDraftReady: runId is required");

  const existing = await findDraftReadyForJob(db, input.orgId, input.jobId);
  if (existing !== null) return existing;

  // `apply` writes the guard row, and `mutate` is what puts it in the same
  // transaction as the Event — which is the whole mechanism, and also the
  // reason this goes through `mutate` rather than around it (the lint in
  // `eslint.config.mjs` closes every other route to an Event, and one written
  // outside a transaction would be an Event nothing could roll back).
  try {
    await mutate(db, {
      orgId: input.orgId,
      actor: { kind: "system" },
      kind: DRAFT_READY,
      after: { jobId: input.jobId, runId: input.runId, text: input.text },
      apply: (tx) =>
        tx.sideEffect.create({
          data: { orgId: input.orgId, key: draftReadyKey(input.jobId), jobId: input.jobId },
        }),
    });
  } catch (error) {
    // The other attempt got there between the read above and this insert. Its
    // Event is the answer, and it is already committed by the time this error
    // is raised: Postgres blocks the second inserter on the duplicate key until
    // the first transaction ends, and only calls it a violation if that ended
    // in a commit. So the read below cannot miss it.
    if (!isUniqueViolation(error)) throw error;
  }

  // Read back rather than returned from the transaction, because on the losing
  // path the Event that exists is the *winner's* and this call never held it.
  const written = await findDraftReadyForJob(db, input.orgId, input.jobId);
  // Unreachable: whichever transaction committed, it committed an Event this
  // query matches. Checked rather than asserted, so a future edit to the
  // `after` shape fails here and not in a caller holding a null it did not
  // expect.
  if (written === null) throw new Error("recordDraftReady: the Event was not written");
  return written;
}

export type ApproveStubDraftInput = {
  /** From the session. Never from request input — see `mutate`'s `orgId`. */
  orgId: string;
  /** From the session, likewise. This is who approved. */
  userId: string;
  draftEventId: string;
};

export type ApproveStubDraftResult = {
  /** The send job: the one this approve enqueued, or the one it already had. */
  job: Job;
  /** True when this draft was already approved, and no second Event was written. */
  alreadyApproved: boolean;
};

/**
 * Approve a draft: write the Event and enqueue the send, in one transaction.
 *
 * The two commit together or not at all, and that is the point rather than a
 * detail. Enqueue outside the transaction and a crash between them approves
 * something that never sends; write the Event outside and a rollback sends for
 * an approval that never happened. §25 rule 2 makes the Job the outbox for the
 * external write, and `enqueue` takes the transaction client precisely so this
 * function can be written the only way that is safe.
 *
 * **Approving twice is not an error, and writes nothing the second time.** A
 * rep double-clicks; a stale tab replays; the Inbox retries a request whose
 * response was lost. All three are the same act, so all three get the same job
 * back and leave one `draft.approved` Event behind.
 *
 * The guard is the send job's unique `(org_id, idempotency_key)`, and nothing
 * else. Not a read of the Event table, because the Event table has no
 * constraint to race against — two concurrent approves would both read no Event
 * and both write one. The job's index is the only thing here that can be won
 * exactly once, so it is what decides, and because the job and the Event commit
 * together the job is an exact proxy for the Event: neither can exist without
 * the other.
 *
 * There is deliberately **no fast-path read** in front of the transaction. One
 * was written first and then removed, for a reason worth recording: it made the
 * repeat case cheaper by a rollback and, in exchange, made the branch that
 * actually resolves a race unreachable in every test that could be written for
 * it — a second approve returned from the read and never reached the `deduped`
 * check at all. A guard that only runs under a true interleaving is a guard
 * nobody can prove works. This way there is one path, every repeat approve
 * takes it, and `tests/agents/handoff.test.ts` exercises it by simply
 * approving twice. The cost is one transaction that rolls back on a repeat,
 * which is not a case worth optimising.
 */
export async function approveStubDraft(
  db: PrismaClient,
  input: ApproveStubDraftInput,
): Promise<ApproveStubDraftResult> {
  if (input.orgId.trim() === "") throw new Error("approveStubDraft: orgId is required");
  if (input.userId.trim() === "") throw new Error("approveStubDraft: userId is required");
  if (input.draftEventId.trim() === "") {
    throw new Error("approveStubDraft: draftEventId is required");
  }

  // The draft must be this org's. `findFirst` with the org in the WHERE and not
  // `findUnique` on the id then a check afterwards: the tenant is part of the
  // question, so it belongs in the query rather than in a branch someone can
  // later move. §25 rule 3.
  const draft = await db.event.findFirst({
    where: { id: input.draftEventId, orgId: input.orgId, kind: DRAFT_READY },
    select: { id: true },
  });
  if (draft === null) throw new DraftNotFoundError(input.draftEventId);

  const idempotencyKey = stubSendKey(input.draftEventId);

  try {
    const job = await mutate(db, {
      orgId: input.orgId,
      // A user, not the system: the whole value of this Event is that it names
      // who decided. `Event.actorUserId` is what the timeline reads back.
      actor: { kind: "user", userId: input.userId },
      kind: DRAFT_APPROVED,
      // The job id cannot go in here — `mutate` builds the Event's `after` from
      // what it was handed, and the job does not exist until `apply` runs. The
      // key identifies the job exactly and is known now, so it goes instead.
      after: { draftEventId: input.draftEventId, idempotencyKey },
      apply: async (tx) => {
        const result = await enqueue(tx, {
          orgId: input.orgId,
          ownerUserId: input.userId,
          kind: STUB_SEND,
          idempotencyKey,
          input: { draftEventId: input.draftEventId },
        });
        if (result.deduped) {
          // This draft was already approved — a moment ago by a double-click,
          // or an hour ago by the rep themselves. Throw, so the transaction —
          // *including its Event* — rolls back and exactly one
          // `draft.approved` survives. Caught immediately below, where it
          // becomes an ordinary answer rather than a failure.
          throw new AlreadyApprovedError();
        }
        return result.job;
      },
    });
    return { job, alreadyApproved: false };
  } catch (error) {
    if (!(error instanceof AlreadyApprovedError)) throw error;
    const winner = await db.job.findUniqueOrThrow({
      where: { orgId_idempotencyKey: { orgId: input.orgId, idempotencyKey } },
    });
    return { job: winner, alreadyApproved: true };
  }
}

export type RecordStubSendInput = {
  orgId: string;
  /** The send job doing the recording. */
  jobId: string;
  draftEventId: string;
  /** A digest of what was "sent". A stub has nothing else to show. */
  digest: string;
};

/** Record what the send half sent. The second run's one piece of state. */
export async function recordStubSend(
  db: PrismaClient,
  input: RecordStubSendInput,
): Promise<Event> {
  if (input.orgId.trim() === "") throw new Error("recordStubSend: orgId is required");
  if (input.jobId.trim() === "") throw new Error("recordStubSend: jobId is required");
  if (input.digest.trim() === "") throw new Error("recordStubSend: digest is required");

  // The per-job guard `recordDraftReady` keeps, for the same reason: a send job
  // retried after this Event was written but before the job could be completed
  // would otherwise leave two `send.recorded` rows for one send.
  //
  // A read and not an index, which is the weaker half of the pair, and
  // deliberately: the index version wants a `send.recorded:<jobId>` row in
  // `side_effects`, and that is the one key `stubSend.ts` argues must not exist
  // yet, because it is what a real send's retry will consult to decide whether
  // to send. Writing one now would suppress Task 14's first real send. The
  // exposure is two `send.recorded` Events for one send under a lost lease,
  // which is a duplicated record rather than a duplicated send, and Task 14
  // closes it with the send it belongs to.
  const existing = await findEventForJob(db, input.orgId, SEND_RECORDED, input.jobId);
  if (existing !== null) return existing;

  // A no-op `apply`, for the same reason `recordDraftReady` has one.
  await mutate(db, {
    orgId: input.orgId,
    actor: { kind: "system" },
    kind: SEND_RECORDED,
    after: {
      jobId: input.jobId,
      draftEventId: input.draftEventId,
      digest: input.digest,
    },
    apply: () => Promise.resolve(null),
  });

  const written = await findEventForJob(db, input.orgId, SEND_RECORDED, input.jobId);
  if (written === null) throw new Error("recordStubSend: the Event was not written");
  return written;
}

/**
 * The one Event of a kind whose `after.jobId` is this job, or null.
 *
 * A JSON path filter, so Postgres does the matching and the row never has to
 * cross the wire to be rejected. It is **not** an indexed lookup: `events`
 * indexes `(org_id, at)`, `(kind, at)`, `(campaign_id, at)` and
 * `(person_id, at)` and nothing on `after`, so this narrows by kind and then
 * scans. That is affordable at this task's size and would not be on the
 * Inbox's read path — the index it wants is expression-based on
 * `after->>'jobId'`, which is a migration, and Task 14's Draft row makes it a
 * plain foreign key instead. Named in the pull request.
 *
 * `findFirst` and not `findUnique`, because the constraint that keeps
 * `draft.ready` to one per job lives on `side_effects` and not on this table:
 * there is nothing here for `findUnique` to take. Ordered, so that if that ever
 * stops holding — `send.recorded` has only the read — the answer is the first
 * one written rather than an arbitrary row.
 */
async function findEventForJob(
  db: PrismaClient,
  orgId: string,
  kind: typeof DRAFT_READY | typeof SEND_RECORDED,
  jobId: string,
): Promise<Event | null> {
  return db.event.findFirst({
    where: { orgId, kind, after: { path: ["jobId"], equals: jobId } },
    // `id` breaks the tie: `at` is `timestamp(3)` from the column default, so
    // two Events written in the same millisecond would otherwise make "the
    // first one written" an arbitrary answer that can change between calls.
    orderBy: [{ at: "asc" }, { id: "asc" }],
  });
}

/** The draft a job produced, or null. Exported for the handler that reads one. */
export function findDraftReadyForJob(
  db: PrismaClient,
  orgId: string,
  jobId: string,
): Promise<Event | null> {
  return findEventForJob(db, orgId, DRAFT_READY, jobId);
}

/** The text a `draft.ready` Event carries, or null when it carries none. */
export function draftText(after: unknown): string | null {
  if (typeof after !== "object" || after === null || Array.isArray(after)) return null;
  const value = (after as Record<string, unknown>).text;
  return typeof value === "string" ? value : null;
}
