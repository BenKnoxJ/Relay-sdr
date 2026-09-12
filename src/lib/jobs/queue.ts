import { Prisma, type Job, type JobStatus, type PrismaClient } from "@prisma/client";

/**
 * The job queue (master doc §24, §25 rule 2).
 *
 * Durability lives in Postgres, so this module is the whole runtime spine: a
 * worker claims a row, holds a *lease* on it, extends the lease while the work
 * is in flight, and finishes it. Everything here follows from two facts.
 *
 * **The claim is one statement.** That is what makes it exclusive: there is no
 * window between choosing a row and marking it running in which a second worker
 * could choose it too. Measured, not assumed — split into a `SELECT` and an
 * `UPDATE` and the race test claims 165 of 200 jobs twice.
 *
 * `FOR UPDATE SKIP LOCKED` in the sub-select is the throughput half, and it is
 * worth being precise about which half: without it the claim is still exclusive
 * (a blocked claimer re-checks `status` after taking the lock and moves on), but
 * two workers take turns instead of working at once. Removing only `SKIP LOCKED`
 * leaves the race test green, so do not read that test as its proof.
 *
 * **Every other write is fenced.** A lease can be lost — the worker is
 * SIGKILLed, the box goes away, a research call outruns the lease and the
 * reaper requeues the job — and the process that lost it does not know. It may
 * still be alive, and it will still try to write. So `extendLease`, `complete`,
 * `fail` and `requeue` all carry the same `WHERE`: this row, still `running`,
 * still held by *this* `worker_id`, and still on *this* attempt. A zombie's
 * write matches nothing and changes nothing, and it is told so
 * (`{fenced: true}`) rather than being left to believe it finished the job.
 *
 * `attempts` is in there because `worker_id` is not enough on its own, and the
 * case that breaks it is the ordinary one rather than an exotic race: a worker
 * whose lease expired is reaped, and the very next poll of that *same* worker
 * claims the job back. Same id, so an in-flight write from the first attempt
 * matches the second attempt's row and marks a job done that is still being
 * worked. The attempt number is the fencing token — `claimNext` hands it out
 * and it only ever goes up, so a claim from before the reap can never match a
 * claim from after it. That is why the writes take the `Claim` they were given
 * rather than a job id and a worker id.
 *
 * The fence is those three columns and *not* `lease_until > now()`, which is a
 * deliberate departure from the obvious reading of "fence on the lease". The
 * reaper is what turns an expired lease into a lost one, and it does that by
 * clearing `worker_id` and moving the status — so by the time anyone else can
 * hold this job, one of those three columns has already changed and the fence
 * has closed. Adding the lease predicate would reject exactly one case the columns
 * accept: the window after a lease expires and before the reaper has run, when
 * the holder is still the only claimant there is. Rejecting it there is not
 * caution, it is harm — a garbage-collection pause between an external send and
 * `complete` would fence the completion, requeue the job, and send it twice,
 * which is the one thing §25 rule 2 exists to stop.
 *
 * This module is the one writer outside `src/lib/repo/**` (see the carve-out in
 * `eslint.config.mjs`): enqueueing a job is not a domain event, and a
 * `job.enqueued` Event for every retry would bury the record it is meant to be.
 *
 * **No JavaScript clock is ever compared against a stored time.** Every `now`
 * in here is the database's, because the worker's clock and the database's are
 * two different clocks and a lease decided by the wrong one either expires
 * early or never. That includes the times `enqueue` *writes*: Prisma fills a
 * `@default(now())` from the Node process it runs in, not from the column
 * default, so a job enqueued by a host whose clock runs a minute fast would sit
 * invisible to `claimNext` for a minute — the skew hidden inside a comparison
 * that looks like it is between two database values. So `enqueue` writes its
 * row with raw SQL and lets `now()` fill the timestamps. The one exception is
 * an explicit `nextAt`, which is the caller's instant on purpose.
 *
 * The columns are `timestamp(3)` *without* time zone, holding
 * UTC wall-clock (that is how Prisma writes a `Date`), so the SQL says
 * `now() AT TIME ZONE 'UTC'` and not a bare `now()`: the bare form is a
 * `timestamptz`, and comparing it to these columns casts through whatever the
 * session's `TimeZone` happens to be. It is UTC on every box we run today,
 * which is exactly why an implicit dependency on it would go unnoticed.
 */

