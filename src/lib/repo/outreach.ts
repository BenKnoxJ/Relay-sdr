import type { CampaignPerson, OutreachDraft, OutreachDraftState, Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";

import { EMAIL_TOUCHES, TOUCH_KINDS, lookupResultSchema, type LookupResult, type TouchKind } from "../../../agents/outreach/input.schema";
import { enqueue } from "@/lib/jobs/queue";

import { mutate } from "./mutate";
import { isUniqueViolation } from "./sideEffects";

/**
 * Outreach's persistence (outreach v2 §5, §9, §10, as amended by v2.1): the
 * draft job's lookup and its draft, the rep's decisions on it, and the rep's
 * voice. Every read is scoped by `orgId`, and by the owner where a rep acts.
 */

export const OUTREACH_DRAFT_JOB = "outreach_draft" as const;
export const OUTREACH_REQUESTED = "outreach.requested" as const;
export const OUTREACH_LOOKUP = "outreach.lookup" as const;
export const OUTREACH_DRAFTED = "outreach.drafted" as const;
export const DRAFT_APPROVED = "draft.approved" as const;
export const DRAFT_REJECTED = "draft.rejected" as const;
export const DRAFT_RETRIED = "draft.retried" as const;
export const VOICE_SAVED = "rep.voice_saved" as const;

/** A person's touch is written at most three times: the first, and two the rep asks for with a reason. */
export const MAX_DRAFT_ATTEMPTS = 3;
export { PERSON_DRAFT_COST_CAP_USD } from "@/lib/outreach/cost";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * One job per person per touch per attempt. The first press drafts the whole
 * sequence under `sequence`; a rep's redraft of one touch is keyed by that touch.
 */
export function draftJobKey(campaignId: string, briefVersion: number, campaignPersonId: string, attempt: number, touch: TouchKind | "sequence"): string {
  return `campaign:${campaignId}:outreach:v${briefVersion}:cp:${campaignPersonId}:${touch}:a${attempt}`;
}

/** The guard that makes a job's draft one row across retries. */
export function draftGuardKey(jobId: string): string {
  return `outreach_draft:${jobId}`;
}

export const REDRAFT_REASONS = ["wrong_angle", "wrong_fact"] as const;

export const draftJobInputSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    campaignPersonId: z.string().min(1).max(100),
    attempt: z.number().int().min(1).max(MAX_DRAFT_ATTEMPTS),
    /** One touch to write again. Absent on the first press: the job drafts the whole sequence. */
    touch: z.enum(TOUCH_KINDS).optional(),
    /** A rep's rejection that asks for another draft (§9): what to move away from. */
    avoid: z
      .object({ reason: z.enum(REDRAFT_REASONS), previousBody: z.string().max(5000), previousOpenerRef: z.string().max(80).optional() })
      .strict()
      .optional(),
  })
  .strict();
export type DraftJobInput = z.infer<typeof draftJobInputSchema>;

/** Kept people whose email is usable: revealed now, or already known. The only people Write emails covers. */
export async function draftablePeople(db: Db, where: { orgId: string; campaignId: string; briefVersion: number; jobId: string }) {
  return db.campaignPerson.findMany({
    where: { ...where, status: "chosen", review: "kept", reveal: { in: ["revealed", "known"] }, personId: { not: null } },
    include: { person: { select: { email: true } } },
    orderBy: [{ rank: "asc" }, { id: "asc" }],
  });
}

