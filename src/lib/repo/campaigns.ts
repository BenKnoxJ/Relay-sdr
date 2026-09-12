import { randomUUID } from "node:crypto";

import type { Campaign, Event, Job, Prisma, PrismaClient } from "@prisma/client";

import { enqueue } from "@/lib/jobs/queue";

import { mutate } from "./mutate";
import { findResearchCompletedForJob } from "./research";
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

  // Minted here rather than by the database, because the Event names the
  // campaign and `mutate` writes the Event from what it was handed.
  const id = randomUUID();
  try {
    const { campaign, job } = await mutate(db, {
      orgId: input.orgId,
      actor: { kind: "user", userId: input.userId },
      kind: CAMPAIGN_CREATED,
      campaignId: id,
      after: { name: input.name, briefVersion: 1, brief: input.brief, startRequestId: input.startRequestId },
      apply: async (tx) => {
        // The campaign first, so a repeated press fails on its unique index
        // before a job is even attempted.
        const campaign = await tx.campaign.create({
          data: {
            id,
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
          idempotencyKey: researchJobKey(id, 1),
          input: { brief: input.brief },
          campaignId: id,
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
export async function latestResearchJob(db: PrismaClient, campaign: Pick<Campaign, "id" | "orgId" | "briefVersion">): Promise<Job | null> {
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