/** Attempts a job gets before the failure is terminal. Mirrors the column default. */
export const MAX_ATTEMPTS = 3;

/** How long a claim holds a job before the reaper may take it back. */
export const LEASE_MS = 120_000;

/**
 * How often the worker should call `extendLease` while it holds a job. A
 * quarter of the lease, so two extensions can be lost to a slow database or a
 * blocked event loop before the job is reaped out from under a live worker.
 */
export const EXTEND_EVERY_MS = 30_000;

/** What the reaper leaves in `Job.error`: no PII, and it explains the requeue. */
export const LEASE_EXPIRED_ERROR = "lease expired";

/** Every state a job can be in, for exhaustiveness checks and for the UI. */
export const JOB_STATUSES = ["queued", "running", "done", "failed", "cancelled"] as const;

export type { Job };

/**
 * A job as `claimNext` returns it: the worker and lease are set, because the
 * statement that produced it set them. Typed rather than asserted at each use.
 */
export type ClaimedJob = Job & { workerId: string; leaseUntil: Date };

/**
 * What a worker must present to write to a job it has claimed: which row, whose
 * claim, and which attempt. A `ClaimedJob` is one, so the ordinary call passes
 * the job `claimNext` returned straight back.
 */
export type Claim = Pick<ClaimedJob, "id" | "workerId" | "attempts">;

/**
 * The result of a fenced write: it landed, or the caller no longer holds the
 * job. Both members carry both fields so the union discriminates on either one
 * — `if (result.ok)` and `if (result.fenced)` are equally valid reads, and
 * neither is an `in` check against an optional property.
 */
export type FenceResult = { ok: true; fenced: false } | { ok: false; fenced: true };

const LANDED = { ok: true, fenced: false } as const;
const FENCED = { ok: false, fenced: true } as const;

export type EnqueueInput = {
  orgId: string;
  /** Set when the job belongs to one rep's work; omitted for org-level jobs. */
  ownerUserId?: string;
  kind: string;
  /**
   * Derived from what the job is *about* ("send touch 1 to this person"), not
   * from when it was made: that is what makes a retry return the first job
   * rather than making a second one. Unique per org, never globally.
   */
  idempotencyKey: string;
  input: Prisma.InputJsonValue;
  priority?: number;
  /** Hold the job until this time. Omitted, it is due immediately. */
  nextAt?: Date;
  /**
   * The campaign and brief version the job belongs to. Both or neither: a
   * campaign's research is always research for one version of its brief, and
   * which version is a column, never something read back out of the key.
   */
  campaignId?: string;
  briefVersion?: number;
};

export type EnqueueResult = {
  job: Job;
  /** True when this key already had a job in this org, and that is what is returned. */
  deduped: boolean;
};

/**
 * Put a job on the queue, or hand back the one this key already has.
 *
 * Never throws on a duplicate key. Rule 2 of §25 is that every external write
 * is a Job with an idempotency key; a retried enqueue that made a second row
 * would defeat the rule at the first hop.
 *
 * The key wins whatever state its job is in, `done` and `failed` included, and
 * a differing `input` on the second call is discarded rather than applied. Both
 * follow from what the key means: it names the work ("send touch 1 to this
 * person"), so a second job under it is a second send. Re-running work that has
 * already failed is a new job with a new key, and deliberately a decision
 * someone has to make rather than a retry that quietly becomes one.
 *
 * `db` is a `TransactionClient`, which a `PrismaClient` also satisfies. That is
 * the one thing on this module that has to compose with `mutate`: §25 rule 2
 * makes the Job the outbox for an external write, so the state change and the
 * job that acts on it have to commit together. Enqueue after the transaction
 * and a crash in between loses the send; enqueue before it and a rollback sends
 * for a change that never happened. Inside `mutate`'s `apply`, neither.
 *
 * The insert is one statement — `ON CONFLICT … DO NOTHING` — and that is not a
 * style preference. `create`-and-catch-`P2002` works on an autocommit client
 * and is dead code inside a transaction: the losing INSERT aborts the whole
 * Postgres transaction, so the recovery read in the `catch` fails too and the
 * caller's state change and its Event roll back with an opaque connector error.
 * Exactly the case this function has to survive, given where it is meant to be
 * called from.
 *
 * That is also why `id` is minted here with `crypto.randomUUID()` rather than
 * by Prisma's `@default(cuid())`: a single-statement insert has to supply the
 * key, and Prisma exports no cuid generator to supply it with. Job ids are
 * therefore uuids where every other table's are cuids — internal rows, never
 * shown to a rep, and flagged in the pull request for sign-off.
 *
 * `next_at` is the caller's when they give one, because "send at 09:00 UTC on
 * Tuesday" is an instant and not a duration; left out, it is the database's
 * `now()`, so the file's clock rule holds for every value this module chooses.
 */