export async function findDraftForJob(db: Db, where: { orgId: string; jobId: string }): Promise<OutreachDraft | null> {
  return db.outreachDraft.findFirst({ where: { orgId: where.orgId, jobId: where.jobId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
}

/** Every draft a job wrote: one for a single touch, seven for a sequence. */
export async function findDraftsForJob(db: Db, where: { orgId: string; jobId: string }): Promise<OutreachDraft[]> {
  return db.outreachDraft.findMany({ where: { orgId: where.orgId, jobId: where.jobId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
}

// ---------------------------------------------------------------------------
// The lookup, recorded once per job so a retry does not search again (§4).

export async function findLookup(db: Db, where: { orgId: string; jobId: string }): Promise<LookupResult | null> {
  const event = await db.event.findFirst({ where: { orgId: where.orgId, kind: OUTREACH_LOOKUP, after: { path: ["jobId"], equals: where.jobId } }, orderBy: [{ at: "asc" }, { id: "asc" }] });
  if (event === null) return null;
  const parsed = lookupResultSchema.safeParse((event.after as { lookup?: unknown } | null)?.lookup);
  return parsed.success ? parsed.data : null;
}

export async function recordLookup(
  db: PrismaClient,
  input: { orgId: string; campaignId: string; jobId: string; lookup: LookupResult; trail: { kind: string; target: string; outcome: string }[] },
): Promise<void> {
  await mutate(db, {
    orgId: input.orgId,
    actor: { kind: "system" },
    kind: OUTREACH_LOOKUP,
    campaignId: input.campaignId,
    after: JSON.parse(JSON.stringify({ jobId: input.jobId, lookup: input.lookup, trail: input.trail })) as Prisma.InputJsonObject,
    apply: async () => null,
  });
}

// ---------------------------------------------------------------------------
// The cohort the repetition gates read (v2.1 §6).

export type CohortEntry = {
  body: string;
  ask: string;
  subject?: string;
  sameAccount: boolean;
  opening: string;
  /** Which touch it is: the cohort is every touch now, not only Email 1 (M2). */
  touch: string;
  /** The item this touch opened on, by id, so a colleague's draft can take a different angle. */
  openerRef?: string;
};

export async function cohortFor(
  db: Db,
  where: { orgId: string; campaignId: string; briefVersion: number; excludeCampaignPersonId: string; companyKey: string },
): Promise<CohortEntry[]> {
  const drafts = await db.outreachDraft.findMany({
    where: {
      orgId: where.orgId,
      campaignId: where.campaignId,
      briefVersion: where.briefVersion,
      campaignPersonId: { not: where.excludeCampaignPersonId },
      // M2 (23 Sep 2026): every touch, not Email 1 alone.
      //
      // The 22 Sep cohort put the same product sentence in two colleagues'
      // Email 2s and the same FCA give and offer in their LinkedIn touches,
      // because the only thing a draft was ever read against was other
      // people's *first* emails. What a colleague at the same firm has
      // already been sent is the whole point of this read, and most of it is
      // not Email 1.
      state: { in: ["to_review", "needs_you", "approved"] },
      body: { not: null },
    },
    include: { campaignPerson: { select: { companyKey: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 60,
  });
  return drafts.map((draft) => {
    const body = draft.editedBody ?? draft.body ?? "";
    const ref = (draft.opener as { ref?: unknown } | null)?.ref;
    return {
      body,
      ask: draft.ask ?? "",
      ...(draft.subject === null ? {} : { subject: draft.subject }),
      sameAccount: draft.campaignPerson.companyKey === where.companyKey,
      opening: (body.split(/(?<=[.?!])\s+/)[0] ?? "").slice(0, 600),
      touch: draft.touch,
      ...(typeof ref === "string" && ref !== "" ? { openerRef: ref } : {}),
    };
  });
}

/** Everything drafting has cost this person at this brief version, across every touch and attempt, for the §11 ceiling. */
export async function personDraftCost(db: Db, where: { orgId: string; campaignId: string; briefVersion: number; campaignPersonId: string }): Promise<number> {
  const total = await db.outreachDraft.aggregate({ where, _sum: { costUsd: true } });
  return Number(total._sum.costUsd ?? 0);
}

// ---------------------------------------------------------------------------
// The draft, once per job.

export type Finding = { rule: string; text: string };

/** One touch's draft, as a job records it. */
export type TouchRecord = {
  touch: TouchKind;
  state: Extract<OutreachDraftState, "to_review" | "needs_you" | "failed">;
  /** The opener carries the words, source and date the card shows, resolved when the draft is written. */
  draft: { subject?: string; body: string; ask: string; opener: { ref: string; kind: string; text: string; source: string; date: string }; claims: string[] } | null;
  findings: Finding[];
  advice: Finding[];
  generations: number;
  costUsd: number;
};

export type RecordDraftsInput = {
  orgId: string;
  job: { id: string; campaignId: string; briefVersion: number; ownerUserId: string };
  campaignPersonId: string;
  attempt: number;
  lookup: LookupResult & { trail?: unknown };
  touches: TouchRecord[];
  /** More for the Event: the cost split and what the humanizer changed. Never on the rep's card. */
  record?: Record<string, unknown>;
};

export type RecordDraftInput = Omit<RecordDraftsInput, "touches" | "record"> & Omit<TouchRecord, "touch"> & { touch?: TouchKind };

/** One touch's draft and its Event (`recordDrafts` with one touch). */
export async function recordDraft(db: PrismaClient, input: RecordDraftInput): Promise<OutreachDraft> {
  const { touch = "email1", state, draft, findings, advice, generations, costUsd, ...rest } = input;
  const [written] = await recordDrafts(db, { ...rest, touches: [{ touch, state, draft, findings, advice, generations, costUsd }] });
  return written!;
}

/**
 * A job's drafts and their one Event, in one transaction, once per job: every
 * touch lands or none does. A retried job that already wrote its drafts gets
 * them back and writes nothing.
 */
export async function recordDrafts(db: PrismaClient, input: RecordDraftsInput): Promise<OutreachDraft[]> {
  const existing = await findDraftsForJob(db, { orgId: input.orgId, jobId: input.job.id });
  if (existing.length > 0) return existing;
  const first = input.touches[0];
  if (first === undefined) throw new Error("outreach: a job records at least one draft");
  try {
    await mutate(db, {
      orgId: input.orgId,
      actor: { kind: "system" },
      kind: OUTREACH_DRAFTED,
      campaignId: input.job.campaignId,
      after: JSON.parse(
        JSON.stringify({
          jobId: input.job.id,
          campaignPersonId: input.campaignPersonId,
          attempt: input.attempt,
          // The first touch's, as the activity line reads it; each touch's own below.
          state: first.state,
          generations: first.generations,
          findings: first.findings.map((finding) => finding.rule),
          touches: input.touches.map((touch) => ({ touch: touch.touch, state: touch.state, generations: touch.generations, findings: touch.findings.map((finding) => finding.rule) })),
          lookup: { usable: input.lookup.usable, searches: input.lookup.searches, fetches: input.lookup.fetches },
          ...input.record,
        }),
      ) as Prisma.InputJsonObject,
      apply: async (tx) => {
        await tx.sideEffect.create({ data: { orgId: input.orgId, key: draftGuardKey(input.job.id), jobId: input.job.id } });
        for (const touch of input.touches) {
          await tx.outreachDraft.create({
            data: {
              orgId: input.orgId,
              campaignId: input.job.campaignId,
              briefVersion: input.job.briefVersion,
              campaignPersonId: input.campaignPersonId,
              ownerUserId: input.job.ownerUserId,
              jobId: input.job.id,
              touch: touch.touch,
              attempt: input.attempt,
              state: touch.state,
              // A subject belongs to an email; LinkedIn and call drafts never carry one (P5).
              subject: (EMAIL_TOUCHES as readonly string[]).includes(touch.touch) ? (touch.draft?.subject ?? null) : null,
              body: touch.draft?.body ?? null,
              ask: touch.draft?.ask ?? null,
              ...(touch.draft === null ? {} : { opener: touch.draft.opener as Prisma.InputJsonObject }),
              claims: touch.draft?.claims ?? [],
              findings: touch.findings as unknown as Prisma.InputJsonArray,
              advice: touch.advice as unknown as Prisma.InputJsonArray,
              lookup: JSON.parse(JSON.stringify(input.lookup)) as Prisma.InputJsonObject,
              generations: touch.generations,
              costUsd: touch.costUsd.toFixed(6),
            },
          });
        }
        return null;
      },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Another attempt wrote them first; its drafts are the answer.
  }
  const written = await findDraftsForJob(db, { orgId: input.orgId, jobId: input.job.id });
  if (written.length === 0) throw new Error(`outreach: the drafts for job ${input.job.id} were not found after writing them`);
  return written;
}

// ---------------------------------------------------------------------------
// The rep's queue and decisions (§9, §10).

export type QueuedDraft = OutreachDraft & {
  campaign: { id: string; name: string };
  campaignPerson: Pick<CampaignPerson, "preview" | "rolePart" | "roleTitle" | "roleMatch" | "companyKey"> & { person: { email: string } | null };
};

const STATE_ORDER: Record<string, number> = { needs_you: 0, to_review: 1, failed: 2 };

/** What the Inbox card reads beside the draft: the campaign's name and the person's preview. */
const QUEUED_INCLUDE = {
  campaign: { select: { id: true, name: true } },
  campaignPerson: { select: { preview: true, rolePart: true, roleTitle: true, roleMatch: true, companyKey: true, person: { select: { email: true } } } },
} as const;

type AttemptRef = Pick<OutreachDraft, "id" | "campaignId" | "briefVersion" | "campaignPersonId" | "touch" | "attempt">;

/** The key of the job that writes the attempt after `draft`: the one a reject asking for another uses. */
export const nextAttemptKey = (draft: AttemptRef): string => draftJobKey(draft.campaignId, draft.briefVersion, draft.campaignPersonId, draft.attempt + 1, draft.touch as TouchKind);

/** Next attempts queued or being written, by `nextAttemptKey`. */
export async function redraftsInFlight(db: Db, orgId: string, drafts: readonly AttemptRef[]): Promise<Set<string>> {
  if (drafts.length === 0) return new Set();
  const jobs = await db.job.findMany({ where: { orgId, kind: OUTREACH_DRAFT_JOB, status: { in: ["queued", "running"] }, idempotencyKey: { in: drafts.map(nextAttemptKey) } }, select: { idempotencyKey: true } });
  return new Set(jobs.map((job) => job.idempotencyKey));
}

/**
 * Drafts another attempt has taken over: a later attempt is written, or is
 * on its way (Try again on a draft that failed leaves it failed, P5). Their
 * card leaves the Inbox, so one email never has two.
 */
async function supersededDrafts(db: Db, orgId: string, drafts: readonly AttemptRef[]): Promise<Set<string>> {
  if (drafts.length === 0) return new Set();
  const later = await db.outreachDraft.findMany({
    where: { orgId, campaignPersonId: { in: [...new Set(drafts.map((draft) => draft.campaignPersonId))] }, touch: { in: [...new Set(drafts.map((draft) => draft.touch))] } },
    select: { campaignPersonId: true, touch: true, attempt: true },
  });
  const latest = new Map<string, number>();
  for (const row of later) latest.set(`${row.campaignPersonId}:${row.touch}`, Math.max(latest.get(`${row.campaignPersonId}:${row.touch}`) ?? 0, row.attempt));
  const inFlight = await redraftsInFlight(db, orgId, drafts);
  return new Set(drafts.filter((draft) => (latest.get(`${draft.campaignPersonId}:${draft.touch}`) ?? 0) > draft.attempt || inFlight.has(nextAttemptKey(draft))).map((draft) => draft.id));
}

/** The rep's own drafts by id, in the Inbox's shape, whatever their state: the person's drawer draws them with the same card (P5). */
export async function draftsForCard(db: Db, owner: { orgId: string; userId: string; ids: string[] }): Promise<QueuedDraft[]> {
  if (owner.ids.length === 0) return [];
  return db.outreachDraft.findMany({ where: { orgId: owner.orgId, ownerUserId: owner.userId, id: { in: owner.ids } }, include: QUEUED_INCLUDE });
}

/**
 * The rep's own emails waiting on them: needs you first, then to review, then
 * any that could not be written. Email touches only: the Inbox approves emails,
 * and the LinkedIn and call drafts are stored for the person, not queued here.
 */
export async function reviewQueue(db: Db, owner: { orgId: string; userId: string }): Promise<QueuedDraft[]> {
  const drafts = await db.outreachDraft.findMany({
    where: { orgId: owner.orgId, ownerUserId: owner.userId, touch: { in: [...EMAIL_TOUCHES] }, state: { in: ["needs_you", "to_review", "failed"] } },
    include: QUEUED_INCLUDE,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  // A person's emails in their order: Email 1, the follow-up, the last email.
  const place = (touch: string) => (EMAIL_TOUCHES as readonly string[]).indexOf(touch);
  const replaced = await supersededDrafts(db, owner.orgId, drafts);
  return drafts.filter((draft) => !replaced.has(draft.id)).sort(
    (a, b) =>
      (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9) ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.campaignPersonId.localeCompare(b.campaignPersonId) ||
      place(a.touch) - place(b.touch) ||
      a.id.localeCompare(b.id),
  );
}

export type DraftRefusal = "not_found" | "decided" | "not_written" | "bad_edit";

export class DraftRefused extends Error {
  constructor(readonly refusal: DraftRefusal) {
    super(`draft refused: ${refusal}`);
    this.name = "DraftRefused";
  }
}

/**
 * §10's edit classes, decided without a model: a changed number or name is
 * factual; otherwise by how much of the text moved.
 */
export function editClassOf(before: string, after: string): "trim" | "reword" | "rewrite" | "factual" {
  const tokens = (text: string) => text.toLowerCase().match(/[a-z0-9£$%']+/g) ?? [];
  // A number on its own, never the digits inside a name such as a product's.
  const entities = (text: string) => new Set((text.match(/(?<![A-Za-z0-9])\d[\d,.]*(?![A-Za-z0-9])|\b[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*/g) ?? []).filter((token, index) => index > 0 || /\d/.test(token)));
  const added = [...entities(after)].filter((entity) => !entities(before).has(entity));
  if (added.some((entity) => /\d/.test(entity))) return "factual";
  const a = tokens(before);
  const b = new Set(tokens(after));
  const kept = a.filter((token) => b.has(token)).length;
  const newWords = [...b].filter((token) => !new Set(a).has(token)).length;
  if (newWords === 0 && tokens(after).length < a.length) return "trim";
  const share = a.length === 0 ? 0 : kept / a.length;
  return share >= 0.6 ? "reword" : "rewrite";
}

/**
 * The rep's own undecided draft, locked. Approving needs words to approve; a
 * touch parked at the drafting ceiling or failed, with nothing written, can
 * still be rejected, so it never sits in the Inbox or the drawer for good.
 */
async function ownDraft(tx: Prisma.TransactionClient, where: { orgId: string; userId: string; draftId: string }, action: "approve" | "reject"): Promise<OutreachDraft> {
  // Lock the row: two presses on one draft queue here, and the second sees the first's decision.
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM outreach_drafts WHERE id = ${where.draftId} AND org_id = ${where.orgId} AND owner_user_id = ${where.userId} FOR UPDATE
  `;
  if (rows.length === 0) throw new DraftRefused("not_found");
  const draft = await tx.outreachDraft.findFirstOrThrow({ where: { id: where.draftId, orgId: where.orgId, ownerUserId: where.userId } });
  if (draft.state === "approved" || draft.state === "rejected") throw new DraftRefused("decided");
  // A touch with nothing written (parked at the drafting ceiling, or failed) can still be rejected, which is
  // how Try again asks for it once more (P5): it never sits stuck.
  const unwritten = (draft.state === "needs_you" && draft.body === null) || draft.state === "failed";
  if (action === "approve" ? draft.state === "failed" || draft.body === null : !unwritten && draft.body === null) throw new DraftRefused("not_written");
  return draft;
}

/** Approve: the draft, with the rep's edit if they made one, is Ready to send. Nothing is sent here. */
export async function approveDraft(db: PrismaClient, input: { orgId: string; userId: string; draftId: string; body?: string; now?: () => Date }): Promise<OutreachDraft> {
  const at = (input.now ?? (() => new Date()))();
  const edited = input.body?.trim();
  if (edited !== undefined && (edited.length === 0 || edited.length > 5000)) throw new DraftRefused("bad_edit");
  return mutate(db, {
    orgId: input.orgId,
    actor: { kind: "user", userId: input.userId },
    kind: DRAFT_APPROVED,
    apply: async (tx) => {
      const draft = await ownDraft(tx, input, "approve");
      const changed = edited !== undefined && edited !== draft.body;
      return tx.outreachDraft.update({
        where: { id: draft.id },
        data: {
          state: "approved",
          decidedByUserId: input.userId,
          decidedAt: at,
          ...(changed ? { editedBody: edited, editClass: editClassOf(draft.body ?? "", edited) } : {}),
        },
      });
    },
    campaignId: (draft: OutreachDraft) => draft.campaignId,
    after: (draft: OutreachDraft) => ({ draftId: draft.id, campaignPersonId: draft.campaignPersonId, edited: draft.editedBody !== null, editClass: draft.editClass }),
  });
}

export const REJECT_REASONS = ["wrong_angle", "wrong_person", "wrong_fact", "not_now"] as const;
/** What a held draft set aside by Try again records in place of a reason (P5c): the action, not a why. */
export const TRY_AGAIN = "try_again" as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

/**
 * Reject with a reason (§9). "Wrong angle" and "wrong fact" ask Relay to write
 * it again, away from what was wrong, as the next attempt; the other two close
 * the draft. Each touch is written at most three times. A draft that failed
 * stays failed and can only be asked for again (Try again, P5).
 */
export async function rejectDraft(
  db: PrismaClient,
  input: { orgId: string; userId: string; draftId: string; reason: RejectReason; requestId: string; now?: () => Date },
): Promise<{ draft: OutreachDraft; redraftJobId: string | null }> {
  const at = (input.now ?? (() => new Date()))();
  return askedOnce(() =>
    mutate(db, {
      orgId: input.orgId,
      actor: { kind: "user", userId: input.userId },
      kind: DRAFT_REJECTED,
      apply: async (tx) => {
        const draft = await ownDraft(tx, input, "reject");
        const redraftReason = input.reason === "wrong_angle" || input.reason === "wrong_fact" ? input.reason : null;
        const redraft = redraftReason !== null;
        // A draft that failed has nothing written to reject, and the table keeps it failed: only asking again
        // changes anything (Try again, P5), and a repeat of that is the same queued attempt (the job key).
        if (draft.state === "failed" && (!redraft || draft.attempt >= MAX_DRAFT_ATTEMPTS)) throw new DraftRefused("not_written");
        const updated =
          draft.state === "failed" ? draft : await tx.outreachDraft.update({ where: { id: draft.id }, data: { state: "rejected", rejectReason: input.reason, decidedByUserId: input.userId, decidedAt: at } });
        let redraftJobId: string | null = null;
        if (redraftReason !== null && draft.attempt < MAX_DRAFT_ATTEMPTS) {
          const opener = draft.opener as { ref?: string } | null;
          const { job, deduped } = await enqueueNextAttempt(tx, draft, input.requestId, {
            reason: redraftReason,
            previousBody: draft.body ?? "",
            ...(typeof opener?.ref === "string" ? { previousOpenerRef: opener.ref } : {}),
          });
          // A failed draft asked for again when that attempt is already queued changed nothing: no Event (P5c).
          if (deduped && draft.state === "failed") throw new AlreadyAsked(updated, job.id);
          redraftJobId = job.id;
        }
        return { draft: updated, redraftJobId };
      },
      campaignId: (result: { draft: OutreachDraft }) => result.draft.campaignId,
      after: (result: { draft: OutreachDraft; redraftJobId: string | null }) => ({ draftId: result.draft.id, campaignPersonId: result.draft.campaignPersonId, reason: input.reason, redraftJobId: result.redraftJobId }),
    }),
  );
}

/**
 * Try again (P5, P5c) on a draft that failed or is held as Needs you: one
 * more attempt at the same touch, written afresh. Unlike a reject it gives no
 * reason and steers the next attempt nowhere, because the rep gave none. A
 * held draft steps aside so the new attempt is the one waiting: the table
 * requires a reason on a rejected row, so it records `try_again`, which is
 * what the rep did, not why. A failed one stays failed. Pressed again while
 * that attempt is queued, it changes nothing and writes no Event.
 */
export async function retryDraft(
  db: PrismaClient,
  input: { orgId: string; userId: string; draftId: string; requestId: string; now?: () => Date },
): Promise<{ draft: OutreachDraft; redraftJobId: string }> {
  const at = (input.now ?? (() => new Date()))();
  return askedOnce(() =>
    mutate(db, {
      orgId: input.orgId,
      actor: { kind: "user", userId: input.userId },
      kind: DRAFT_RETRIED,
      apply: async (tx) => {
        const draft = await ownDraft(tx, input, "reject");
        if ((draft.state !== "failed" && draft.state !== "needs_you") || draft.attempt >= MAX_DRAFT_ATTEMPTS) throw new DraftRefused("not_written");
        const updated =
          draft.state === "failed" ? draft : await tx.outreachDraft.update({ where: { id: draft.id }, data: { state: "rejected", rejectReason: TRY_AGAIN, decidedByUserId: input.userId, decidedAt: at } });
        const { job, deduped } = await enqueueNextAttempt(tx, draft, input.requestId);
        if (deduped) throw new AlreadyAsked(updated, job.id);
        return { draft: updated, redraftJobId: job.id };
      },
      campaignId: (result: { draft: OutreachDraft }) => result.draft.campaignId,
      after: (result: { draft: OutreachDraft; redraftJobId: string }) => ({ draftId: result.draft.id, campaignPersonId: result.draft.campaignPersonId, redraftJobId: result.redraftJobId }),
    }),
  ) as Promise<{ draft: OutreachDraft; redraftJobId: string }>;
}

/** The next attempt at a draft's touch, queued under the key that makes a repeat the same job. */
function enqueueNextAttempt(tx: Prisma.TransactionClient, draft: OutreachDraft, requestId: string, avoid?: DraftJobInput["avoid"]) {
  const attempt = draft.attempt + 1;
  return enqueue(tx, {
    orgId: draft.orgId,
    ownerUserId: draft.ownerUserId,
    kind: OUTREACH_DRAFT_JOB,
    idempotencyKey: draftJobKey(draft.campaignId, draft.briefVersion, draft.campaignPersonId, attempt, draft.touch as TouchKind),
    input: { requestId, campaignPersonId: draft.campaignPersonId, attempt, touch: draft.touch, ...(avoid === undefined ? {} : { avoid }) },
    campaignId: draft.campaignId,
    briefVersion: draft.briefVersion,
  });
}

/**
 * Thrown inside a transaction to roll it back, Event and all, when asking
 * again found the attempt already queued: the answer is the job already there.
 */
class AlreadyAsked extends Error {
  constructor(
    readonly draft: OutreachDraft,
    readonly jobId: string,
  ) {
    super("the next attempt is already asked for");
  }
}

async function askedOnce(work: () => Promise<{ draft: OutreachDraft; redraftJobId: string | null }>): Promise<{ draft: OutreachDraft; redraftJobId: string | null }> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AlreadyAsked) return { draft: error.draft, redraftJobId: error.jobId };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The rep's voice (master §15, v0).

/** The Settings card takes ten; the writer is given the first eight (§15 resolution 1). */
export const MAX_VOICE_SAMPLES = 10;
/** One pasted email and the day it was added, as Settings shows it. */
export const voiceSampleSchema = z.object({ text: z.string().trim().min(1).max(5000), addedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict();
const voiceSamplesSchema = z.array(voiceSampleSchema).max(MAX_VOICE_SAMPLES);

export type Voice = { samples: { text: string; addedAt: string }[]; howIWrite: string };

export async function voiceFor(db: Db, owner: { orgId: string; userId: string }): Promise<Voice> {
  const row = await db.repVoice.findFirst({ where: { orgId: owner.orgId, userId: owner.userId } });
  if (row === null) return { samples: [], howIWrite: "" };
  const samples = voiceSamplesSchema.safeParse(row.samples);
  return { samples: samples.success ? samples.data : [], howIWrite: row.howIWrite };
}

export async function saveVoice(db: PrismaClient, input: { orgId: string; userId: string; voice: Voice }): Promise<Voice> {
  const samples = voiceSamplesSchema.parse(input.voice.samples);
  const howIWrite = z.string().max(2000).parse(input.voice.howIWrite);
  await mutate(db, {
    orgId: input.orgId,
    actor: { kind: "user", userId: input.userId },
    kind: VOICE_SAVED,
    after: { samples: samples.length, noteLines: howIWrite === "" ? 0 : howIWrite.split("\n").length },
    apply: (tx) =>
      tx.repVoice.upsert({
        // Keyed on the org too, as the read is: a voice is never written under another org.
        where: { orgId_userId: { orgId: input.orgId, userId: input.userId } },
        create: { orgId: input.orgId, userId: input.userId, samples, howIWrite },
        update: { samples, howIWrite },
      }),
  });
  return { samples, howIWrite };
}
