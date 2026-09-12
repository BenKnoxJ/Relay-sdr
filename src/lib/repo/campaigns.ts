import type { Campaign, Event, Job, Prisma, PrismaClient } from "@prisma/client";

import { researchBriefSchema } from "../../../agents/research/input.schema";
import { researchRawSchema } from "../../../agents/research/output.schema";
import { researchJobInputSchema, sameBrief, widenedBrief, type ResearchBrief, type ResearchJobInput } from "@/lib/campaigns/brief";
import { deriveResearch, failureOf } from "@/lib/campaigns/derive";
import { enqueue, reopenFailed } from "@/lib/jobs/queue";

import { mutate } from "./mutate";
import { RESEARCH_COMPLETED, findResearchCompletedForJob } from "./research";
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
export type CampaignRecord = { campaign: Campaign; job: Job | null; event: Event | null };

type Owner = { orgId: string; userId: string };

/** The latest research job for the campaign's current brief version. */
export async function latestResearchJob(db: Prisma.TransactionClient, campaign: Pick<Campaign, "id" | "orgId" | "briefVersion">): Promise<Job | null> {
  return db.job.findFirst({
    where: { orgId: campaign.orgId, campaignId: campaign.id, kind: RESEARCH_JOB, briefVersion: campaign.briefVersion },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}

async function withResearch(db: PrismaClient, campaign: Campaign): Promise<CampaignRecord> {
  const job = await latestResearchJob(db, campaign);
  const event = job === null ? null : await findResearchCompletedForJob(db, { orgId: campaign.orgId, jobId: job.id });
  return { campaign, job, event };
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
  | "request_reused";

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
async function lockOwnCampaign(tx: Tx, input: ChangeInput): Promise<Campaign | null> {
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
  kind: typeof CAMPAIGN_BRIEF_CHANGED | typeof CAMPAIGN_RESEARCH_RETRIED,
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
async function advance(tx: Tx, campaign: Campaign, input: ResearchJobInput): Promise<{ campaign: Campaign; job: Job }> {
  const to = campaign.briefVersion + 1;
  const updated = await tx.campaign.updateMany({
    where: { id: campaign.id, orgId: campaign.orgId, ownerUserId: campaign.ownerUserId, briefVersion: campaign.briefVersion },
    data: { brief: input.brief as Prisma.InputJsonObject, briefVersion: to },
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
  kind: typeof CAMPAIGN_BRIEF_CHANGED | typeof CAMPAIGN_RESEARCH_RETRIED,
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

    const view = stateOf(await researchNow(tx, campaign));
    if (view.state === "researching") throw new CampaignChangeRefused("wrong_state");

    const brief = briefOf(campaign);
    if (sameBrief(brief, input.brief)) throw new CampaignChangeRefused("unchanged");

    const prior = await latestPack(tx, campaign);
    const jobInput = researchJobInputSchema.parse({ brief: input.brief, ...(prior === null ? {} : { priorPackIds: [prior] }) });
    const next = await advance(tx, campaign, jobInput);
    return {
      ...next,
      before: { briefVersion: campaign.briefVersion, brief: brief as Prisma.InputJsonObject },
      after: {
        briefVersion: next.campaign.briefVersion,
        brief: jobInput.brief as Prisma.InputJsonObject,
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
    if (job === null || event !== null || job.status !== "failed") throw new CampaignChangeRefused("wrong_state");
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