export async function enqueue(
  db: Prisma.TransactionClient,
  input: EnqueueInput,
): Promise<EnqueueResult> {
  // The same guards `mutate` keeps, and for the same reason: the types say
  // these are non-empty, and a JavaScript caller, an `as` cast or a value that
  // arrived from a request body all say otherwise. A key that derives to the
  // empty string is worse than a missing one — it collapses every job in the
  // org that hits the same bug into a single row, and each of them is told it
  // was deduplicated against work that has nothing to do with it.
  if (input.orgId.trim() === "") throw new Error("enqueue: orgId is required");
  if (input.kind.trim() === "") throw new Error("enqueue: kind is required");
  if (input.idempotencyKey.trim() === "") {
    throw new Error("enqueue: idempotencyKey is required");
  }

  // The owner must be in the org the job belongs to. The foreign key alone
  // does not say that — `owner_user_id` references `users(id)` with no regard
  // for which tenant that user is in — so without this check a caller that
  // took the user id from request input could hang one org's job off another
  // org's rep, and Task 11's "my jobs" screen would show it to them. §25 rule
  // 3 is that every row is org-scoped; this is the one column on `jobs` where
  // that has to be checked rather than declared.
  //
  // Read inside the caller's transaction, so a user created in the same
  // transaction is visible and one rolled back is not.
  if (input.ownerUserId !== undefined) {
    const owner = await db.user.findUnique({
      where: { id: input.ownerUserId },
      select: { orgId: true },
    });
    if (owner === null || owner.orgId !== input.orgId) {
      // The message names neither the other org nor the user's own: a caller
      // that guessed an id learns only that the pairing was refused.
      throw new Error("enqueue: ownerUserId is not a user of this org");
    }
  }

  // The campaign likewise: its foreign key says the campaign exists, not whose
  // it is. Checked here, in the caller's transaction, for the reason the owner
  // is: a campaign created in the same transaction must be visible.
  if ((input.campaignId === undefined) !== (input.briefVersion === undefined)) {
    throw new Error("enqueue: campaignId and briefVersion come together");
  }
  if (input.campaignId !== undefined) {
    if (!Number.isInteger(input.briefVersion) || input.briefVersion! < 1) {
      throw new Error("enqueue: briefVersion is a positive whole number");
    }
    const campaign = await db.campaign.findUnique({
      where: { id: input.campaignId },
      select: { orgId: true, briefVersion: true },
    });
    if (campaign === null || campaign.orgId !== input.orgId) {
      throw new Error("enqueue: campaignId is not a campaign of this org");
    }
    if (input.briefVersion! > campaign.briefVersion) {
      throw new Error("enqueue: briefVersion is ahead of the campaign's own");
    }
    // Behind is refused too: research for a brief the campaign has already
    // moved on from is work no screen would ever show, and a job for it would
    // run and spend all the same.
    if (input.briefVersion! < campaign.briefVersion) {
      throw new Error("enqueue: briefVersion is behind the campaign's own");
    }
  }

  const rows = await db.$queryRaw<JobRow[]>`
    INSERT INTO jobs (id, org_id, owner_user_id, kind, idempotency_key,
                      priority, next_at, input, campaign_id, brief_version,
                      created_at, updated_at)
    VALUES (${crypto.randomUUID()},
            ${input.orgId},
            ${input.ownerUserId ?? null},
            ${input.kind},
            ${input.idempotencyKey},
            ${input.priority ?? 0},
            COALESCE(${input.nextAt ?? null}::timestamp(3), (now() AT TIME ZONE 'UTC')),
            ${JSON.stringify(input.input)}::jsonb,
            ${input.campaignId ?? null},
            ${input.briefVersion ?? null}::integer,
            (now() AT TIME ZONE 'UTC'),
            (now() AT TIME ZONE 'UTC'))
    ON CONFLICT (org_id, idempotency_key) DO NOTHING
    RETURNING *
  `;
  const row = rows[0];
  if (row !== undefined) return { job: toJob(row), deduped: false };

  // `DO NOTHING` raised nothing, so the transaction is intact and this read is
  // safe. `findUniqueOrThrow`, not `findUnique`: the conflict means the row is
  // there, and if it somehow is not, that is worth an error rather than a null
  // for the caller to interpret.
  const job = await db.job.findUniqueOrThrow({
    where: {
      orgId_idempotencyKey: { orgId: input.orgId, idempotencyKey: input.idempotencyKey },
    },
  });
  return { job, deduped: true };
}

