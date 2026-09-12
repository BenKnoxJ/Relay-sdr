import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { toResearchBrief } from "@/lib/campaigns/brief";
import { prisma } from "@/lib/db";
import { enqueue } from "@/lib/jobs/queue";
import {
  CAMPAIGN_CREATED,
  RESEARCH_JOB,
  createCampaign,
  getCampaignForOwner,
  hasCampaign,
  latestResearchJob,
  listCampaignsForOwner,
  researchJobKey,
} from "@/lib/repo/campaigns";
import { mutate } from "@/lib/repo/mutate";

import { emptyAll, resetDatabase } from "../db/harness";
import { briefFields } from "../lib/campaignPacks";

/**
 * Starting a campaign (§25 rules 2 and 4): the campaign, its Event and its
 * first research job commit together or not at all, and a second press of
 * Start is the same campaign.
 */

const ORG = "org_campaigns";
const OTHER_ORG = "org_campaigns_other";
const REP = "user_rep";
const COLLEAGUE = "user_colleague";
const STRANGER = "user_stranger";

beforeAll(async () => {
  await resetDatabase();
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await emptyAll();
  for (const id of [ORG, OTHER_ORG]) {
    await mutate(prisma, { orgId: id, actor: { kind: "system" }, kind: "org.created", apply: (tx) => tx.org.create({ data: { id, name: id } }) });
  }
  for (const [orgId, id] of [[ORG, REP], [ORG, COLLEAGUE], [OTHER_ORG, STRANGER]] as const) {
    await mutate(prisma, {
      orgId,
      actor: { kind: "system" },
      kind: "user.upserted",
      apply: (tx) => tx.user.create({ data: { id, orgId, email: `${id}@example.test` } }),
    });
  }
});

const brief = () => toResearchBrief(briefFields());

const start = (over: { userId?: string; orgId?: string; startRequestId?: string } = {}) =>
  createCampaign(prisma, {
    orgId: over.orgId ?? ORG,
    userId: over.userId ?? REP,
    startRequestId: over.startRequestId ?? randomUUID(),
    name: "Vets in Orkney",
    brief: brief(),
  });

describe("createCampaign", () => {
  it("writes the campaign, one Event and the research job for version 1, together", async () => {
    const { campaign, job, created } = await start();

    expect(created).toBe(true);
    // Relay's id convention: a cuid, like every other table's.
    expect(campaign.id).toMatch(/^c[a-z0-9]{24}$/);
    expect(campaign).toMatchObject({ orgId: ORG, ownerUserId: REP, name: "Vets in Orkney", briefVersion: 1, brief: brief() });

    const events = await prisma.event.findMany({ where: { orgId: ORG, kind: CAMPAIGN_CREATED } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ campaignId: campaign.id, actorKind: "user", actorUserId: REP });
    expect(events[0]!.after).toMatchObject({ name: "Vets in Orkney", briefVersion: 1, brief: brief() });

    expect(job).toMatchObject({
      orgId: ORG,
      ownerUserId: REP,
      kind: RESEARCH_JOB,
      status: "queued",
      idempotencyKey: researchJobKey(campaign.id, 1),
      campaignId: campaign.id,
      briefVersion: 1,
      // Research's job input, and nothing the handler's strict schema would refuse.
      input: { brief: brief() },
    });
    expect(await prisma.job.count()).toBe(1);
  });

  it("@proof makes one campaign of a second press of Start, and writes nothing the second time", async () => {
    const startRequestId = randomUUID();
    const first = await start({ startRequestId });
    const again = await start({ startRequestId });

    expect(again).toMatchObject({ created: false, job: null, campaign: { id: first.campaign.id } });
    expect(await prisma.campaign.count()).toBe(1);
    expect(await prisma.event.count({ where: { kind: CAMPAIGN_CREATED } })).toBe(1);
    expect(await prisma.job.count()).toBe(1);
  });

  it("@proof makes one campaign of two presses at once", async () => {
    const startRequestId = randomUUID();
    const results = await Promise.all([start({ startRequestId }), start({ startRequestId })]);

    expect(new Set(results.map((result) => result.campaign.id)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(await prisma.campaign.count()).toBe(1);
    expect(await prisma.job.count()).toBe(1);
  });

  it("does not hand one rep another rep's campaign for a reused request id", async () => {
    const startRequestId = randomUUID();
    await start({ startRequestId });
    await expect(start({ startRequestId, userId: COLLEAGUE })).rejects.toThrow();
    expect(await prisma.campaign.count()).toBe(1);
  });

  it("@proof leaves nothing behind when the research job cannot be enqueued", async () => {
    // A rep from another org: the campaign row's foreign key accepts the user,
    // and `enqueue`'s tenant check refuses it, inside the same transaction.
    await expect(start({ userId: STRANGER })).rejects.toThrow("ownerUserId is not a user of this org");

    expect(await prisma.campaign.count()).toBe(0);
    expect(await prisma.event.count({ where: { kind: CAMPAIGN_CREATED } })).toBe(0);
    expect(await prisma.job.count()).toBe(0);
  });
});

describe("reading campaigns", () => {
  it("lists the rep's own campaigns, newest first, and nobody else's", async () => {
    const older = await start();
    const newer = await start();
    await start({ userId: COLLEAGUE });

    const mine = await listCampaignsForOwner(prisma, { orgId: ORG, userId: REP });
    expect(mine.map((record) => record.campaign.id)).toEqual([newer.campaign.id, older.campaign.id]);
    expect(mine.every((record) => record.job?.briefVersion === 1 && record.event === null)).toBe(true);
  });

  it("reads one campaign only for its owner, in its org", async () => {
    const { campaign } = await start();

    expect((await getCampaignForOwner(prisma, { orgId: ORG, userId: REP, id: campaign.id }))?.campaign.id).toBe(campaign.id);
    expect(await getCampaignForOwner(prisma, { orgId: ORG, userId: COLLEAGUE, id: campaign.id })).toBeNull();
    expect(await getCampaignForOwner(prisma, { orgId: OTHER_ORG, userId: STRANGER, id: campaign.id })).toBeNull();
    expect(await getCampaignForOwner(prisma, { orgId: ORG, userId: REP, id: "missing" })).toBeNull();
  });

  it("takes the latest research job at the campaign's current brief version", async () => {
    const { campaign, job } = await start();
    // A second attempt at version 1, made the way a later retry would be.
    const { job: later } = await enqueue(prisma, {
      orgId: ORG,
      ownerUserId: REP,
      kind: RESEARCH_JOB,
      idempotencyKey: `${researchJobKey(campaign.id, 1)}:later`,
      input: { brief: brief() },
      campaignId: campaign.id,
      briefVersion: 1,
    });

    expect((await latestResearchJob(prisma, campaign))?.id).toBe(later.id);
    expect(later.id).not.toBe(job?.id);
  });

  it("says whether the rep has a campaign at all", async () => {
    expect(await hasCampaign(prisma, { orgId: ORG, userId: REP })).toBe(false);
    await start();
    expect(await hasCampaign(prisma, { orgId: ORG, userId: REP })).toBe(true);
    expect(await hasCampaign(prisma, { orgId: ORG, userId: COLLEAGUE })).toBe(false);
  });
});
