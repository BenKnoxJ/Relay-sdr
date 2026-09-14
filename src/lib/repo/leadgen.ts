import type { CampaignPerson, CreditLedgerEntry, Event, Job, Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";

import { leadGenHandoffSchema, type LeadGenHandoff } from "../../../agents/leadgen/input.schema";
import type { Person as FoundPerson } from "../../../agents/leadgen/output.schema";
import type { FindPeopleResult } from "@/lib/leadgen/findPeople";
import type { KnownPerson, OrgKnowledge } from "@/lib/leadgen/holds";
import type { SpendEntry, SpendPort } from "@/lib/leadgen/spend";

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
  })
  .strict();
export type LeadGenJobInput = z.infer<typeof leadGenJobInputSchema>;

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

export async function loadOrgKnowledge(db: Db, where: Scope): Promise<OrgKnowledge> {
  const [people, identities, suppressions, enrolled] = await Promise.all([
    db.person.findMany({ where: { orgId: where.orgId }, select: { id: true, email: true, emailType: true, grade: true } }),
    db.providerIdentity.findMany({ where: { orgId: where.orgId, provider: "lusha" }, select: { providerId: true, personId: true, status: true } }),
    db.contactSuppression.findMany({ where: { orgId: where.orgId }, select: { kind: true, value: true, reason: true } }),
    db.campaignPerson.findMany({
      where: { orgId: where.orgId, campaignId: where.campaignId, briefVersion: where.briefVersion, personId: { not: null } },
      select: { personId: true },
    }),
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

/** Committed spend: reconciled at what was charged, anything else at its worst case. */
function committed(entries: readonly Pick<CreditLedgerEntry, "state" | "charged" | "worstCase">[]): number {
  return entries.reduce((total, entry) => total + (entry.state === "reconciled" ? (entry.charged ?? 0) : entry.worstCase), 0);
}

export type LedgerScope = Scope & {
  confirmEventId: string;
  jobId: string;
  /** The job attempt: keys are per attempt, so a retried job reserves afresh. */
  attempt: number;
  cap: number;
  balance: { remaining: number; readAt: Date };
  pricingAssumptions: string;
};

async function remainingIn(db: Db, scope: LedgerScope): Promise<number> {
  const [forConfirm, sinceSnapshot] = await Promise.all([
    db.creditLedgerEntry.findMany({ where: { orgId: scope.orgId, confirmEventId: scope.confirmEventId }, select: { state: true, charged: true, worstCase: true } }),
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
            kind: "search",
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
    summary: async () => ({ ...(await confirmSpend(db, { orgId: scope.orgId, confirmEventId: scope.confirmEventId })), searchCreditCap: scope.cap, pricingAssumptions: scope.pricingAssumptions }),
    list: async (): Promise<readonly SpendEntry[]> =>
      (await db.creditLedgerEntry.findMany({ where: { orgId: scope.orgId, jobId: scope.jobId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })).map((entry) => ({
        key: entry.key,
        worstCase: entry.worstCase,
        state: entry.state,
        charged: entry.charged,
      })),
  };
}

/** A Confirm's spend so far: charged, still reserved, and whether a charge ever passed its worst case. */
export async function confirmSpend(db: Db, where: { orgId: string; confirmEventId: string }): Promise<{ charged: number; reserved: number; exceededDocumentedWorstCase: boolean }> {
  const entries = await db.creditLedgerEntry.findMany({ where: { orgId: where.orgId, confirmEventId: where.confirmEventId } });
  return {
    charged: entries.reduce((total, entry) => total + (entry.state === "reconciled" ? (entry.charged ?? 0) : 0), 0),
    reserved: entries.reduce((total, entry) => total + (entry.state === "reconciled" ? 0 : entry.worstCase), 0),
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
// A run's result.

export type RecordLeadGenResultInput = {
  orgId: string;
  job: Pick<Job, "id"> & { campaignId: string; briefVersion: number };
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
// What the campaign screen reads.

export type LeadGenRecord = {
  confirm: Event | null;
  job: Job | null;
  result: Event | null;
  people: CampaignPerson[];
  spend: { charged: number; reserved: number; exceededDocumentedWorstCase: boolean } | null;
};

export const NO_LEAD_GEN: LeadGenRecord = { confirm: null, job: null, result: null, people: [], spend: null };

export async function leadGenRecordFor(db: Db, campaign: { id: string; orgId: string; briefVersion: number }): Promise<LeadGenRecord> {
  const scope = { orgId: campaign.orgId, campaignId: campaign.id, briefVersion: campaign.briefVersion };
  const confirm = await findConfirmEvent(db, scope);
  if (confirm === null) return NO_LEAD_GEN;
  const job = await latestLeadGenJob(db, scope);
  const result = job === null ? null : await findLeadGenResult(db, { orgId: campaign.orgId, jobId: job.id });
  const people =
    job !== null && result?.kind === LEADGEN_PICKED
      ? await db.campaignPerson.findMany({ where: { ...scope, jobId: job.id }, orderBy: [{ status: "asc" }, { rank: "asc" }] })
      : [];
  return { confirm, job, result, people, spend: await confirmSpend(db, { orgId: campaign.orgId, confirmEventId: confirm.id }) };
}