/** The raw row `RETURNING *` gives back: snake_case columns, native types. */
type JobRow = {
  id: string;
  org_id: string;
  owner_user_id: string | null;
  kind: string;
  idempotency_key: string;
  status: JobStatus;
  priority: number;
  attempts: number;
  max_attempts: number;
  next_at: Date;
  lease_until: Date | null;
  worker_id: string | null;
  input: Prisma.JsonValue;
  response_digest: string | null;
  error: string | null;
  campaign_id: string | null;
  brief_version: number | null;
  created_at: Date;
  updated_at: Date;
};

/** Raw SQL returns the columns; the rest of the codebase works in `Job`. */
export function toJob(row: JobRow): Job {
  return {
    id: row.id,
    orgId: row.org_id,
    ownerUserId: row.owner_user_id,
    kind: row.kind,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    priority: row.priority,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    nextAt: row.next_at,
    leaseUntil: row.lease_until,
    workerId: row.worker_id,
    input: row.input,
    responseDigest: row.response_digest,
    error: row.error,
    campaignId: row.campaign_id,
    briefVersion: row.brief_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Seconds, as `make_interval` wants them. Milliseconds are what callers think in. */
const seconds = (ms: number): number => ms / 1000;

export type ClaimOptions = { leaseMs?: number };

/**
 * Claim the next due job for this worker, or null when there is nothing to do.
 *
 * Highest priority first, then the longest overdue, then the oldest. The
 * attempt is counted as part of the claim, so the number a worker reads is the
 * attempt it is making — and a worker that dies without saying anything has
 * still spent one.
 */
export async function claimNext(
  db: PrismaClient,
  workerId: string,
  options: ClaimOptions = {},
): Promise<ClaimedJob | null> {
  const leaseMs = options.leaseMs ?? LEASE_MS;
  const rows = await db.$queryRaw<JobRow[]>`
    UPDATE jobs
       SET status = 'running'::"job_status",
           worker_id = ${workerId},
           lease_until = (now() AT TIME ZONE 'UTC')
                         + make_interval(secs => ${seconds(leaseMs)}::double precision),
           attempts = attempts + 1,
           updated_at = (now() AT TIME ZONE 'UTC')
     WHERE id = (
             SELECT id
               FROM jobs
              WHERE status = 'queued'::"job_status"
                AND next_at <= (now() AT TIME ZONE 'UTC')
              ORDER BY priority DESC, next_at ASC, created_at ASC
                FOR UPDATE SKIP LOCKED
              LIMIT 1
           )
    RETURNING *
  `;
  const row = rows[0];
  if (row === undefined) return null;
  const job = toJob(row);
  if (job.workerId === null || job.leaseUntil === null) {
    // Unreachable: the statement above sets both. Checked rather than asserted
    // so that a future edit to that statement fails here and not in a caller.
    throw new Error("claimNext: the claim did not set a worker and a lease");
  }
  return { ...job, workerId: job.workerId, leaseUntil: job.leaseUntil };
}

/**
 * Renew the lease on a job this worker holds.
 *
 * The plan's top risk: a research call outlasts `LEASE_MS`, the reaper requeues
 * the job, and a second worker starts the same work while the first is still
 * running it. The holder renews every `EXTEND_EVERY_MS` to stop that — and only
 * the holder can, which is what stops the *reaped* worker from undoing the
 * reap.
 */
export async function extendLease(
  db: PrismaClient,
  claim: Claim,
  options: { leaseMs?: number } = {},
): Promise<FenceResult> {
  const leaseMs = options.leaseMs ?? LEASE_MS;
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    UPDATE jobs
       SET lease_until = (now() AT TIME ZONE 'UTC')
                         + make_interval(secs => ${seconds(leaseMs)}::double precision),
           updated_at = (now() AT TIME ZONE 'UTC')
     WHERE id = ${claim.id}
       AND worker_id = ${claim.workerId}
       AND attempts = ${claim.attempts}
       AND status = 'running'::"job_status"
    RETURNING id
  `;
  return rows.length === 1 ? LANDED : FENCED;
}

/** The job is done. Fenced: a worker that lost its lease cannot say this. */
export async function complete(
  db: PrismaClient,
  claim: Claim,
  options: { responseDigest?: string } = {},
): Promise<FenceResult> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    UPDATE jobs
       SET status = 'done'::"job_status",
           response_digest = ${options.responseDigest ?? null},
           error = NULL,
           worker_id = NULL,
           lease_until = NULL,
           updated_at = (now() AT TIME ZONE 'UTC')
     WHERE id = ${claim.id}
       AND worker_id = ${claim.workerId}
       AND attempts = ${claim.attempts}
       AND status = 'running'::"job_status"
    RETURNING id
  `;
  return rows.length === 1 ? LANDED : FENCED;
}

/** Terminal failure: the input is unusable, or the attempts are spent. */
export async function fail(
  db: PrismaClient,
  claim: Claim,
  error: string,
): Promise<FenceResult> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    UPDATE jobs
       SET status = 'failed'::"job_status",
           error = ${error},
           worker_id = NULL,
           lease_until = NULL,
           updated_at = (now() AT TIME ZONE 'UTC')
     WHERE id = ${claim.id}
       AND worker_id = ${claim.workerId}
       AND attempts = ${claim.attempts}
       AND status = 'running'::"job_status"
    RETURNING id
  `;
  return rows.length === 1 ? LANDED : FENCED;
}

export type RequeueResult =
  | { ok: true; fenced: false; status: Extract<JobStatus, "queued" | "failed"> }
  | { ok: false; fenced: true };

/**
 * Hand the job back for another go after `delayMs`, carrying what went wrong so
 * the next attempt can read it.
 *
 * The attempt cap is applied *here*, in the same statement, rather than left to
 * the caller to check and then call `fail`: the caller would be reading
 * `attempts` from the row it claimed, deciding on it, and writing afterwards —
 * three steps where the cap is one column comparison the database can make
 * while it holds the row. `status` in the result says which of the two happened.
 */
export async function requeue(
  db: PrismaClient,
  claim: Claim,
  options: { error: string; delayMs: number },
): Promise<RequeueResult> {
  const rows = await db.$queryRaw<Array<{ status: JobStatus }>>`
    UPDATE jobs
       SET status = CASE
                      WHEN attempts < max_attempts THEN 'queued'::"job_status"
                      ELSE 'failed'::"job_status"
                    END,
           next_at = (now() AT TIME ZONE 'UTC')
                     + make_interval(secs => ${seconds(options.delayMs)}::double precision),
           error = ${options.error},
           worker_id = NULL,
           lease_until = NULL,
           updated_at = (now() AT TIME ZONE 'UTC')
     WHERE id = ${claim.id}
       AND worker_id = ${claim.workerId}
       AND attempts = ${claim.attempts}
       AND status = 'running'::"job_status"
    RETURNING status
  `;
  const row = rows[0];
  if (row === undefined) return FENCED;
  return { ok: true, fenced: false, status: row.status as "queued" | "failed" };
}

/**
 * Hand a claimed job straight back, unattempted.
 *
 * The deploy case, and the one place `attempts` goes *down*. A worker draining
 * on SIGTERM has a handler it cannot finish in the time systemd allows: the
 * work did not fail, it was never done, and nobody but the operator decided to
 * stop it. `requeue` is the wrong verb for that on two counts — it charges the
 * attempt (so three deploys during a busy hour exhaust a job that has never
 * once been tried) and it applies the cap (so a job on its last attempt is
 * marked `failed` by a restart, which for a send is work silently dropped).
 *
 * So the attempt the claim spent is given back and the job is due immediately.
 * The safety this gives up is bounded and worth stating: a worker that
 * crash-loops *through the drain path* could hand the same job back for ever.
 * A drain is operator-initiated and a handler that fails is a `requeue` or a
 * `fail` like any other, so there is no path from a bad job to that loop —
 * only from a bad operator.
 *
 * Fenced like every other write here: a worker that has already lost the lease
 * cannot un-spend an attempt the reaper has accounted for.
 */
export async function release(
  db: PrismaClient,
  claim: Claim,
  error: string,
): Promise<FenceResult> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    UPDATE jobs
       SET status = 'queued'::"job_status",
           attempts = GREATEST(attempts - 1, 0),
           next_at = (now() AT TIME ZONE 'UTC'),
           error = ${error},
           worker_id = NULL,
           lease_until = NULL,
           updated_at = (now() AT TIME ZONE 'UTC')
     WHERE id = ${claim.id}
       AND worker_id = ${claim.workerId}
       AND attempts = ${claim.attempts}
       AND status = 'running'::"job_status"
    RETURNING id
  `;
  return rows.length === 1 ? LANDED : FENCED;
}

/**
 * Put a failed job back on the queue, because someone decided it should run
 * again: a rep's Try again (orchestrator amendment A1, item 6).
 *
 * The same row, not a new one. The idempotency key names the work, and the
 * work has not changed, so a second job under a second key would be the thing
 * `enqueue`'s comment warns about: re-running failed work quietly becoming new
 * work. The input is left exactly as it was, and so is `error`, for the reason
 * `requeue` keeps it: the next attempt can read what went wrong. Everything
 * else the queue needs to know is already the queue's own:
 *
 *   * `attempts` is untouched. It is the fencing token and it only ever goes
 *     up, so the next claim is attempt `attempts + 1`, and no write from an
 *     earlier attempt can match it;
 *   * `max_attempts` is raised just enough that the next claim is inside it.
 *     A job that failed terminally on its first attempt still has the rest of
 *     its allowance and keeps it; one that spent every attempt gets one more.
 *     A rep pressing Try again once asks for one more try, not three.
 *
 * Only from `failed`, in one statement, so it is its own guard: a second call
 * finds the row `queued` and changes nothing, and says so by returning null.
 * `db` is a `TransactionClient` for the reason `enqueue`'s is: the rep's Event
 * and the job going back on the queue commit together.
 */
export async function reopenFailed(
  db: Prisma.TransactionClient,
  where: { orgId: string; jobId: string },
): Promise<Job | null> {
  const rows = await db.$queryRaw<JobRow[]>`
    UPDATE jobs
       SET status = 'queued'::"job_status",
           max_attempts = GREATEST(max_attempts, attempts + 1),
           next_at = (now() AT TIME ZONE 'UTC'),
           updated_at = (now() AT TIME ZONE 'UTC')
     WHERE id = ${where.jobId}
       AND org_id = ${where.orgId}
       AND status = 'failed'::"job_status"
    RETURNING *
  `;
  const row = rows[0];
  return row === undefined ? null : toJob(row);
}

export type ReapResult = { requeued: string[]; failed: string[] };

/**
 * Take back every job whose lease has expired. The worker calls this on each
 * poll, before it claims.
 *
 * A job whose worker died stays `running` for ever otherwise: `claimNext` only
 * looks at `queued`, so the work is silently lost with nothing to show for it.
 * One statement, like the claim, so two reapers cannot double-reap — the second
 * blocks on the row lock, re-reads `status = 'running'` after taking it, and
 * matches nothing.
 */
export async function reapExpired(db: PrismaClient): Promise<ReapResult> {
  const rows = await db.$queryRaw<Array<{ id: string; status: JobStatus }>>`
    UPDATE jobs
       SET status = CASE
                      WHEN attempts < max_attempts THEN 'queued'::"job_status"
                      ELSE 'failed'::"job_status"
                    END,
           next_at = (now() AT TIME ZONE 'UTC'),
           error = ${LEASE_EXPIRED_ERROR},
           worker_id = NULL,
           lease_until = NULL,
           updated_at = (now() AT TIME ZONE 'UTC')
     WHERE status = 'running'::"job_status"
       AND lease_until <= (now() AT TIME ZONE 'UTC')
    RETURNING id, status
  `;
  return {
    requeued: rows.filter((row) => row.status === "queued").map((row) => row.id),
    failed: rows.filter((row) => row.status === "failed").map((row) => row.id),
  };
}
