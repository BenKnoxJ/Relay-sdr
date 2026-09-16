import type { CampaignPerson, OutreachDraft, OutreachDraftState, Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";

import { lookupResultSchema, type LookupResult } from "../../../agents/outreach/input.schema";
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
export const VOICE_SAVED = "rep.voice_saved" as const;

/** The only touch the first implementation writes (v2.1 §1). */
export const EMAIL1 = "email1" as const;
/** A person's first email is written at most three times: the first, and two the rep asks for with a reason. */
export const MAX_DRAFT_ATTEMPTS = 3;
/** §11: a per-campaign ceiling on drafting cost, in USD. */
export const CAMPAIGN_DRAFT_COST_CAP_USD = 10;

type Db = PrismaClient | Prisma.TransactionClient;

export function draftJobKey(campaignId: string, briefVersion: number, campaignPersonId: string, attempt: number): string {
  return `campaign:${campaignId}:outreach:v${briefVersion}:cp:${campaignPersonId}:${EMAIL1}:a${attempt}`;
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
  return db.outreachDraft.findFirst({ where: { orgId: where.orgId, jobId: where.jobId } });
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

export type CohortEntry = { body: string; ask: string; subject?: string; sameAccount: boolean; opening: string };

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
      state: { in: ["to_review", "needs_you", "approved"] },
      body: { not: null },
    },
    include: { campaignPerson: { select: { companyKey: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 40,
  });
  return drafts.map((draft) => {
    const body = draft.editedBody ?? draft.body ?? "";
    return {
      body,
      ask: draft.ask ?? "",
      ...(draft.subject === null ? {} : { subject: draft.subject }),
      sameAccount: draft.campaignPerson.companyKey === where.companyKey,
      opening: (body.split(/(?<=[.?!])\s+/)[0] ?? "").slice(0, 600),
    };
  });
}

/** Everything drafting has cost this campaign so far, for the §11 ceiling. */
export async function campaignDraftCost(db: Db, where: { orgId: string; campaignId: string }): Promise<number> {
  const total = await db.outreachDraft.aggregate({ where, _sum: { costUsd: true } });
  return Number(total._sum.costUsd ?? 0);
}

// ---------------------------------------------------------------------------
// The draft, once per job.

export type Finding = { rule: string; text: string };

export type RecordDraftInput = {
  orgId: string;
  job: { id: string; campaignId: string; briefVersion: number; ownerUserId: string };
  campaignPersonId: string;
  attempt: number;
  state: Extract<OutreachDraftState, "to_review" | "needs_you" | "failed">;
  /** The opener carries the words, source and date the card shows, resolved when the draft is written. */
  draft: { subject?: string; body: string; ask: string; opener: { ref: string; kind: string; text: string; source: string; date: string }; claims: string[] } | null;
  findings: Finding[];
  advice: Finding[];
  lookup: LookupResult & { trail?: unknown };
  generations: number;
  costUsd: number;
};

/**
 * The draft and its Event, one transaction, once per job. A retried job that
 * already wrote its draft gets that draft back and writes nothing.
 */
export async function recordDraft(db: PrismaClient, input: RecordDraftInput): Promise<OutreachDraft> {
  const existing = await findDraftForJob(db, { orgId: input.orgId, jobId: input.job.id });
  if (existing !== null) return existing;
  try {
    await mutate(db, {
      orgId: input.orgId,
      actor: { kind: "system" },
      kind: OUTREACH_DRAFTED,
      campaignId: input.job.campaignId,
      after: {
        jobId: input.job.id,
        campaignPersonId: input.campaignPersonId,
        attempt: input.attempt,
        state: input.state,
        generations: input.generations,
        findings: input.findings.map((finding) => finding.rule),
        lookup: { usable: input.lookup.usable, searches: input.lookup.searches, fetches: input.lookup.fetches },
      },
      apply: async (tx) => {
        await tx.sideEffect.create({ data: { orgId: input.orgId, key: draftGuardKey(input.job.id), jobId: input.job.id } });
        return tx.outreachDraft.create({
          data: {
            orgId: input.orgId,
            campaignId: input.job.campaignId,
            briefVersion: input.job.briefVersion,
            campaignPersonId: input.campaignPersonId,
            ownerUserId: input.job.ownerUserId,
            jobId: input.job.id,
            touch: EMAIL1,
            attempt: input.attempt,
            state: input.state,
            subject: input.draft?.subject ?? null,
            body: input.draft?.body ?? null,
            ask: input.draft?.ask ?? null,
            ...(input.draft === null ? {} : { opener: input.draft.opener as Prisma.InputJsonObject }),
            claims: input.draft?.claims ?? [],
            findings: input.findings as unknown as Prisma.InputJsonArray,
            advice: input.advice as unknown as Prisma.InputJsonArray,
            lookup: JSON.parse(JSON.stringify(input.lookup)) as Prisma.InputJsonObject,
            generations: input.generations,
            costUsd: input.costUsd.toFixed(6),
          },
        });
      },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Another attempt wrote it first; its draft is the answer.
  }
  const written = await findDraftForJob(db, { orgId: input.orgId, jobId: input.job.id });
  if (written === null) throw new Error(`outreach: the draft for job ${input.job.id} was not found after writing it`);
  return written;
}

// ---------------------------------------------------------------------------
// The rep's queue and decisions (§9, §10).

export type QueuedDraft = OutreachDraft & {
  campaign: { id: string; name: string };
  campaignPerson: Pick<CampaignPerson, "preview" | "rolePart" | "roleTitle" | "roleMatch" | "companyKey"> & { person: { email: string } | null };
};

const STATE_ORDER: Record<string, number> = { needs_you: 0, to_review: 1, failed: 2 };

/** The rep's own drafts waiting on them: needs you first, then to review, then any that could not be written. */
export async function reviewQueue(db: Db, owner: { orgId: string; userId: string }): Promise<QueuedDraft[]> {
  const drafts = await db.outreachDraft.findMany({
    where: { orgId: owner.orgId, ownerUserId: owner.userId, state: { in: ["needs_you", "to_review", "failed"] } },
    include: {
      campaign: { select: { id: true, name: true } },
      campaignPerson: { select: { preview: true, rolePart: true, roleTitle: true, roleMatch: true, companyKey: true, person: { select: { email: true } } } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return drafts.sort((a, b) => (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9));
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

async function ownDraft(tx: Prisma.TransactionClient, where: { orgId: string; userId: string; draftId: string }): Promise<OutreachDraft> {
  // Lock the row: two presses on one draft queue here, and the second sees the first's decision.
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM outreach_drafts WHERE id = ${where.draftId} AND org_id = ${where.orgId} AND owner_user_id = ${where.userId} FOR UPDATE
  `;
  if (rows.length === 0) throw new DraftRefused("not_found");
  const draft = await tx.outreachDraft.findFirstOrThrow({ where: { id: where.draftId, orgId: where.orgId, ownerUserId: where.userId } });
  if (draft.state === "approved" || draft.state === "rejected") throw new DraftRefused("decided");
  if (draft.state === "failed" || draft.body === null) throw new DraftRefused("not_written");
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
      const draft = await ownDraft(tx, input);
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
export type RejectReason = (typeof REJECT_REASONS)[number];

/**
 * Reject with a reason (§9). "Wrong angle" and "wrong fact" ask Relay to write
 * it again, away from what was wrong, as the next attempt; the other two close
 * the draft. A person's first email is written at most three times.
 */
export async function rejectDraft(
  db: PrismaClient,
  input: { orgId: string; userId: string; draftId: string; reason: RejectReason; requestId: string; now?: () => Date },
): Promise<{ draft: OutreachDraft; redraftJobId: string | null }> {
  const at = (input.now ?? (() => new Date()))();
  return mutate(db, {
    orgId: input.orgId,
    actor: { kind: "user", userId: input.userId },
    kind: DRAFT_REJECTED,
    apply: async (tx) => {
      const draft = await ownDraft(tx, input);
      const updated = await tx.outreachDraft.update({ where: { id: draft.id }, data: { state: "rejected", rejectReason: input.reason, decidedByUserId: input.userId, decidedAt: at } });
      let redraftJobId: string | null = null;
      if ((input.reason === "wrong_angle" || input.reason === "wrong_fact") && draft.attempt < MAX_DRAFT_ATTEMPTS) {
        const attempt = draft.attempt + 1;
        const opener = draft.opener as { ref?: string } | null;
        const { job } = await enqueue(tx, {
          orgId: draft.orgId,
          ownerUserId: draft.ownerUserId,
          kind: OUTREACH_DRAFT_JOB,
          idempotencyKey: draftJobKey(draft.campaignId, draft.briefVersion, draft.campaignPersonId, attempt),
          input: {
            requestId: input.requestId,
            campaignPersonId: draft.campaignPersonId,
            attempt,
            avoid: { reason: input.reason, previousBody: draft.body ?? "", ...(typeof opener?.ref === "string" ? { previousOpenerRef: opener.ref } : {}) },
          },
          campaignId: draft.campaignId,
          briefVersion: draft.briefVersion,
        });
        redraftJobId = job.id;
      }
      return { draft: updated, redraftJobId };
    },
    campaignId: (result: { draft: OutreachDraft }) => result.draft.campaignId,
    after: (result: { draft: OutreachDraft; redraftJobId: string | null }) => ({ draftId: result.draft.id, campaignPersonId: result.draft.campaignPersonId, reason: input.reason, redraftJobId: result.redraftJobId }),
  });
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
