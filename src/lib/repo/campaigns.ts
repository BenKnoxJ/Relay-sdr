import type { Campaign, Event, Job, Prisma, PrismaClient } from "@prisma/client";

import { researchBriefSchema } from "../../../agents/research/input.schema";
import { researchRawSchema } from "../../../agents/research/output.schema";
import { haltSchema } from "../../../agents/leadgen/output.schema";
import { nameFrom, researchJobInputSchema, sameBrief, widenedBrief, type ResearchBrief, type ResearchJobInput } from "@/lib/campaigns/brief";
import { deriveResearch, failureOf, leadGenResultOf, storedPack } from "@/lib/campaigns/derive";
import { buildLeadGenHandoff } from "@/lib/campaigns/leadgenHandoff";
import { playsOf, researchSourceOf } from "@/lib/campaigns/plays";
import { editAllowed, inFlight, leadGenRetryable, researchRetryable, revealRecovery } from "@/lib/campaigns/retry";
import { revealLedgerOf, type LedgerGroup, type ResearchCost } from "@/lib/campaigns/summary";
import { campaignsCopy } from "@/lib/copy/campaigns";
import { norm } from "@/lib/leadgen/normalise";
import type { LeadGenSetup } from "@/lib/leadgen/setup";
import { enqueue, reopenFailed } from "@/lib/jobs/queue";

import { ledgerGroupsFor, researchCostsFor } from "./campaignSummary";

import { mutate } from "./mutate";
import { RESEARCH_COMPLETED, findResearchCompletedForJob } from "./research";
import { pricingById } from "@/lib/leadgen/spend";
import {
  CAMPAIGN_CONFIRMED,
  CAMPAIGN_REVEAL_CONFIRMED,
  LEADGEN_HALTED,
  LEADGEN_PICKED,
  LEADGEN_RERUN,
  LEAD_GEN_JOB,
  REVEAL_JOB,
  findConfirmEvent,
  findLeadGenResult,
  findRevealConfirm,
  findRevealResult,
  handoffOf,
  latestLeadGenJob,
  leadGenJobInputSchema,
  leadGenJobKey,
  leadGenRecordFor,
  revealConfirmedSchema,
  revealJobKey,
  revealPlanFor,
  type LeadGenRecord,
} from "./leadgen";
import { OUTREACH_DRAFT_JOB, OUTREACH_REQUESTED, draftJobKey, draftablePeople } from "./outreach";
import { isUniqueViolation } from "./sideEffects";

/**
 * Campaigns: the one write that starts one, and the reads the screens make.
 *
 * Starting a campaign is three rows and they commit together or not at all:
 * the campaign at brief version 1, its `campaign.created` Event, and the
 * research job for that version. A campaign with no research asked for, or
 * research asked for with no campaign, is a state no screen can explain, so
 * `enqueue` runs inside `mutate`'s transaction the way `approveStubDraft` does.
 *
 * **A second press of Start is the same campaign.** The form mints a
 * `startRequestId` once, and `(org_id, start_request_id)` is unique: the
 * second insert violates it, the whole transaction rolls back (row, Event and
 * job), and the first campaign is read back and returned. The guard is the
 * index, not a read in front of it, for the reason `approvals.ts` gives: two
 * presses can both read nothing.
 *
 * No campaign state is written anywhere here. Where a campaign is, is derived
 * from its latest research job and that job's Event (`src/lib/campaigns/derive.ts`).
 */

export const CAMPAIGN_CREATED = "campaign.created" as const;

/** The job kind research runs as. */
export const RESEARCH_JOB = "research" as const;

/**
 * The research job's idempotency key: what the work is about, which is one
 * version of one campaign's brief. The version is also a column on the job;
 * nothing reads it back out of this string.
 */
export function researchJobKey(campaignId: string, briefVersion: number): string {
  return `campaign:${campaignId}:research:v${briefVersion}`;
}

export type CreateCampaignInput = {
  /** From the session. Never from request input. */
  orgId: string;
  /** From the session. The rep who pressed Start owns the campaign. */
  userId: string;
  startRequestId: string;
  name: string;
  /** Research's brief, already checked against research's own schema. */
  brief: Prisma.InputJsonObject;
};

/** What the start transaction writes: the campaign and its first research job. */
type Started = { campaign: Campaign; job: Job };

export type CreateCampaignResult = {
  campaign: Campaign;
  /** The research job this call enqueued; null when the press was a repeat and nothing was written. */
  job: Job | null;
  created: boolean;
};

export async function createCampaign(db: PrismaClient, input: CreateCampaignInput): Promise<CreateCampaignResult> {
  if (input.orgId.trim() === "") throw new Error("createCampaign: orgId is required");
  if (input.userId.trim() === "") throw new Error("createCampaign: userId is required");
  if (input.startRequestId.trim() === "") throw new Error("createCampaign: startRequestId is required");
  if (input.name.trim() === "") throw new Error("createCampaign: name is required");

  try {
    const { campaign, job } = await mutate(db, {
      orgId: input.orgId,
      actor: { kind: "user", userId: input.userId },
      kind: CAMPAIGN_CREATED,
      // The row's own cuid, read off what `apply` wrote: the Event is written after it.
      campaignId: (written: Started) => written.campaign.id,
      after: { name: input.name, briefVersion: 1, brief: input.brief, startRequestId: input.startRequestId },
      apply: async (tx): Promise<Started> => {
        // The campaign first, so a repeated press fails on its unique index
        // before a job is even attempted.
        const campaign = await tx.campaign.create({
          data: {
            orgId: input.orgId,
            ownerUserId: input.userId,
            name: input.name,
            briefVersion: 1,
            brief: input.brief,
            startRequestId: input.startRequestId,
          },
        });
        const { job, deduped } = await enqueue(tx, {
          orgId: input.orgId,
          ownerUserId: input.userId,
          kind: RESEARCH_JOB,
          idempotencyKey: researchJobKey(campaign.id, 1),
          input: { brief: input.brief },
          campaignId: campaign.id,
          briefVersion: 1,
        });
        // A key built from an id minted a moment ago cannot already have a
        // job. If it does, something else is writing research keys, and a
        // campaign pointing at that job would show someone else's research.
        if (deduped) throw new Error("createCampaign: a new campaign's research key already had a job");
        return { campaign, job };
      },
    });
    return { campaign, job, created: true };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const existing = await db.campaign.findUnique({
      where: { orgId_startRequestId: { orgId: input.orgId, startRequestId: input.startRequestId } },
    });
    // Another rep's campaign under the same request id is not this press's
    // campaign; the violation stands.
    if (existing === null || existing.ownerUserId !== input.userId) throw error;
    return { campaign: existing, job: null, created: false };
  }
}

/** A campaign with what its screen is derived from: the latest research job at its brief version, and that job's Event. */
/** A campaign with what its screen is derived from, and, once confirmed, its lead gen (lead gen v2.1 §11). */
export type CampaignRecord = {
  campaign: Campaign;
  job: Job | null;
  event: Event | null;
  leadGen?: LeadGenRecord;
  /** The campaign's credit ledger, every version, grouped (product-truth foundation). */
  ledger?: LedgerGroup[];
  /** Research's recorded model cost, per brief version. */
  researchCost?: ResearchCost[];
};

type Owner = { orgId: string; userId: string };

/**
 * The latest research job for the campaign's current brief version: its own,
 * or, for a campaign made from one play of another's plan, that campaign's at
 * the version it was made from (`researchSourceOf`). Always within the org.
 */
