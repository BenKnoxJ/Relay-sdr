import type { CampaignPerson, CreditKind, CreditLedgerEntry, Event, Job, Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";

import { leadGenHandoffSchema, type LeadGenHandoff } from "../../../agents/leadgen/input.schema";
import type { Person as FoundPerson } from "../../../agents/leadgen/output.schema";
import { batchOfInput } from "@/lib/campaigns/batches";
import type { FindPeopleResult } from "@/lib/leadgen/findPeople";
import { Knowledge, type KnownPerson, type OrgKnowledge } from "@/lib/leadgen/holds";
import { planReveal, revealTally, type RevealCandidate, type RevealCounts, type RevealOutcome, type RevealPlan } from "@/lib/leadgen/reveal";
import { held, pricingById, type SearchPricing, type SpendEntry, type SpendPort } from "@/lib/leadgen/spend";

import { mutate } from "./mutate";
import { isUniqueViolation } from "./sideEffects";

/**
 * Lead gen's persistence (lead gen v2.1 §3, §6, §9, §11): the confirmed
 * handoff and its job, what a run already knows about the org, the credit
 * ledger, and a run's result.
 *
 * **Every read is scoped by `orgId`**, and nothing here takes an org from
 * anywhere but its caller (the session, or the job row). The core assumes it
 * is handed one org's records; this is where that becomes true.
 */

export const CAMPAIGN_CONFIRMED = "campaign.confirmed" as const;
export const LEADGEN_PICKED = "leadgen.picked" as const;
export const LEADGEN_HALTED = "leadgen.halted" as const;
export const LEADGEN_RERUN = "leadgen.rerun" as const;
/** Find more people (P5b): the next batch asked for, and its credit approval when it needed a new one. */
export const CAMPAIGN_MORE_PEOPLE = "campaign.more_people" as const;

/** The job kind lead gen runs as. */
export const LEAD_GEN_JOB = "lead_gen" as const;

/** One version's lead gen job key: the first run, then each Try again or chosen industry. */
export function leadGenJobKey(campaignId: string, briefVersion: number, run: number): string {
  const base = `campaign:${campaignId}:lead_gen:v${briefVersion}`;
  return run === 1 ? base : `${base}:run${run}`;
}

/** The guard that makes a job's result one Event across retries. */
export function leadGenGuardKey(jobId: string): string {
  return `lead_gen:${jobId}`;
}

/** What a lead gen job is given: which Confirm to read, which run this is, and any industry the rep chose. */
export const leadGenJobInputSchema = z
  .object({
    confirmRequestId: z.string().min(1).max(200),
    run: z.number().int().positive(),
    /** Normalised Research term to the plain-words label the rep chose (v2.1 §5). */
    industryChoices: z.record(z.string().min(1).max(200)).optional(),
    /** Which batch this run finds (P5b). Absent: batch 1, the search Confirm started. */
    batch: z.number().int().min(2).max(1000).optional(),
    /** How many people this batch asks for, in place of the handoff's (P5b). */
    howMany: z.union([z.literal(10), z.literal(20), z.literal(30)]).optional(),
    /** The Find more people press whose new credit cap this run spends against (P5b). Absent: the Confirm's. */
    capRequestId: z.string().min(1).max(200).optional(),
  })
  .strict();
export type LeadGenJobInput = z.infer<typeof leadGenJobInputSchema>;

/** The batch a lead gen job finds: 1 unless Find more people asked for a later one. */
export function batchOf(job: Pick<Job, "input">): number {
  return batchOfInput(job.input);
}

type Db = PrismaClient | Prisma.TransactionClient;
type Scope = { orgId: string; campaignId: string; briefVersion: number };

/** The `campaign.confirmed` Event for one version of one campaign, or null. */
export async function findConfirmEvent(db: Db, where: Scope): Promise<Event | null> {
  return db.event.findFirst({
    where: { orgId: where.orgId, campaignId: where.campaignId, kind: CAMPAIGN_CONFIRMED, after: { path: ["briefVersion"], equals: where.briefVersion } },
    orderBy: [{ at: "asc" }, { id: "asc" }],
  });
}

/** The Confirm a job names, by the request id that made it. */
export async function findConfirmByRequest(db: Db, where: { orgId: string; campaignId: string; requestId: string }): Promise<Event | null> {
  return db.event.findFirst({
    where: { orgId: where.orgId, campaignId: where.campaignId, kind: CAMPAIGN_CONFIRMED, after: { path: ["requestId"], equals: where.requestId } },
  });
}

/** The frozen handoff on a Confirm Event. A row that no longer parses is a defect worth failing on. */
export function handoffOf(confirm: Pick<Event, "after">): LeadGenHandoff {
  const after = confirm.after !== null && typeof confirm.after === "object" ? (confirm.after as { handoff?: unknown }) : {};
  return leadGenHandoffSchema.parse(after.handoff);
}

/** The latest lead gen job for one version: the newest run. */
export async function latestLeadGenJob(db: Db, where: Scope): Promise<Job | null> {
  return db.job.findFirst({
    where: { orgId: where.orgId, campaignId: where.campaignId, kind: LEAD_GEN_JOB, briefVersion: where.briefVersion },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}

/** A job's result: its People found or its halt. */
export async function findLeadGenResult(db: Db, where: { orgId: string; jobId: string }): Promise<Event | null> {
  return db.event.findFirst({
    where: { orgId: where.orgId, kind: { in: [LEADGEN_PICKED, LEADGEN_HALTED] }, after: { path: ["jobId"], equals: where.jobId } },
    orderBy: [{ at: "asc" }, { id: "asc" }],
  });
}

// ---------------------------------------------------------------------------
// What a run already knows about the org (v2.1 §9), one org's records only.

const EMAIL_TYPES = new Set<KnownPerson["emailType"]>(["work", "personal", "unknown"]);

/**
 * Kept or revealed in the org's other campaigns (Relay P1; leadgen amendment
 * 2026-09-21): lead gen does not pick them again. Live work only: each other
 * campaign at its current brief version, so a superseded version holds no one.
 * Relay has no stopped or done campaign yet; a campaign whose current version
 * has nothing kept or revealed contributes no rows.
 */
async function inOtherLiveCampaigns(db: Db, where: Scope) {
  const others = await db.campaign.findMany({ where: { orgId: where.orgId, id: { not: where.campaignId } }, select: { id: true, briefVersion: true } });
  if (others.length === 0) return [];
  return db.campaignPerson.findMany({
    where: {
      orgId: where.orgId,
      AND: [
        { OR: others.map((campaign) => ({ campaignId: campaign.id, briefVersion: campaign.briefVersion })) },
        { OR: [{ review: "kept" }, { reveal: { in: ["revealed", "known"] } }] },
      ],
    },
    select: { providerId: true, personId: true, reveal: true },
  });
}

export async function loadOrgKnowledge(db: Db, where: Scope): Promise<OrgKnowledge> {
  const [people, identities, suppressions, enrolled, elsewhere, here] = await Promise.all([
    db.person.findMany({ where: { orgId: where.orgId }, select: { id: true, email: true, emailType: true, grade: true } }),
    db.providerIdentity.findMany({ where: { orgId: where.orgId, provider: "lusha" }, select: { providerId: true, personId: true, status: true } }),
    db.contactSuppression.findMany({ where: { orgId: where.orgId }, select: { kind: true, value: true, reason: true } }),
    db.campaignPerson.findMany({
      where: { orgId: where.orgId, campaignId: where.campaignId, briefVersion: where.briefVersion, personId: { not: null } },
      select: { personId: true },
    }),
    inOtherLiveCampaigns(db, where),
    // Everyone an earlier batch of this campaign found (P5b), chosen or spare.
    db.campaignPerson.findMany({ where: { orgId: where.orgId, campaignId: where.campaignId, briefVersion: where.briefVersion }, select: { providerId: true } }),
  ]);
  return {
    people: people.map((person) => ({
      id: person.id,
      email: person.email,
      emailType: EMAIL_TYPES.has(person.emailType as KnownPerson["emailType"]) ? (person.emailType as KnownPerson["emailType"]) : "unknown",
      grade: person.grade,
    })),
    providerIdentities: identities.map((identity) => ({ provider: "lusha" as const, ...identity })),
    suppressions,
    enrolledPersonIds: enrolled.map((row) => row.personId).filter((id): id is string => id !== null),
    inOtherCampaigns: elsewhere.map((row) => ({ providerId: row.providerId, personId: row.personId, revealed: row.reveal === "revealed" || row.reveal === "known" })),
    inThisCampaign: here.map((row) => row.providerId),
  };
}

// ---------------------------------------------------------------------------
// The credit ledger (v2.1 §6).
//
// Every reservation is decided and written in one transaction holding a lock
// on the org's row, so two runs in one org queue on it: the second sees the
// first's reservation before it decides. The bound checked is the tighter of
// this Confirm's cap (everything charged or reserved against it, across every
// run and attempt) and the balance read at Confirm less everything the org
// has charged or reserved since it was read.
//
// What that guarantees, and what it does not: Relay never *knowingly*
// commits more than either bound, and an unknown outcome stays counted at its
// documented worst case. It rests on the provider never charging a request
// more than that worst case, and on the balance snapshot being true when it
// was read. Neither is verified against a live provider yet.

/** Committed spend: reconciled at what was charged, released at nothing, anything else at its worst case. */
function committed(entries: readonly Pick<CreditLedgerEntry, "state" | "charged" | "worstCase">[]): number {
  return entries.reduce((total, entry) => total + held(entry), 0);
}

export type LedgerScope = Scope & {
  /** The Event whose cap this spend counts against: the Confirm for search, the reveal confirm for reveal. */
  confirmEventId: string;
  jobId: string;
  /** The job attempt: keys are per attempt, so a retried job reserves afresh. */
  attempt: number;
  cap: number;
  balance: { remaining: number; readAt: Date };
  pricingAssumptions: string;
  /** Search (the default) or reveal. Each cap counts its own kind; the balance counts every kind. */
  kind?: CreditKind;
};

async function remainingIn(db: Db, scope: Pick<LedgerScope, "orgId" | "confirmEventId" | "cap" | "balance" | "kind">): Promise<number> {
  const kind = scope.kind ?? "search";
  const [forConfirm, sinceSnapshot] = await Promise.all([
    // The cap: only this kind's spend under this approval. A reveal never uses up the search limit, nor a search the reveal's.
    db.creditLedgerEntry.findMany({ where: { orgId: scope.orgId, confirmEventId: scope.confirmEventId, kind }, select: { state: true, charged: true, worstCase: true } }),
    // The balance: everything the org has charged or holds since it was read, whatever the kind.
    db.creditLedgerEntry.findMany({ where: { orgId: scope.orgId, createdAt: { gte: scope.balance.readAt } }, select: { state: true, charged: true, worstCase: true } }),
  ]);
  return Math.min(scope.cap - committed(forConfirm), scope.balance.remaining - committed(sinceSnapshot));
}

/** A run's spend, persisted. */
export function persistedSpend(db: PrismaClient, scope: LedgerScope): SpendPort {
  // Unique per org: the core's request key names the campaign, version, page
  // and try; the job and its attempt make a rerun and a retried job new keys.
  const keyOf = (key: string) => `${key}:job:${scope.jobId}:a${scope.attempt}`;
  return {
    canReserve: async (worstCase) => worstCase <= (await remainingIn(db, scope)),
    tryReserve: async (key, worstCase) =>
      db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM orgs WHERE id = ${scope.orgId} FOR UPDATE`;
        if (worstCase > (await remainingIn(tx, scope))) return false;
        await tx.creditLedgerEntry.create({
          data: {
            orgId: scope.orgId,
            campaignId: scope.campaignId,
            briefVersion: scope.briefVersion,
            confirmEventId: scope.confirmEventId,
            jobId: scope.jobId,
            kind: scope.kind ?? "search",
            key: keyOf(key),
            worstCase,
            state: "reserved",
          },
        });
        return true;
      }),
    reconcile: async (key, charged) => {
      if (!Number.isInteger(charged) || charged < 0) throw new Error(`${key}: a charge is a whole number of credits`);
      const updated = await db.creditLedgerEntry.updateMany({
        where: { orgId: scope.orgId, key: keyOf(key), state: "reserved" },
        data: { state: "reconciled", charged },
      });
      if (updated.count !== 1) throw new Error(`${key}: no open reservation`);
    },
    markUnknown: async (key) => {
      await db.creditLedgerEntry.updateMany({ where: { orgId: scope.orgId, key: keyOf(key), state: "reserved" }, data: { state: "unreconciled" } });
    },
    release: async (key) => {
      const updated = await db.creditLedgerEntry.updateMany({ where: { orgId: scope.orgId, key: keyOf(key), state: "reserved" }, data: { state: "released" } });
      if (updated.count !== 1) throw new Error(`${key}: no open reservation`);
    },
    summary: async () => ({
      ...(await confirmSpend(db, { orgId: scope.orgId, confirmEventId: scope.confirmEventId, kind: scope.kind ?? "search" })),
      searchCreditCap: scope.cap,
      pricingAssumptions: scope.pricingAssumptions,
    }),
    list: async (): Promise<readonly SpendEntry[]> =>
      (await db.creditLedgerEntry.findMany({ where: { orgId: scope.orgId, jobId: scope.jobId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })).map((entry) => ({
        key: entry.key,
        worstCase: entry.worstCase,
        state: entry.state,
        charged: entry.charged,
      })),
  };
}

/** An approval's spend so far, of one kind (search by default): charged, still reserved, and whether a charge ever passed its worst case. */
export async function confirmSpend(
  db: Db,
  where: { orgId: string; confirmEventId: string; kind?: CreditKind },
): Promise<{ charged: number; reserved: number; exceededDocumentedWorstCase: boolean }> {
  const entries = await db.creditLedgerEntry.findMany({ where: { orgId: where.orgId, confirmEventId: where.confirmEventId, kind: where.kind ?? "search" } });
  return {
    charged: entries.reduce((total, entry) => total + (entry.state === "reconciled" ? (entry.charged ?? 0) : 0), 0),
    // Only what may still be charged: a released request never left Relay.
    reserved: entries.reduce((total, entry) => total + (entry.state === "reserved" || entry.state === "unreconciled" ? entry.worstCase : 0), 0),
    exceededDocumentedWorstCase: entries.some((entry) => entry.state === "reconciled" && (entry.charged ?? 0) > entry.worstCase),
  };
}

/**
 * Reservations an earlier attempt of this job left open: that attempt died
 * between reserving and hearing back, so whether it was charged is unknown,
 * and each stays counted at its worst case.
 */
export async function markStaleReservations(db: PrismaClient, where: { orgId: string; jobId: string }): Promise<number> {
  const updated = await db.creditLedgerEntry.updateMany({ where: { orgId: where.orgId, jobId: where.jobId, state: "reserved" }, data: { state: "unreconciled" } });
  return updated.count;
}

// ---------------------------------------------------------------------------
// Find more people (P5b): which search approval a later batch spends against.

const snapshotSchema = z
  .object({ remaining: z.number().int().nonnegative(), used: z.number().int().nonnegative().optional(), total: z.number().int().nonnegative().optional(), readAt: z.string().min(1) })
  .strict();

/** The `campaign.more_people` Event's `after`, read defensively. */
export const morePeopleSchema = z.object({
  requestId: z.string().min(1),
  briefVersion: z.number().int().positive(),
  batch: z.number().int().min(2),
  howMany: z.union([z.literal(10), z.literal(20), z.literal(30)]),
  jobId: z.string().min(1),
  /** The press whose new cap this batch spends: this one when it approved a cap, an earlier one, or absent for the Confirm's. */
  capRequestId: z.string().min(1).optional(),
  /** Set when this press approved a new search cap: the cap and the balance read for it, as Confirm freezes them. */
  cap: z.object({ searchCreditCap: z.number().int().positive(), balanceSnapshot: snapshotSchema, balanceSource: z.enum(["sample", "live"]) }).optional(),
});
export type MorePeople = z.infer<typeof morePeopleSchema>;

/** A Find more people press, by the request id that made it. */
export async function findMorePeopleByRequest(db: Db, where: { orgId: string; campaignId: string; requestId: string }): Promise<Event | null> {
  return db.event.findFirst({ where: { orgId: where.orgId, campaignId: where.campaignId, kind: CAMPAIGN_MORE_PEOPLE, after: { path: ["requestId"], equals: where.requestId } } });
}

/** What a search spends against: the Event whose cap counts it, the cap, and the balance read with it. */
export type SearchApproval = {
  eventId: string;
  /** The Find more press that approved it; null for the Confirm. */
  capRequestId: string | null;
  cap: number;
  balanceSnapshot: { remaining: number; used?: number; total?: number; readAt: string };
};

/** The search approval a Confirm froze. */
export function confirmApproval(confirm: Event): SearchApproval {
  const { spend } = handoffOf(confirm);
  return { eventId: confirm.id, capRequestId: null, cap: spend.searchCreditCap, balanceSnapshot: spend.balanceSnapshot };
}

/** A Find more press's own approval, when it approved a new cap. */
export function moreApproval(event: Event): SearchApproval | null {
  const parsed = morePeopleSchema.safeParse(event.after);
  if (!parsed.success || parsed.data.cap === undefined) return null;
  return { eventId: event.id, capRequestId: parsed.data.requestId, cap: parsed.data.cap.searchCreditCap, balanceSnapshot: parsed.data.cap.balanceSnapshot };
}

/** The approval the next batch spends against: the newest Find more press that approved a cap at this version, else the Confirm. */
export async function currentSearchApproval(db: Db, scope: Scope, confirm: Event): Promise<SearchApproval> {
  const presses = await db.event.findMany({
    where: { orgId: scope.orgId, campaignId: scope.campaignId, kind: CAMPAIGN_MORE_PEOPLE, after: { path: ["briefVersion"], equals: scope.briefVersion } },
    orderBy: [{ at: "desc" }, { id: "desc" }],
  });
  for (const press of presses) {
    const approval = moreApproval(press);
    if (approval !== null) return approval;
  }
  return confirmApproval(confirm);
}

/** What is left of an approval's search cap: the tighter of the cap less its spend and the balance less everything spent since it was read. */
export async function searchRemaining(db: Db, orgId: string, approval: SearchApproval): Promise<number> {
  return remainingIn(db, {
    orgId,
    confirmEventId: approval.eventId,
    cap: approval.cap,
    balance: { remaining: approval.balanceSnapshot.remaining, readAt: new Date(approval.balanceSnapshot.readAt) },
    kind: "search",
  });
}

/** Search credits used at this version so far, and the people chosen for them: what a batch's estimate is scaled from. */
export async function searchHistory(db: Db, scope: Scope): Promise<{ credits: number; people: number }> {
  const [entries, people] = await Promise.all([
    db.creditLedgerEntry.findMany({ where: { orgId: scope.orgId, campaignId: scope.campaignId, briefVersion: scope.briefVersion, kind: "search" }, select: { state: true, charged: true, worstCase: true } }),
    db.campaignPerson.count({ where: { ...scope, status: "chosen" } }),
  ]);
  return { credits: committed(entries), people };
}

// ---------------------------------------------------------------------------
// A run's result.

export type RecordLeadGenResultInput = {
  orgId: string;
  job: Pick<Job, "id"> & { campaignId: string; briefVersion: number; batch?: number };
  confirmEventId: string;
  result: FindPeopleResult;
  knowledge: OrgKnowledge;
};

/**
 * The result Event and, for People found, the candidates: one transaction,
 * once per job. A retried job that already recorded its result gets that
 * Event back and writes nothing.
 */
export async function recordLeadGenResult(db: PrismaClient, input: RecordLeadGenResultInput): Promise<Event> {
  const existing = await findLeadGenResult(db, { orgId: input.orgId, jobId: input.job.id });
  if (existing !== null) return existing;

  const { output } = input.result;
  const personOf = new Map(input.knowledge.providerIdentities.map((identity) => [identity.providerId, identity.personId]));
  const row = (person: FoundPerson, status: "chosen" | "spare"): Prisma.CampaignPersonCreateManyInput => ({
    orgId: input.orgId,
    campaignId: input.job.campaignId,
    briefVersion: input.job.briefVersion,
    jobId: input.job.id,
    batch: input.job.batch ?? 1,
    provider: "lusha",
    providerId: person.lushaId,
    personId: person.source === "reused" ? (personOf.get(person.lushaId) ?? null) : null,
    status,
    source: person.source,
    rank: person.rank,
    score: person.score,
    whyPicked: person.whyPicked,
    companyKey: person.companyKey,
    // v2.2 §8a: the Research role this person plays, all three or none.
    ...(person.role === undefined ? {} : { rolePart: person.role.part, roleTitle: person.role.title, roleMatch: person.role.how }),
    // The provider's row as it came: the raw domain stays here.
    preview: {
      name: person.name,
      title: person.title,
      company: person.company,
      ...(person.domain === undefined ? {} : { domain: person.domain }),
      ...(person.companyId === undefined ? {} : { companyId: person.companyId }),
      country: person.country,
      ...(person.city === undefined ? {} : { city: person.city }),
      ...(person.linkedinUrl === undefined ? {} : { linkedinUrl: person.linkedinUrl }),
      hasEmail: person.hasEmail,
      // What revealing this email would cost, so a reveal estimate can count kept people alone (v2.2 §9a).
      ...(person.emailRevealCredits === undefined ? {} : { emailRevealCredits: person.emailRevealCredits }),
    },
  });
  const rows = output.phase === "pick" ? [...output.chosen.map((person) => row(person, "chosen")), ...output.spare.map((person) => row(person, "spare"))] : [];

  try {
    await mutate(db, {
      orgId: input.orgId,
      actor: { kind: "system" },
      kind: output.phase === "pick" ? LEADGEN_PICKED : LEADGEN_HALTED,
      campaignId: input.job.campaignId,
      after: JSON.parse(
        JSON.stringify({
          jobId: input.job.id,
          confirmEventId: input.confirmEventId,
          briefVersion: input.job.briefVersion,
          output,
          stoppedBy: input.result.stoppedBy,
          // What was actually searched, in words: labels and ranges, never provider ids.
          effective: input.result.translation === null ? null : { ...input.result.translation.effective, triggers: input.result.translation.context.triggers },
        }),
      ) as Prisma.InputJsonObject,
      apply: async (tx) => {
        await tx.sideEffect.create({ data: { orgId: input.orgId, key: leadGenGuardKey(input.job.id), jobId: input.job.id } });
        if (rows.length > 0) await tx.campaignPerson.createMany({ data: rows });
      },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Another attempt recorded it first; its Event is the result.
  }
  const written = await findLeadGenResult(db, { orgId: input.orgId, jobId: input.job.id });
  if (written === null) throw new Error(`lead gen: the result Event for job ${input.job.id} was not found after writing it`);
  return written;
}

// ---------------------------------------------------------------------------
// Reveal emails (v2.1 §6, §9, §11; v2.2 §9a): the second spend gate.

export const CAMPAIGN_REVEAL_CONFIRMED = "campaign.reveal_confirmed" as const;
export const LEADGEN_REVEALED = "leadgen.revealed" as const;

/** The job kind Reveal emails runs as. */
export const REVEAL_JOB = "reveal" as const;

/** One batch's reveal job: one reveal per People found. Batch 1 keeps the key it always had. */
export function revealJobKey(campaignId: string, briefVersion: number, batch = 1): string {
  const base = `campaign:${campaignId}:reveal:v${briefVersion}`;
  return batch === 1 ? base : `${base}:b${batch}`;
}

/** The guard that makes a reveal's result one Event across retries. */
export function revealGuardKey(jobId: string): string {
  return `reveal:${jobId}`;
}

/** What a reveal job is given: which reveal confirm to read, and which search's people it covers. */
export const revealJobInputSchema = z.object({ revealRequestId: z.string().min(1).max(200), leadGenJobId: z.string().min(1).max(100) }).strict();

const countSchema = z.number().int().nonnegative();

/** The `campaign.reveal_confirmed` Event's `after`, read defensively. */
export const revealConfirmedSchema = z.object({
  requestId: z.string().min(1),
  briefVersion: z.number().int().positive(),
  leadGenJobId: z.string().min(1),
  /** The kept people it covers, by campaign row id. */
  people: z.array(z.string().min(1)).min(1).max(50),
  counts: z.object({ kept: countSchema, known: countSchema, toReveal: countSchema, free: countSchema, maxCredits: countSchema, noEmail: countSchema, unavailable: countSchema }),
  maxCredits: countSchema,
  pricingAssumptions: z.string().min(1),
  balanceSnapshot: z.object({ remaining: z.number(), readAt: z.string().min(1) }).passthrough(),
  balanceSource: z.enum(["sample", "live"]),
  jobId: z.string().min(1),
});
export type RevealConfirmed = z.infer<typeof revealConfirmedSchema>;

/** The reveal confirm for one search's People found, or null. */
export async function findRevealConfirm(db: Db, where: { orgId: string; campaignId: string; leadGenJobId: string }): Promise<Event | null> {
  return db.event.findFirst({
    where: { orgId: where.orgId, campaignId: where.campaignId, kind: CAMPAIGN_REVEAL_CONFIRMED, after: { path: ["leadGenJobId"], equals: where.leadGenJobId } },
    orderBy: [{ at: "asc" }, { id: "asc" }],
  });
}

/** The reveal confirm a job names, by the request id that made it. */
export async function findRevealConfirmByRequest(db: Db, where: { orgId: string; campaignId: string; requestId: string }): Promise<Event | null> {
  return db.event.findFirst({
    where: { orgId: where.orgId, campaignId: where.campaignId, kind: CAMPAIGN_REVEAL_CONFIRMED, after: { path: ["requestId"], equals: where.requestId } },
  });
}

/** A reveal job's result Event. */
export async function findRevealResult(db: Db, where: { orgId: string; jobId: string }): Promise<Event | null> {
  return db.event.findFirst({ where: { orgId: where.orgId, kind: LEADGEN_REVEALED, after: { path: ["jobId"], equals: where.jobId } }, orderBy: [{ at: "asc" }, { id: "asc" }] });
}

/** A stored candidate as reveal reads it: its preview and nothing else. */
export function revealCandidateOf(row: Pick<CampaignPerson, "id" | "providerId" | "personId" | "preview">): RevealCandidate {
  const preview = row.preview !== null && typeof row.preview === "object" ? (row.preview as Record<string, unknown>) : {};
  const text = (key: string) => (typeof preview[key] === "string" ? (preview[key] as string) : "");
  const credits = preview.emailRevealCredits;
  return {
    id: row.id,
    providerId: row.providerId,
    personId: row.personId,
    name: text("name"),
    company: text("company"),
    ...(text("domain") === "" ? {} : { domain: text("domain") }),
    hasEmail: preview.hasEmail === true,
    emailRevealCredits: typeof credits === "number" && Number.isInteger(credits) && credits >= 0 ? credits : null,
  };
}

/** The kept people of one search's People found, in rank order: the only people Reveal emails ever takes. */
export async function keptPeople(db: Db, where: Scope & { jobId: string }): Promise<CampaignPerson[]> {
  return db.campaignPerson.findMany({ where: { ...where, status: "chosen", review: "kept" }, orderBy: [{ rank: "asc" }, { id: "asc" }] });
}

/** What Reveal emails would do for the kept people, from what the org already knows. No provider or CRM call. */
export async function revealPlanFor(db: Db, where: Scope & { jobId: string }, pricing: Pick<SearchPricing, "revealPerEmail">): Promise<{ kept: CampaignPerson[]; plan: RevealPlan }> {
  const [kept, knowledge] = await Promise.all([keptPeople(db, where), loadOrgKnowledge(db, where)]);
  return { kept, plan: planReveal(kept.map(revealCandidateOf), new Knowledge(knowledge), pricing) };
}

export type RecordRevealInput = {
  orgId: string;
  job: Pick<Job, "id"> & { campaignId: string; briefVersion: number };
  revealConfirmEventId: string;
  leadGenJobId: string;
  outcomes: readonly RevealOutcome[];
  spend: { charged: number; reserved: number };
  at: Date;
};

/**
 * A reveal's result, once per job, in one transaction: each kept person's
 * outcome on their campaign row, the Persons and provider records it
 * resolved, any opt-out the CRM reported, and the `leadgen.revealed` Event
 * with the counts. No email is written to the Event. A retried job that
 * already recorded its result gets that Event back and writes nothing.
 */
export async function recordReveal(db: PrismaClient, input: RecordRevealInput): Promise<Event> {
  const existing = await findRevealResult(db, { orgId: input.orgId, jobId: input.job.id });
  if (existing !== null) return existing;
  const tally = revealTally(input.outcomes);
  try {
    await mutate(db, {
      orgId: input.orgId,
      actor: { kind: "system" },
      kind: LEADGEN_REVEALED,
      campaignId: input.job.campaignId,
      after: {
        jobId: input.job.id,
        revealConfirmEventId: input.revealConfirmEventId,
        leadGenJobId: input.leadGenJobId,
        briefVersion: input.job.briefVersion,
        tally,
        spend: input.spend,
      },
      apply: async (tx) => {
        await tx.sideEffect.create({ data: { orgId: input.orgId, key: revealGuardKey(input.job.id), jobId: input.job.id } });
        const personByEmail = new Map<string, string>();
        for (const outcome of input.outcomes) {
          let personId: string | null = null;
          if (outcome.person !== null) {
            if (outcome.person.existing) {
              personId = outcome.person.personId;
            } else {
              const email = outcome.person.email.toLowerCase();
              personId =
                personByEmail.get(email) ??
                (
                  await tx.person.upsert({
                    where: { orgId_email: { orgId: input.orgId, email } },
                    create: { orgId: input.orgId, email, emailType: outcome.person.emailType, grade: outcome.person.grade, name: outcome.name },
                    update: {},
                    select: { id: true },
                  })
                ).id;
              personByEmail.set(email, personId);
            }
          }
          if (outcome.identity !== null) {
            const linked = outcome.identity.toPerson ? personId : null;
            await tx.providerIdentity.upsert({
              where: { orgId_provider_providerId: { orgId: input.orgId, provider: "lusha", providerId: outcome.providerId } },
              create: { orgId: input.orgId, provider: "lusha", providerId: outcome.providerId, status: outcome.identity.status, personId: linked },
              update: { status: outcome.identity.status, personId: linked },
            });
          }
          if (outcome.suppress !== null) {
            await tx.contactSuppression.upsert({
              where: { orgId_kind_value: { orgId: input.orgId, kind: outcome.suppress.kind, value: outcome.suppress.value } },
              create: { orgId: input.orgId, kind: outcome.suppress.kind, value: outcome.suppress.value, reason: outcome.suppress.reason, source: "zoho" },
              update: {},
            });
          }
          const updated = await tx.campaignPerson.updateMany({
            // Only this search's kept people, and only once.
            where: {
              id: outcome.id,
              orgId: input.orgId,
              campaignId: input.job.campaignId,
              briefVersion: input.job.briefVersion,
              jobId: input.leadGenJobId,
              status: "chosen",
              review: "kept",
              reveal: null,
            },
            data: {
              reveal: outcome.reveal,
              revealHold: outcome.hold,
              revealedAt: input.at,
              ...(outcome.enrol && personId !== null ? { personId } : {}),
              ...(outcome.reveal === "known" ? { source: "reused" as const } : {}),
            },
          });
          if (updated.count !== 1) throw new Error(`reveal: campaign person ${outcome.id} is not a kept person awaiting reveal`);
        }
      },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Another attempt recorded it first; its Event is the result.
  }
  const written = await findRevealResult(db, { orgId: input.orgId, jobId: input.job.id });
  if (written === null) throw new Error(`reveal: the result Event for job ${input.job.id} was not found after writing it`);
  return written;
}

// ---------------------------------------------------------------------------
// What the campaign screen reads.

/** A candidate with its Person's email, when it has one: only a revealed or known person's is ever shown. */
export type StoredCandidate = CampaignPerson & { person?: { email: string } | null };

export type RevealRecord = {
  confirm: Event;
  after: RevealConfirmed | null;
  job: Job | null;
  result: Event | null;
  spend: { charged: number; reserved: number; exceededDocumentedWorstCase: boolean };
};

export type LeadGenRecord = {
  confirm: Event | null;
  job: Job | null;
  result: Event | null;
  people: StoredCandidate[];
  spend: { charged: number; reserved: number; exceededDocumentedWorstCase: boolean } | null;
  /** The search cap `spend` counts against: the Confirm's, or the new one a later batch was approved with (P5b). */
  searchCap?: number | null;
  /** Every new search cap later batches approved at this version, added up (P5b). */
  raisedCaps?: number;
  /** Once Reveal emails is pressed for this People found. */
  reveal?: RevealRecord | null;
  /** Before it is pressed: what it would do for the kept people. */
  revealPlan?: RevealCounts | null;
  /** Once Write emails is pressed (outreach v2.1): each person's latest first-email draft state, or `writing`. */
  outreach?: OutreachRecord | null;
};

export const NO_LEAD_GEN: LeadGenRecord = { confirm: null, job: null, result: null, people: [], spend: null, reveal: null, revealPlan: null };

export async function leadGenRecordFor(db: Db, campaign: { id: string; orgId: string; briefVersion: number }): Promise<LeadGenRecord> {
  const scope = { orgId: campaign.orgId, campaignId: campaign.id, briefVersion: campaign.briefVersion };
  const confirm = await findConfirmEvent(db, scope);
  if (confirm === null) return NO_LEAD_GEN;
  const job = await latestLeadGenJob(db, scope);
  const result = job === null ? null : await findLeadGenResult(db, { orgId: campaign.orgId, jobId: job.id });
  const found = job !== null && result?.kind === LEADGEN_PICKED;
  const people = found
    ? await db.campaignPerson.findMany({ where: { ...scope, jobId: job.id }, orderBy: [{ status: "asc" }, { rank: "asc" }], include: { person: { select: { email: true } } } })
    : [];
  // The approval the latest search spent against: a later batch may have been approved with a new cap (P5b).
  const capRequestId = job === null ? undefined : leadGenJobInputSchema.safeParse(job.input).data?.capRequestId;
  const press = capRequestId === undefined ? null : await findMorePeopleByRequest(db, { orgId: campaign.orgId, campaignId: campaign.id, requestId: capRequestId });
  const approval = (press === null ? null : moreApproval(press)) ?? null;
  const spend = await confirmSpend(db, { orgId: campaign.orgId, confirmEventId: approval?.eventId ?? confirm.id });
  const searchCap = approval?.cap ?? null;
  const presses = await db.event.findMany({ where: { orgId: campaign.orgId, campaignId: campaign.id, kind: CAMPAIGN_MORE_PEOPLE, after: { path: ["briefVersion"], equals: campaign.briefVersion } } });
  const raisedCaps = presses.reduce((total, event) => total + (moreApproval(event)?.cap ?? 0), 0);
  if (!found) return { confirm, job, result, people, spend, searchCap, raisedCaps, reveal: null, revealPlan: null };

  const revealConfirm = await findRevealConfirm(db, { orgId: campaign.orgId, campaignId: campaign.id, leadGenJobId: job.id });
  if (revealConfirm === null) {
    let pricing: Pick<SearchPricing, "revealPerEmail"> | null = null;
    try {
      pricing = pricingById(handoffOf(confirm).spend.pricingAssumptions);
    } catch {
      pricing = null;
    }
    const plan = pricing === null ? null : (await revealPlanFor(db, { ...scope, jobId: job.id }, pricing)).plan.counts;
    return { confirm, job, result, people, spend, searchCap, raisedCaps, reveal: null, revealPlan: plan };
  }
  const parsed = revealConfirmedSchema.safeParse(revealConfirm.after);
  const revealJob = parsed.success ? await db.job.findFirst({ where: { orgId: campaign.orgId, id: parsed.data.jobId, kind: REVEAL_JOB } }) : null;
  const revealResult = revealJob === null ? null : await findRevealResult(db, { orgId: campaign.orgId, jobId: revealJob.id });
  return {
    confirm,
    job,
    result,
    people,
    spend,
    searchCap,
    raisedCaps,
    reveal: {
      confirm: revealConfirm,
      after: parsed.success ? parsed.data : null,
      job: revealJob,
      result: revealResult,
      spend: await confirmSpend(db, { orgId: campaign.orgId, confirmEventId: revealConfirm.id, kind: "reveal" }),
    },
    revealPlan: null,
    outreach: revealResult === null ? null : await outreachFor(db, scope, job.id),
  };
}

/** Write emails for one batch: whether it was pressed, each person's latest draft state (or `writing`), and the counts the stage reads. */
export type OutreachRecord = { requested: boolean; byPerson: Record<string, string>; jobs: { queued: number; running: number } };

/**
 * Whether Write emails was pressed for one search's people (P5b: once per
 * batch, so per lead gen job). Every `outreach.requested` Event names the
 * search it drafted for.
 */
export async function findOutreachRequested(db: Db, where: { orgId: string; campaignId: string; leadGenJobId: string }): Promise<Event | null> {
  return db.event.findFirst({ where: { orgId: where.orgId, campaignId: where.campaignId, kind: "outreach.requested", after: { path: ["leadGenJobId"], equals: where.leadGenJobId } } });
}

/** Write emails, for one search's people: whether it was pressed, and each person's latest draft state (or `writing`). */
async function outreachFor(db: Db, scope: Scope, leadGenJobId: string): Promise<OutreachRecord> {
  const requested = await findOutreachRequested(db, { orgId: scope.orgId, campaignId: scope.campaignId, leadGenJobId });
  if (requested === null) return { requested: false, byPerson: {}, jobs: { queued: 0, running: 0 } };
  const byPerson: Record<string, string> = {};
  // This batch's people only: an earlier batch's drafts are its own (P5b).
  const mine = new Set((await db.campaignPerson.findMany({ where: { ...scope, jobId: leadGenJobId }, select: { id: true } })).map((row) => row.id));
  // Each person's latest attempt, then anyone whose next draft is still being written.
  // A person's first email is where their outreach is: the rest of the sequence follows it (P2).
  const drafts = await db.outreachDraft.findMany({
    where: { ...scope, touch: "email1", campaignPerson: { jobId: leadGenJobId } },
    orderBy: [{ attempt: "asc" }, { createdAt: "asc" }],
    select: { campaignPersonId: true, state: true, jobId: true },
  });
  for (const draft of drafts) byPerson[draft.campaignPersonId] = draft.state;
  const drafted = new Set(drafts.map((draft) => draft.jobId));
  const all = await db.job.findMany({ where: { ...scope, kind: "outreach_draft", status: { in: ["queued", "running", "failed"] } }, select: { id: true, input: true, status: true } });
  // A job writing a later touch again leaves the person's first email where it is.
  const personOf = (job: { input: unknown }) => {
    const value = job.input as { campaignPersonId?: unknown; touch?: unknown } | null;
    return value?.touch === undefined || value.touch === "email1" ? value?.campaignPersonId : undefined;
  };
  const jobs = all.filter((job) => {
    const id = (job.input as { campaignPersonId?: unknown } | null)?.campaignPersonId;
    return typeof id === "string" && mine.has(id);
  });
  // A job that failed without recording a draft still failed for that person: never "not asked".
  for (const job of jobs) {
    const id = personOf(job);
    if (job.status === "failed" && typeof id === "string" && !drafted.has(job.id)) byPerson[id] = "failed";
  }
  const counts = { queued: 0, running: 0 };
  for (const job of jobs) {
    if (job.status === "failed") continue;
    const id = personOf(job);
    if (typeof id === "string") byPerson[id] = "writing";
    if (job.status === "running") counts.running += 1;
    else counts.queued += 1;
  }
  return { requested: true, byPerson, jobs: counts };
}