export async function latestResearchJob(
  db: Prisma.TransactionClient,
  campaign: Pick<Campaign, "id" | "orgId" | "briefVersion" | "researchFromCampaignId" | "researchFromBriefVersion">,
): Promise<Job | null> {
  const source = researchSourceOf(campaign);
  return db.job.findFirst({
    where: { orgId: campaign.orgId, campaignId: source.campaignId, kind: RESEARCH_JOB, briefVersion: source.briefVersion },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}

async function withResearch(db: PrismaClient, campaign: Campaign): Promise<CampaignRecord> {
  const job = await latestResearchJob(db, campaign);
  const event = job === null ? null : await findResearchCompletedForJob(db, { orgId: campaign.orgId, jobId: job.id });
  const [leadGen, ledger, researchCost] = await Promise.all([
    leadGenRecordFor(db, campaign),
    ledgerGroupsFor(db, campaign.orgId, [campaign.id]),
    researchCostsFor(db, campaign.orgId, [campaign.id]),
  ]);
  return { campaign, job, event, leadGen, ledger, researchCost };
}

/**
 * The rep's own campaigns, newest first (§23.1c). One read per campaign for
 * its research; a rep's list is short, and the join the Event needs is a JSON
 * path, not a column.
 */
export async function listCampaignsForOwner(db: PrismaClient, owner: Owner): Promise<CampaignRecord[]> {
  const campaigns = await db.campaign.findMany({
    where: { orgId: owner.orgId, ownerUserId: owner.userId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return Promise.all(campaigns.map((campaign) => withResearch(db, campaign)));
}

/** One of the rep's own campaigns, or null: another rep's, another org's and nobody's are the same answer. */
export async function getCampaignForOwner(db: PrismaClient, owner: Owner & { id: string }): Promise<CampaignRecord | null> {
  const campaign = await db.campaign.findFirst({ where: { id: owner.id, orgId: owner.orgId, ownerUserId: owner.userId } });
  return campaign === null ? null : withResearch(db, campaign);
}

/** Whether the rep has a campaign at all: the nav's "New campaign" and Home's day-one state turn on it. */
export async function hasCampaign(db: PrismaClient, owner: Owner): Promise<boolean> {
  return (await db.campaign.count({ where: { orgId: owner.orgId, ownerUserId: owner.userId } })) > 0;
}

// ---------------------------------------------------------------------------
// Changing a campaign's research (orchestrator amendment A1, items 4 to 6).
//
// Three writes, one shape. Each is one `mutate`: the campaign row is locked
// first (`FOR UPDATE`, owner-scoped), and everything the write decides on is
// read after the lock, inside the transaction:
//
//   * the version the rep acted on must be the campaign's own. Ahead is a
//     version that does not exist; behind is a page opened before someone
//     else's change. Both are refused, so a stale page can never stack a
//     change on a brief it has not seen;
//   * the state, derived as the screen derives it, must be one the action is
//     offered in;
//   * a request id the rep's page minted once is looked for among the
//     campaign's Events. Found, the press is a repeat of one that already
//     landed, and it is answered with the campaign as it is, writing nothing.
//
// The lock is what makes those reads true at commit. Two presses from the
// same version queue on it: the first commits, and the second then reads the
// version the first wrote (a widening or an edit) or the job the first put
// back on the queue (Try again), and is refused or recognised as a repeat.
// The version guard is on the update too, and the new version's research key
// is new, so neither the row nor the queue can take a second change even if
// the lock were ever lost.

export const CAMPAIGN_BRIEF_CHANGED = "campaign.brief_changed" as const;
export const CAMPAIGN_RESEARCH_RETRIED = "campaign.research_retried" as const;

export const CAMPAIGN_REVEAL_RETRIED = "campaign.reveal_retried" as const;

type ChangeKind =
  | typeof CAMPAIGN_BRIEF_CHANGED
  | typeof CAMPAIGN_RESEARCH_RETRIED
  | typeof CAMPAIGN_CONFIRMED
  | typeof LEADGEN_RERUN
  | typeof CAMPAIGN_REVEAL_CONFIRMED
  | typeof CAMPAIGN_REVEAL_RETRIED
  | typeof CAMPAIGN_PLAYS_CHOSEN
  | typeof OUTREACH_REQUESTED;

/** Why a change was refused. The router turns each into a code and a line from the copy file. */
export type ChangeRefusal =
  /** Not the rep's campaign, not in their org, or not there: the same answer. */
  | "not_found"
  /** The rep acted on a version the campaign has not reached. */
  | "version_ahead"
  /** The rep acted on a version the campaign has moved on from. */
  | "version_behind"
  /** The action is not offered in the state the campaign is in. */
  | "wrong_state"
  /** The widening chosen is not one the stop offered, or no longer widens the brief. */
  | "bad_option"
  /** Edit brief with nothing changed: research would run again on the same brief. */
  | "unchanged"
  /** A repeated request id carrying a different change from the one it made. */
  | "request_reused"
  /** Finding people is not set up in this environment. */
  | "not_available"
  /** Research ranked no kind of buyer to start with. */
  | "no_ranked_group"
  /** The kind of buyer research ranks first has no targeting recipe. */
  | "no_recipe"
  /** The play the rep chose is not one the current plan ranks (lead gen v2.3). */
  | "unknown_candidate"
  /** Research has not reached a plan. */
  | "research_not_ready"
  /** The search limit is more than the credits available. */
  | "over_cap"
  /** The provider's credit balance could not be read, so nothing was frozen or started. */
  | "balance_unavailable"
  /** Reveal emails with nobody kept who has an email to reveal or reuse. */
  | "nothing_to_reveal"
  /** The kept people or the reveal's figures changed since the page the rep approved was drawn. */
  | "estimate_changed"
  /** The reveal's credit maximum is more than the credits available. */
  | "reveal_over_balance"
  /** Write emails with nobody kept who has a usable email. */
  | "nothing_to_draft";

export class CampaignChangeRefused extends Error {
  constructor(
    readonly refusal: ChangeRefusal,
    detail?: string,
  ) {
    super(detail === undefined ? `campaign change refused: ${refusal}` : `campaign change refused: ${refusal} (${detail})`);
    this.name = "CampaignChangeRefused";
  }
}

/** Thrown inside the transaction to roll it back when the press already landed; never leaves this module. */
class AlreadyDone extends Error {
  constructor() {
    super("campaign change already made");
  }
}

export type ChangeResult = {
  campaign: Campaign;
  /** The job this call put on the queue; null when the press was a repeat and nothing was written. */
  job: Job | null;
  repeated: boolean;
};

type Tx = Prisma.TransactionClient;

/** What each change's transaction returns: the rows, and the Event's two sides. */
type Changed = { campaign: Campaign; job: Job; before: Prisma.InputJsonObject; after: Prisma.InputJsonObject };

type ChangeInput = Owner & { campaignId: string; requestId: string };

function required(fields: Record<string, string>, where: string): void {
  for (const [name, value] of Object.entries(fields)) {
    if (value.trim() === "") throw new Error(`${where}: ${name} is required`);
  }
}

/** Lock the rep's own campaign for the rest of the transaction, and read it. Null when it is not theirs. */
async function lockOwnCampaign(tx: Tx, input: Owner & { campaignId: string }): Promise<Campaign | null> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM campaigns
     WHERE id = ${input.campaignId} AND org_id = ${input.orgId} AND owner_user_id = ${input.userId}
       FOR UPDATE
  `;
  if (rows.length === 0) return null;
  return tx.campaign.findUniqueOrThrow({ where: { id: input.campaignId } });
}

function checkVersion(campaign: Campaign, version: number): void {
  if (version > campaign.briefVersion) throw new CampaignChangeRefused("version_ahead");
  if (version < campaign.briefVersion) throw new CampaignChangeRefused("version_behind");
}

/** The research the screen is derived from, read on the transaction: the latest job at the current version and its Event. */
async function researchNow(tx: Tx, campaign: Campaign): Promise<{ job: Job | null; event: Event | null }> {
  const job = await latestResearchJob(tx, campaign);
  const event =
    job === null
      ? null
      : await tx.event.findFirst({
          where: { orgId: campaign.orgId, kind: RESEARCH_COMPLETED, after: { path: ["jobId"], equals: job.id } },
          orderBy: { at: "asc" },
        });
  return { job, event };
}

function stateOf(research: { job: Job | null; event: Event | null }) {
  return deriveResearch(
    research.job === null ? null : { status: research.job.status, error: research.job.error },
    research.event === null ? null : { after: research.event.after },
  );
}

/**
 * Whether this request id already made a change of this kind on this
 * campaign. `same` says whether the stored change is the one being asked for
 * again; a request id reused for a different change is refused rather than
 * answered as a repeat of something it did not ask for.
 */
async function alreadyMade(
  tx: Tx,
  input: ChangeInput,
  kind: ChangeKind,
  same: (after: Record<string, unknown>, before: Record<string, unknown>) => boolean,
): Promise<void> {
  const event = await tx.event.findFirst({
    where: { orgId: input.orgId, campaignId: input.campaignId, kind, after: { path: ["requestId"], equals: input.requestId } },
  });
  if (event === null) return;
  const record = (value: unknown) => (value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {});
  if (!same(record(event.after), record(event.before))) throw new CampaignChangeRefused("request_reused");
  throw new AlreadyDone();
}

/**
 * The brief moves to its next version, and research for that version is put
 * on the queue. The update carries the version guard, so it cannot land on a
 * brief that moved after the lock; the key names the new version, so the
 * queue cannot already hold it.
 */
async function advance(tx: Tx, campaign: Campaign, input: ResearchJobInput, rename: { name?: string } = {}): Promise<{ campaign: Campaign; job: Job }> {
  const to = campaign.briefVersion + 1;
  const updated = await tx.campaign.updateMany({
    where: { id: campaign.id, orgId: campaign.orgId, ownerUserId: campaign.ownerUserId, briefVersion: campaign.briefVersion },
    // A play chosen on the old plan is not one the new research has ranked yet (Relay P1): the rep chooses again.
    data: { brief: input.brief as Prisma.InputJsonObject, briefVersion: to, playId: null, ...rename },
  });
  if (updated.count !== 1) throw new CampaignChangeRefused("version_behind");
  const { job, deduped } = await enqueue(tx, {
    orgId: campaign.orgId,
    ownerUserId: campaign.ownerUserId,
    kind: RESEARCH_JOB,
    idempotencyKey: researchJobKey(campaign.id, to),
    input: input as Prisma.InputJsonObject,
    campaignId: campaign.id,
    briefVersion: to,
  });
  // As at Start: a version the campaign has only just reached cannot already
  // have research, and a job under its key would be somebody else's.
  if (deduped) throw new Error("campaign change: the new brief version's research key already had a job");
  return { campaign: await tx.campaign.findUniqueOrThrow({ where: { id: campaign.id } }), job };
}

/** Run one change, and answer a repeat with the campaign as it is. */
async function change(
  db: PrismaClient,
  input: ChangeInput,
  kind: ChangeKind,
  apply: (tx: Tx) => Promise<Changed>,
): Promise<ChangeResult> {
  required({ orgId: input.orgId, userId: input.userId, campaignId: input.campaignId, requestId: input.requestId }, kind);
  try {
    const changed = await mutate(db, {
      orgId: input.orgId,
      actor: { kind: "user", userId: input.userId },
      kind,
      campaignId: input.campaignId,
      before: (written: Changed) => written.before,
      after: (written: Changed) => written.after,
      apply,
    });
    return { campaign: changed.campaign, job: changed.job, repeated: false };
  } catch (error) {
    if (!(error instanceof AlreadyDone)) throw error;
    const campaign = await db.campaign.findFirstOrThrow({ where: { id: input.campaignId, orgId: input.orgId, ownerUserId: input.userId } });
    return { campaign, job: null, repeated: true };
  }
}

function briefOf(campaign: Campaign): ResearchBrief {
  // Written only through `createCampaign` and `advance`, both from a brief
  // research's schema accepted: a row that no longer parses is a defect.
  return researchBriefSchema.parse(campaign.brief);
}

export type WidenInput = ChangeInput & { fromBriefVersion: number; optionIndex: number };

/**
 * Widen (A1, item 4): from a stop only, the one option the rep chose, applied
 * to the brief, as the next version, with research asked to look again.
 *
 * The option is read from the stop's own `research.completed` Event, by
 * position, and checked again against the brief as it stands before it is
 * applied (`widenedBrief`). `priorPackIds` names the stop, and `priorRun`
 * tells research why it is running again and along which dimension.
 */
export async function widenCampaign(db: PrismaClient, input: WidenInput): Promise<ChangeResult> {
  return change(db, input, CAMPAIGN_BRIEF_CHANGED, async (tx) => {
    const campaign = await lockOwnCampaign(tx, input);
    if (campaign === null) throw new CampaignChangeRefused("not_found");
    await alreadyMade(
      tx,
      input,
      CAMPAIGN_BRIEF_CHANGED,
      (after, before) =>
        after.cause === "widening" &&
        before.briefVersion === input.fromBriefVersion &&
        (after.widening as { optionIndex?: unknown } | undefined)?.optionIndex === input.optionIndex,
    );
    checkVersion(campaign, input.fromBriefVersion);

    const research = await researchNow(tx, campaign);
    const view = stateOf(research);
    if (view.state !== "stopped" || research.event === null) throw new CampaignChangeRefused("wrong_state");
    const option = view.pack.insufficient?.widenings[input.optionIndex];
    if (option === undefined) throw new CampaignChangeRefused("bad_option");

    const brief = briefOf(campaign);
    const widened = widenedBrief(brief, option);
    if (!widened.ok) throw new CampaignChangeRefused("bad_option", widened.issue);

    const jobInput = researchJobInputSchema.parse({
      brief: widened.brief,
      priorPackIds: [research.event.id],
      priorRun: { insufficient: true, widenedBy: widened.widening.dimension, note: widened.widening.text },
    });
    const next = await advance(tx, campaign, jobInput);
    return {
      ...next,
      before: { briefVersion: campaign.briefVersion, brief: brief as Prisma.InputJsonObject },
      after: {
        briefVersion: next.campaign.briefVersion,
        brief: jobInput.brief as Prisma.InputJsonObject,
        cause: "widening",
        requestId: input.requestId,
        widening: {
          optionIndex: input.optionIndex,
          dimension: widened.widening.dimension,
          text: widened.widening.text,
          scopePatch: JSON.parse(JSON.stringify(widened.widening.scopePatch)) as Prisma.InputJsonObject,
        },
        priorPackIds: [research.event.id],
        jobId: next.job.id,
      },
    };
  });
}

export type EditInput = ChangeInput & { fromBriefVersion: number; brief: ResearchBrief };

/**
 * Edit brief (A1, item 5): from Plan ready (partial included), a stop, or
 * needs you, never while research is reading. The rep's own fields become the
 * next version, and research runs again on them, reading the campaign's
 * latest pack if it has one, with no `priorRun`: nothing is said about why.
 *
 * The campaign's name is not the rep's own title: it is made from `who`
 * (`nameFrom`), so an edit that changes `who` makes it again, in the same
 * transaction, and the Event carries both names. An edit that leaves `who`
 * alone leaves the name alone.
 */
export async function editCampaignBrief(db: PrismaClient, input: EditInput): Promise<ChangeResult> {
  return change(db, input, CAMPAIGN_BRIEF_CHANGED, async (tx) => {
    const campaign = await lockOwnCampaign(tx, input);
    if (campaign === null) throw new CampaignChangeRefused("not_found");
    await alreadyMade(
      tx,
      input,
      CAMPAIGN_BRIEF_CHANGED,
      (after, before) =>
        after.cause === "edit" &&
        before.briefVersion === input.fromBriefVersion &&
        researchBriefSchema.safeParse(after.brief).success &&
        sameBrief(researchBriefSchema.parse(after.brief), input.brief),
    );
    checkVersion(campaign, input.fromBriefVersion);

    // Never while any of the version's work is still queued or running: research
    // reading, people being found (lead gen v2.1 §11), or emails being revealed.
    const view = stateOf(await researchNow(tx, campaign));
    const scope = { orgId: campaign.orgId, campaignId: campaign.id, briefVersion: campaign.briefVersion };
    const finding = await latestLeadGenJob(tx, scope);
    const revealing = await tx.job.findFirst({ where: { ...scope, kind: REVEAL_JOB, status: { in: ["queued", "running"] } } });
    const allowed = editAllowed({
      researchInFlight: view.state === "researching",
      leadGenInFlight: finding !== null && inFlight(finding) && (await findLeadGenResult(tx, { orgId: campaign.orgId, jobId: finding.id })) === null,
      revealInFlight: revealing !== null && (await findRevealResult(tx, { orgId: campaign.orgId, jobId: revealing.id })) === null,
    });
    if (!allowed) throw new CampaignChangeRefused("wrong_state");

    const brief = briefOf(campaign);
    if (sameBrief(brief, input.brief)) throw new CampaignChangeRefused("unchanged");

    // A campaign made from another's plan has no pack of its own yet: research reads the plan it was made from.
    const prior = (await latestPack(tx, campaign)) ?? (campaign.researchFromCampaignId === null ? null : ((await researchNow(tx, campaign)).event?.id ?? null));
    const jobInput = researchJobInputSchema.parse({ brief: input.brief, ...(prior === null ? {} : { priorPackIds: [prior] }) });
    const name = input.brief.who === brief.who ? campaign.name : nameFrom(input.brief.who);
    const renamed = name !== campaign.name;
    const next = await advance(tx, campaign, jobInput, renamed ? { name } : {});
    return {
      ...next,
      before: {
        briefVersion: campaign.briefVersion,
        brief: brief as Prisma.InputJsonObject,
        ...(renamed ? { name: campaign.name } : {}),
        ...(campaign.playId === null ? {} : { playId: campaign.playId }),
      },
      after: {
        briefVersion: next.campaign.briefVersion,
        brief: jobInput.brief as Prisma.InputJsonObject,
        ...(renamed ? { name: next.campaign.name } : {}),
        cause: "edit",
        requestId: input.requestId,
        priorPackIds: prior === null ? [] : [prior],
        jobId: next.job.id,
      },
    };
  });
}

/**
 * The campaign's latest research pack, by its Event id, from any version: the
 * pack an edited brief's research reads (A1, item 5). A pack that no longer
 * parses is passed over, since research would refuse to read it.
 */
async function latestPack(tx: Tx, campaign: Campaign): Promise<string | null> {
  const events = await tx.event.findMany({
    where: { orgId: campaign.orgId, campaignId: campaign.id, kind: RESEARCH_COMPLETED },
    orderBy: [{ at: "desc" }, { id: "desc" }],
    take: 20,
  });
  const readable = events.find((event) => {
    const after = event.after !== null && typeof event.after === "object" ? (event.after as { pack?: unknown }) : {};
    return researchRawSchema.safeParse(after.pack).success;
  });
  return readable?.id ?? null;
}

export type RetryInput = ChangeInput & { briefVersion: number };

/**
 * Try again (A1, item 6): research that failed runs again, for the same brief
 * version, with the failed job's input exactly as it was.
 *
 * Through the queue's own retry, not a second job: the failed job is put back
 * on the queue (`reopenFailed`), so its key, its input and its attempt count
 * carry on, and research resumes it as it resumes any retried job. Only a job
 * that actually failed can go back; a campaign that needs the rep for another
 * reason (a result it could not read) is changed with Edit brief instead.
 */
export async function retryResearch(db: PrismaClient, input: RetryInput): Promise<ChangeResult> {
  return change(db, input, CAMPAIGN_RESEARCH_RETRIED, async (tx) => {
    const campaign = await lockOwnCampaign(tx, input);
    if (campaign === null) throw new CampaignChangeRefused("not_found");
    await alreadyMade(tx, input, CAMPAIGN_RESEARCH_RETRIED, (after) => after.briefVersion === input.briefVersion);
    checkVersion(campaign, input.briefVersion);

    const { job, event } = await researchNow(tx, campaign);
    if (job === null || !researchRetryable(job, event !== null)) throw new CampaignChangeRefused("wrong_state");
    const reopened = await reopenFailed(tx, { orgId: campaign.orgId, jobId: job.id });
    // Unreachable under the lock, and refused rather than assumed if it ever is.
    if (reopened === null) throw new CampaignChangeRefused("wrong_state");
    return {
      campaign,
      job: reopened,
      before: {
        briefVersion: campaign.briefVersion,
        jobId: job.id,
        status: job.status,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        failure: failureOf(job.error),
      },
      after: {
        briefVersion: campaign.briefVersion,
        jobId: reopened.id,
        status: reopened.status,
        attempts: reopened.attempts,
        maxAttempts: reopened.maxAttempts,
        requestId: input.requestId,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Confirm plan and finding people (lead gen v2.1 §3, §6, §11; orchestrator A2).

export type ConfirmInput = ChangeInput & {
  fromBriefVersion: number;
  /** The play the rep chose (an m16 candidate id, lead gen v2.3). Absent: research's top-ranked play. */
  candidateId?: string;
  /** How finding people is set up here; null when it is not, and Confirm is refused. */
  setup: LeadGenSetup | null;
  now?: () => Date;
};

/**
 * Confirm plan: the first spend gate. One transaction freezes the handoff
 * (built by the campaign boundary from the signed research result) into the
 * `campaign.confirmed` Event, with the lawful-basis text the rep confirmed,
 * and enqueues the one lead gen job for the version. A repeated press is the
 * press that landed; a second Confirm of a confirmed version is refused.
 *
 * The balance is read before the transaction: it is a call out, and the
 * campaign lock is not held across one. It is frozen in the handoff.
 */
export async function confirmCampaign(db: PrismaClient, input: ConfirmInput): Promise<ChangeResult> {
  const setup = input.setup;
  if (setup === null) throw new CampaignChangeRefused("not_available");
  required({ orgId: input.orgId, userId: input.userId, campaignId: input.campaignId, requestId: input.requestId }, CAMPAIGN_CONFIRMED);
  let balance: Awaited<ReturnType<typeof setup.readBalance>>;
  try {
    balance = await setup.readBalance(input.orgId);
  } catch {
    // Never a guessed balance: without one the spend invariant has nothing to hold against.
    throw new CampaignChangeRefused("balance_unavailable");
  }
  const confirmedAt = (input.now ?? (() => new Date()))();

  return change(db, input, CAMPAIGN_CONFIRMED, async (tx) => {
    const campaign = await lockOwnCampaign(tx, input);
    if (campaign === null) throw new CampaignChangeRefused("not_found");
    // A campaign made for one play (Relay P1) confirms that play and no other.
    if (campaign.playId !== null && input.candidateId !== undefined && input.candidateId !== campaign.playId) {
      throw new CampaignChangeRefused("unknown_candidate");
    }
    const candidateId = campaign.playId ?? input.candidateId;
    // A repeat of the same press names the same version and the same choice:
    // the same play when it named one, and no play when it took the default.
    await alreadyMade(
      tx,
      input,
      CAMPAIGN_CONFIRMED,
      (after) =>
        after.briefVersion === input.fromBriefVersion &&
        (candidateId === undefined
          ? after.selection !== "chosen"
          : (after.handoff as { play?: { id?: unknown } } | undefined)?.play?.id === candidateId),
    );
    checkVersion(campaign, input.fromBriefVersion);
    const scope = { orgId: campaign.orgId, campaignId: campaign.id, briefVersion: campaign.briefVersion };
    if ((await findConfirmEvent(tx, scope)) !== null) throw new CampaignChangeRefused("wrong_state", "already confirmed");

    const research = await researchNow(tx, campaign);
    const pack = research.event === null ? null : storedPack(research.event.after);
    const view = stateOf(research);
    // A finished plan with no play that can be searched is refused with its
    // own reason (no ranked group, no recipe), which the handoff builder names.
    const noPlay = view.state === "failed" && view.failure === "no_play";
    if ((view.state !== "planReady" && !noPlay) || research.job === null || research.event === null || pack === null) {
      throw new CampaignChangeRefused("wrong_state");
    }
    if (setup.searchCreditCap > balance.remaining) throw new CampaignChangeRefused("over_cap");

    const built = buildLeadGenHandoff({
      campaign: { id: campaign.id, orgId: campaign.orgId, ownerUserId: campaign.ownerUserId, briefVersion: campaign.briefVersion },
      brief: briefOf(campaign),
      research: { jobId: research.job.id, eventId: research.event.id, pack },
      confirmRequestId: input.requestId,
      ...(candidateId === undefined ? {} : { candidateId }),
      spend: {
        searchCreditCap: setup.searchCreditCap,
        balanceSnapshot: {
          remaining: balance.remaining,
          ...(balance.used === undefined ? {} : { used: balance.used }),
          ...(balance.total === undefined ? {} : { total: balance.total }),
          readAt: balance.readAt.toISOString(),
        },
        pricingAssumptions: setup.pricingAssumptions,
      },
      // The exact words the Confirm screen shows, confirmed by this rep, for this version. Not an LIA.
      lawfulBasis: { text: campaignsCopy.lawfulBasis, confirmedByUserId: input.userId, confirmedAt: confirmedAt.toISOString(), briefVersion: campaign.briefVersion },
    });
    if (!built.ok) throw new CampaignChangeRefused(built.refusal);

    const { job, deduped } = await enqueue(tx, {
      orgId: campaign.orgId,
      ownerUserId: campaign.ownerUserId,
      kind: LEAD_GEN_JOB,
      idempotencyKey: leadGenJobKey(campaign.id, campaign.briefVersion, 1),
      input: { confirmRequestId: input.requestId, run: 1 },
      campaignId: campaign.id,
      briefVersion: campaign.briefVersion,
    });
    if (deduped) throw new Error("confirm: this version's lead gen key already had a job");
    return {
      campaign,
      job,
      before: { briefVersion: campaign.briefVersion },
      after: {
        requestId: input.requestId,
        briefVersion: campaign.briefVersion,
        handoff: JSON.parse(JSON.stringify(built.handoff)) as Prisma.InputJsonObject,
        // Whether the rep chose the play or took research's top-ranked one (lead gen v2.3).
        selection: candidateId === undefined ? "default" : "chosen",
        balanceSource: balance.source,
        jobId: job.id,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// One campaign per play (Relay P1).

export const CAMPAIGN_PLAYS_CHOSEN = "campaign.plays_chosen" as const;

export type CreatePlayCampaignsInput = ChangeInput & { fromBriefVersion: number; playIds: readonly string[] };

export type CreatePlayCampaignsResult = {
  /** The campaign the research ran on first, then one new campaign per other play, in research's order. */
  campaigns: Campaign[];
  repeated: boolean;
};

/** The start request id a play's campaign is made under: unique per org, so a repeated press cannot make it twice. */
function playRequestId(requestId: string, playId: string): string {
  return `plays:${requestId}:${playId}`;
}

/**
 * Create campaigns (Relay P1): on Plan ready, the plays the rep ticked each
 * become a campaign of their own, sharing this campaign's research. The first
 * ticked play (in research's order) stays on this campaign; each other play is
 * a new campaign at brief version 1 that reads this campaign's research at the
 * version on screen (`researchSourceOf`). No research job is made and nothing
 * is spent. Each campaign is then confirmed on its own, for its own play.
 *
 * Only the campaign the research ran on, only before Confirm, and only once:
 * a campaign that already has a play is refused. Every campaign is named from
 * its play. One transaction, under the campaign's lock: this campaign's
 * `campaign.plays_chosen` Event, and a `campaign.created` Event per new one.
 * A repeated press is the press that landed, found by its request id.
 */
export async function createPlayCampaigns(db: PrismaClient, input: CreatePlayCampaignsInput): Promise<CreatePlayCampaignsResult> {
  required({ orgId: input.orgId, userId: input.userId, campaignId: input.campaignId, requestId: input.requestId }, CAMPAIGN_PLAYS_CHOSEN);
  const asked = [...new Set(input.playIds)];
  if (asked.length === 0) throw new CampaignChangeRefused("unknown_candidate");
  const repeat = async (): Promise<CreatePlayCampaignsResult> => {
    const campaigns = await db.campaign.findMany({
      where: {
        orgId: input.orgId,
        ownerUserId: input.userId,
        OR: [{ id: input.campaignId }, { researchFromCampaignId: input.campaignId, startRequestId: { startsWith: playRequestId(input.requestId, "") } }],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return { campaigns, repeated: true };
  };

  type Made = { campaigns: Campaign[]; before: Prisma.InputJsonObject; after: Prisma.InputJsonObject };
  try {
    const made = await mutate(db, {
      orgId: input.orgId,
      actor: { kind: "user", userId: input.userId },
      kind: CAMPAIGN_PLAYS_CHOSEN,
      campaignId: input.campaignId,
      before: (written: Made) => written.before,
      after: (written: Made) => written.after,
      apply: async (tx): Promise<Made> => {
        const campaign = await lockOwnCampaign(tx, input);
        if (campaign === null) throw new CampaignChangeRefused("not_found");
        await alreadyMade(tx, input, CAMPAIGN_PLAYS_CHOSEN, (after) => JSON.stringify(after.playIds) === JSON.stringify(asked));
        checkVersion(campaign, input.fromBriefVersion);
        // Only the campaign the research ran on, once, and before any Confirm.
        if (campaign.researchFromCampaignId !== null || campaign.playId !== null) throw new CampaignChangeRefused("wrong_state");
        const scope = { orgId: campaign.orgId, campaignId: campaign.id, briefVersion: campaign.briefVersion };
        if ((await findConfirmEvent(tx, scope)) !== null) throw new CampaignChangeRefused("wrong_state");

        const research = await researchNow(tx, campaign);
        const pack = research.event === null ? null : storedPack(research.event.after);
        if (stateOf(research).state !== "planReady" || pack === null) throw new CampaignChangeRefused("wrong_state");
        // Only a play that can be searched can be confirmed, so only one can be ticked.
        const plays = playsOf(pack).filter((play) => play.executable && asked.includes(play.id));
        if (plays.length !== asked.length) throw new CampaignChangeRefused("unknown_candidate");

        const [first, ...others] = plays;
        const kept = await tx.campaign.update({ where: { id: campaign.id }, data: { playId: first!.id, name: first!.group.name } });
        const created: Campaign[] = [];
        for (const play of others) {
          const startRequestId = playRequestId(input.requestId, play.id);
          const row = await tx.campaign.create({
            data: {
              orgId: campaign.orgId,
              ownerUserId: campaign.ownerUserId,
              name: play.group.name,
              briefVersion: 1,
              brief: campaign.brief as Prisma.InputJsonObject,
              startRequestId,
              researchFromCampaignId: campaign.id,
              researchFromBriefVersion: campaign.briefVersion,
              playId: play.id,
            },
          });
          await tx.event.create({
            data: {
              orgId: campaign.orgId,
              kind: CAMPAIGN_CREATED,
              actorKind: "user",
              actorUserId: input.userId,
              campaignId: row.id,
              after: {
                name: row.name,
                briefVersion: 1,
                brief: campaign.brief as Prisma.InputJsonObject,
                startRequestId,
                researchFrom: { campaignId: campaign.id, briefVersion: campaign.briefVersion },
                playId: play.id,
              },
            },
          });
          created.push(row);
        }
        return {
          campaigns: [kept, ...created],
          before: { name: campaign.name, briefVersion: campaign.briefVersion },
          after: {
            requestId: input.requestId,
            briefVersion: campaign.briefVersion,
            playIds: asked,
            name: kept.name,
            playId: first!.id,
            created: created.map((row) => ({ campaignId: row.id, playId: row.playId })),
          },
        };
      },
    });
    return { campaigns: made.campaigns, repeated: false };
  } catch (error) {
    if (error instanceof AlreadyDone) return repeat();
    // Two presses that both passed the lock cannot happen; a clash on a play's
    // start request id is still the same press. Any other unique violation
    // rolled the whole create back, and surfaces.
    if (isUniqueViolation(error) && targetsStartRequestId(error)) return repeat();
    throw error;
  }
}

/** Whether a P2002 names the campaigns' `start_request_id` unique key, as Prisma reports it. */
function targetsStartRequestId(error: unknown): boolean {
  const target: unknown = (error as { meta?: { target?: unknown } }).meta?.target;
  const fields = Array.isArray(target) ? target.map(String) : typeof target === "string" ? [target] : [];
  return fields.some((field) => field.includes("start_request_id") || field.includes("startRequestId"));
}

export type RerunInput = ChangeInput & {
  briefVersion: number;
  /** A chosen industry, from a `choose_industry` halt's own choices. Absent, this is Try again. */
  choice?: { term: string; label: string };
};

/**
 * Finding people again at the same version, from Needs you: Try again after a
 * busy provider, a timeout or a failed job, or a search with the industry the
 * rep chose. A new job for the same Confirm, so the same frozen handoff and
 * the same credit cap. Anything else (unmappable, would widen, no one found,
 * over the cap) is changed with Edit brief.
 */
export async function rerunPeople(db: PrismaClient, input: RerunInput): Promise<ChangeResult> {
  return change(db, input, LEADGEN_RERUN, async (tx) => {
    const campaign = await lockOwnCampaign(tx, input);
    if (campaign === null) throw new CampaignChangeRefused("not_found");
    await alreadyMade(
      tx,
      input,
      LEADGEN_RERUN,
      (after) => after.briefVersion === input.briefVersion && ((after.choice as { label?: unknown } | undefined)?.label ?? null) === (input.choice?.label ?? null),
    );
    checkVersion(campaign, input.briefVersion);

    const scope = { orgId: campaign.orgId, campaignId: campaign.id, briefVersion: campaign.briefVersion };
    const confirm = await findConfirmEvent(tx, scope);
    const job = confirm === null ? null : await latestLeadGenJob(tx, scope);
    if (confirm === null || job === null) throw new CampaignChangeRefused("wrong_state");
    const result = await findLeadGenResult(tx, { orgId: campaign.orgId, jobId: job.id });
    const parsed = result?.kind === LEADGEN_HALTED ? haltSchema.safeParse((result.after as { output?: unknown } | null)?.output) : null;
    const halt = parsed?.success === true ? parsed.data : null;

    if (input.choice !== undefined) {
      const offered = halt?.reason === "choose_industry" && halt.term !== undefined && norm(halt.term) === norm(input.choice.term) && (halt.choices ?? []).includes(input.choice.label);
      if (!offered) throw new CampaignChangeRefused("bad_option");
    } else {
      // The page's Try again reads the same rule (`leadGenRetryable`).
      if (!leadGenRetryable(job, leadGenResultOf(result === null ? null : { kind: result.kind, after: result.after }))) throw new CampaignChangeRefused("wrong_state");
    }

    const previous = leadGenJobInputSchema.parse(job.input);
    const industryChoices = { ...(previous.industryChoices ?? {}), ...(input.choice === undefined ? {} : { [norm(input.choice.term)]: input.choice.label }) };
    const run = (await tx.job.count({ where: { ...scope, kind: LEAD_GEN_JOB } })) + 1;
    const { job: next, deduped } = await enqueue(tx, {
      orgId: campaign.orgId,
      ownerUserId: campaign.ownerUserId,
      kind: LEAD_GEN_JOB,
      idempotencyKey: leadGenJobKey(campaign.id, campaign.briefVersion, run),
      input: { confirmRequestId: previous.confirmRequestId, run, ...(Object.keys(industryChoices).length === 0 ? {} : { industryChoices }) },
      campaignId: campaign.id,
      briefVersion: campaign.briefVersion,
    });
    if (deduped) throw new Error("rerun: this run's lead gen key already had a job");
    return {
      campaign,
      job: next,
      before: { briefVersion: campaign.briefVersion, jobId: job.id, ...(halt === null ? { status: job.status } : { reason: halt.reason }) },
      after: {
        requestId: input.requestId,
        briefVersion: campaign.briefVersion,
        cause: input.choice === undefined ? "retry" : "choice",
        ...(input.choice === undefined ? {} : { choice: input.choice }),
        jobId: next.id,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Keep or drop before Reveal (lead gen v2.2 §9a).

export const CAMPAIGN_PEOPLE_REVIEWED = "campaign.people_reviewed" as const;

export type ReviewInput = Owner & {
  campaignId: string;
  briefVersion: number;
  /** The person pressed on: that one person, or everyone chosen at their account. For `selected`, the first of the ids. */
  personId: string;
  /** `selected`: the chosen people the rep ticked (`personIds`), in one change and one Event (review workspace). */
  scope: "person" | "account" | "selected";
  personIds?: string[];
  decision: "kept" | "dropped";
  now?: () => Date;
};

export type ReviewResult = { campaign: Campaign; changed: string[] };

/** Thrown inside the transaction when every row already has the decision: nothing, not even an Event, is written. */
class NothingToReview extends Error {
  constructor(readonly campaign: Campaign) {
    super("nothing to review");
  }
}

/**
 * Keep or drop, on the chosen people of the current version's latest search.
 * The rep's own campaign is locked and its version checked, and the rows and
 * one `campaign.people_reviewed` Event change together. Drop account is the
 * same change over every chosen person at the pressed person's account: there
 * is no account record. Keep selected is the same change over the ticked
 * people, whichever accounts they sit at. A decision can be changed; pending
 * is never written back, and a press that changes nothing writes nothing.
 */
export async function reviewPeople(db: PrismaClient, input: ReviewInput): Promise<ReviewResult> {
  required({ orgId: input.orgId, userId: input.userId, campaignId: input.campaignId, personId: input.personId }, CAMPAIGN_PEOPLE_REVIEWED);
  const at = (input.now ?? (() => new Date()))();
  type Reviewed = ReviewResult & { jobId: string; before: { id: string; review: string }[] };
  try {
    const reviewed = await mutate<Reviewed>(db, {
      orgId: input.orgId,
      actor: { kind: "user", userId: input.userId },
      kind: CAMPAIGN_PEOPLE_REVIEWED,
      campaignId: input.campaignId,
      apply: async (tx) => {
        const campaign = await lockOwnCampaign(tx, input);
        if (campaign === null) throw new CampaignChangeRefused("not_found");
        checkVersion(campaign, input.briefVersion);
        const scope = { orgId: campaign.orgId, campaignId: campaign.id, briefVersion: campaign.briefVersion };
        const job = await latestLeadGenJob(tx, scope);
        const result = job === null ? null : await findLeadGenResult(tx, { orgId: campaign.orgId, jobId: job.id });
        if (job === null || result?.kind !== LEADGEN_PICKED) throw new CampaignChangeRefused("wrong_state");
        // Once Reveal emails is pressed, the kept set it covers is final.
        if ((await findRevealConfirm(tx, { orgId: campaign.orgId, campaignId: campaign.id, leadGenJobId: job.id })) !== null) throw new CampaignChangeRefused("wrong_state");

        const current = { ...scope, jobId: job.id, status: "chosen" as const };
        const pressed = await tx.campaignPerson.findFirst({ where: { ...current, id: input.personId } });
        if (pressed === null) throw new CampaignChangeRefused("not_found");
        const selected = input.scope === "selected" ? [...new Set([pressed.id, ...(input.personIds ?? [])])] : null;
        const rows = await tx.campaignPerson.findMany({
          where: input.scope === "account" ? { ...current, companyKey: pressed.companyKey } : selected !== null ? { ...current, id: { in: selected } } : { ...current, id: pressed.id },
          select: { id: true, review: true },
          orderBy: [{ rank: "asc" }, { id: "asc" }],
        });
        const moving = rows.filter((row) => row.review !== input.decision);
        if (moving.length === 0) throw new NothingToReview(campaign);
        await tx.campaignPerson.updateMany({
          where: { ...current, id: { in: moving.map((row) => row.id) } },
          data: { review: input.decision, reviewedByUserId: input.userId, reviewedAt: at },
        });
        return { campaign, changed: moving.map((row) => row.id), jobId: job.id, before: moving.map((row) => ({ id: row.id, review: row.review })) };
      },
      before: (reviewed) => ({ people: reviewed.before }),
      after: (reviewed) => ({ briefVersion: input.briefVersion, jobId: reviewed.jobId, scope: input.scope, decision: input.decision, people: reviewed.changed }),
    });
    return { campaign: reviewed.campaign, changed: reviewed.changed };
  } catch (error) {
    if (error instanceof NothingToReview) return { campaign: error.campaign, changed: [] };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Reveal emails: the second spend gate (lead gen v2.1 §6, §11; v2.2 §9a).

export type RevealInput = ChangeInput & {
  briefVersion: number;
  /** The figures the rep approved, as the page showed them. Anything different is refused, never quietly bought. */
  expected: { toReveal: number; known: number; maxCredits: number };
  /** How finding people is set up here; null when it is not, and Reveal is refused. */
  setup: LeadGenSetup | null;
};

/**
 * Reveal emails: the rep's one explicit approval for buying emails. One
 * transaction records the `campaign.reveal_confirmed` Event, covering the
 * kept people of the current search and the credit maximum the rep saw, and
 * enqueues the one reveal job for them. Nothing is revealed here.
 *
 * The plan is worked out again under the campaign lock, from the kept rows and
 * what the org already knows, with the same function the page used, and must
 * match what the rep approved. The balance is read before the transaction, as
 * Confirm reads it, and the maximum must fit inside it.
 *
 * A repeated press (the same request id) is the press that landed. Once a
 * reveal is confirmed, the kept set is final: another press, a reload or a
 * second tab is refused, and keep and drop are refused too.
 */
export async function confirmReveal(db: PrismaClient, input: RevealInput): Promise<ChangeResult> {
  const setup = input.setup;
  if (setup === null) throw new CampaignChangeRefused("not_available");
  required({ orgId: input.orgId, userId: input.userId, campaignId: input.campaignId, requestId: input.requestId }, CAMPAIGN_REVEAL_CONFIRMED);
  let balance: Awaited<ReturnType<typeof setup.readBalance>>;
  try {
    balance = await setup.readBalance(input.orgId);
  } catch {
    throw new CampaignChangeRefused("balance_unavailable");
  }

  return change(db, input, CAMPAIGN_REVEAL_CONFIRMED, async (tx) => {
    const campaign = await lockOwnCampaign(tx, input);
    if (campaign === null) throw new CampaignChangeRefused("not_found");
    await alreadyMade(tx, input, CAMPAIGN_REVEAL_CONFIRMED, (after) => after.briefVersion === input.briefVersion);
    checkVersion(campaign, input.briefVersion);

    const scope = { orgId: campaign.orgId, campaignId: campaign.id, briefVersion: campaign.briefVersion };
    const confirm = await findConfirmEvent(tx, scope);
    const job = confirm === null ? null : await latestLeadGenJob(tx, scope);
    const result = job === null ? null : await findLeadGenResult(tx, { orgId: campaign.orgId, jobId: job.id });
    if (confirm === null || job === null || result?.kind !== LEADGEN_PICKED) throw new CampaignChangeRefused("wrong_state");
    if ((await findRevealConfirm(tx, { orgId: campaign.orgId, campaignId: campaign.id, leadGenJobId: job.id })) !== null) throw new CampaignChangeRefused("wrong_state");

    // The pricing the search froze: the page's figures were worked out with it too.
    const pricing = pricingById(handoffOf(confirm).spend.pricingAssumptions);
    if (pricing === null || pricing.id !== setup.pricing.id) throw new CampaignChangeRefused("not_available");
    const { kept, plan } = await revealPlanFor(tx, { ...scope, jobId: job.id }, pricing);
    const counts = plan.counts;
    if (counts.toReveal + counts.known === 0) throw new CampaignChangeRefused("nothing_to_reveal");
    if (counts.toReveal !== input.expected.toReveal || counts.known !== input.expected.known || counts.maxCredits !== input.expected.maxCredits) {
      throw new CampaignChangeRefused("estimate_changed");
    }
    if (counts.maxCredits > balance.remaining) throw new CampaignChangeRefused("reveal_over_balance");

    const { job: revealJob, deduped } = await enqueue(tx, {
      orgId: campaign.orgId,
      ownerUserId: campaign.ownerUserId,
      kind: REVEAL_JOB,
      idempotencyKey: revealJobKey(campaign.id, campaign.briefVersion),
      input: { revealRequestId: input.requestId, leadGenJobId: job.id },
      campaignId: campaign.id,
      briefVersion: campaign.briefVersion,
    });
    // Unreachable under the lock, after the reveal-confirm check above: a job under this key is somebody else's.
    if (deduped) throw new Error("reveal: this version's reveal key already had a job");
    return {
      campaign,
      job: revealJob,
      before: { briefVersion: campaign.briefVersion },
      after: {
        requestId: input.requestId,
        briefVersion: campaign.briefVersion,
        leadGenJobId: job.id,
        people: kept.map((row) => row.id),
        counts,
        maxCredits: counts.maxCredits,
        pricingAssumptions: pricing.id,
        balanceSnapshot: {
          remaining: balance.remaining,
          ...(balance.used === undefined ? {} : { used: balance.used }),
          ...(balance.total === undefined ? {} : { total: balance.total }),
          readAt: balance.readAt.toISOString(),
        },
        balanceSource: balance.source,
        jobId: revealJob.id,
      },
    };
  });
}

export type RevealRetryInput = ChangeInput & { briefVersion: number };

/**
 * Try again on Reveal emails (product-truth foundation, 2026-09-15): only for
 * a reveal job that failed before any request left Relay, so nothing can
 * have been charged. The same job goes back on the queue (`reopenFailed`), for
 * the same kept people under the same approval; its ledger keys are per
 * attempt, so it reserves afresh under the same cap.
 *
 * A reveal whose request may have reached the provider (a reservation open
 * or unknown, or a charge with no result recorded) is never retried: buying
 * again could buy the same emails twice. `revealRecovery` decides, and the
 * campaign page reads the same rule.
 */
export async function retryReveal(db: PrismaClient, input: RevealRetryInput): Promise<ChangeResult> {
  return change(db, input, CAMPAIGN_REVEAL_RETRIED, async (tx) => {
    const campaign = await lockOwnCampaign(tx, input);
    if (campaign === null) throw new CampaignChangeRefused("not_found");
    await alreadyMade(tx, input, CAMPAIGN_REVEAL_RETRIED, (after) => after.briefVersion === input.briefVersion);
    checkVersion(campaign, input.briefVersion);

    const scope = { orgId: campaign.orgId, campaignId: campaign.id, briefVersion: campaign.briefVersion };
    const confirm = await findConfirmEvent(tx, scope);
    const job = confirm === null ? null : await latestLeadGenJob(tx, scope);
    const result = job === null ? null : await findLeadGenResult(tx, { orgId: campaign.orgId, jobId: job.id });
    if (confirm === null || job === null || result?.kind !== LEADGEN_PICKED) throw new CampaignChangeRefused("wrong_state");
    const revealConfirm = await findRevealConfirm(tx, { orgId: campaign.orgId, campaignId: campaign.id, leadGenJobId: job.id });
    const approved = revealConfirm === null ? null : revealConfirmedSchema.safeParse(revealConfirm.after);
    if (revealConfirm === null || approved?.success !== true) throw new CampaignChangeRefused("wrong_state");
    const revealJob = await tx.job.findFirst({ where: { orgId: campaign.orgId, id: approved.data.jobId, kind: REVEAL_JOB } });
    if (revealJob === null || (await findRevealResult(tx, { orgId: campaign.orgId, jobId: revealJob.id })) !== null) throw new CampaignChangeRefused("wrong_state");

    const ledger = revealLedgerOf(await ledgerGroupsFor(tx, campaign.orgId, [campaign.id]), revealConfirm.id);
    if (!revealRecovery(revealJob, ledger).retryable) throw new CampaignChangeRefused("wrong_state");
    const reopened = await reopenFailed(tx, { orgId: campaign.orgId, jobId: revealJob.id });
    // Unreachable under the lock, and refused rather than assumed if it ever is.
    if (reopened === null) throw new CampaignChangeRefused("wrong_state");
    return {
      campaign,
      job: reopened,
      before: { briefVersion: campaign.briefVersion, jobId: revealJob.id, status: revealJob.status, attempts: revealJob.attempts, maxAttempts: revealJob.maxAttempts },
      after: {
        requestId: input.requestId,
        briefVersion: campaign.briefVersion,
        jobId: reopened.id,
        status: reopened.status,
        attempts: reopened.attempts,
        maxAttempts: reopened.maxAttempts,
        ledger,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Write emails: the first outreach step (outreach v2.1 §1).

/**
 * Write emails: one `outreach_draft` job per kept person with a usable email,
 * in one transaction with the `outreach.requested` Event. Nothing is sent; a
 * draft waits for the rep. Offered once per version, after Reveal emails has
 * finished; a repeated press is the press that landed.
 */
export async function requestDrafts(db: PrismaClient, input: ChangeInput & { briefVersion: number }): Promise<ChangeResult> {
  return change(db, input, OUTREACH_REQUESTED, async (tx) => {
    const campaign = await lockOwnCampaign(tx, input);
    if (campaign === null) throw new CampaignChangeRefused("not_found");
    await alreadyMade(tx, input, OUTREACH_REQUESTED, (after) => after.briefVersion === input.briefVersion);
    checkVersion(campaign, input.briefVersion);

    const scope = { orgId: campaign.orgId, campaignId: campaign.id, briefVersion: campaign.briefVersion };
    const job = await latestLeadGenJob(tx, scope);
    const revealConfirm = job === null ? null : await findRevealConfirm(tx, { orgId: campaign.orgId, campaignId: campaign.id, leadGenJobId: job.id });
    const approved = revealConfirm === null ? null : revealConfirmedSchema.safeParse(revealConfirm.after);
    const revealed = approved?.success === true ? await findRevealResult(tx, { orgId: campaign.orgId, jobId: approved.data.jobId }) : null;
    if (job === null || revealed === null) throw new CampaignChangeRefused("wrong_state");
    // Once per version: the drafts it asked for are the ones the rep reviews.
    const earlier = await tx.event.findFirst({ where: { orgId: campaign.orgId, campaignId: campaign.id, kind: OUTREACH_REQUESTED, after: { path: ["briefVersion"], equals: campaign.briefVersion } } });
    if (earlier !== null) throw new CampaignChangeRefused("wrong_state");

    const people = await draftablePeople(tx, { ...scope, jobId: job.id });
    if (people.length === 0) throw new CampaignChangeRefused("nothing_to_draft");
    const jobs = [];
    for (const person of people) {
      const { job: draftJob, deduped } = await enqueue(tx, {
        orgId: campaign.orgId,
        ownerUserId: campaign.ownerUserId,
        kind: OUTREACH_DRAFT_JOB,
        idempotencyKey: draftJobKey(campaign.id, campaign.briefVersion, person.id, 1),
        input: { requestId: input.requestId, campaignPersonId: person.id, attempt: 1 },
        campaignId: campaign.id,
        briefVersion: campaign.briefVersion,
      });
      // Unreachable under the lock, after the once-per-version check: a job under this key is somebody else's.
      if (deduped) throw new Error("write emails: a first draft's key already had a job");
      jobs.push(draftJob);
    }
    return {
      campaign,
      job: jobs[0]!,
      before: { briefVersion: campaign.briefVersion },
      after: { requestId: input.requestId, briefVersion: campaign.briefVersion, leadGenJobId: job.id, people: people.map((person) => person.id), jobIds: jobs.map((draftJob) => draftJob.id) },
    };
  });
}
