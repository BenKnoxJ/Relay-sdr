import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { nameFrom, toResearchBrief } from "@/lib/campaigns/brief";
import { prisma } from "@/lib/db";
import { claimNext, complete } from "@/lib/jobs/queue";
import { createCampaign } from "@/lib/repo/campaigns";
import type { Session } from "@/server/auth/session";
import { ensureUser, type Actor } from "@/server/auth/upsertUser";

import { emptyAll, resetDatabase } from "../db/harness";
import { briefFields } from "../lib/campaignPacks";

/**
 * Trial fix 1 (25 Sep 2026): a worker drafts several people at once now, but never two colleagues at the same
 * account at the same moment. Each draft reads what its colleagues were already sent, so that it quotes
 * something else; drafted side by side, neither would see the other. The claim skips a draft job while a
 * colleague's is running, and takes the next one instead.
 */

beforeAll(async () => {
  await resetDatabase();
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await emptyAll();
});

const session: Session = { clerkId: "user_claim", profile: async () => ({ email: "rep@example.test", name: "Sam Carter" }) };

let serial = 0;

async function campaignFor(actor: Actor): Promise<{ campaignId: string; leadGenJobId: string }> {
  const brief = toResearchBrief(briefFields());
  const { campaign } = await createCampaign(prisma, { orgId: actor.orgId, userId: actor.userId, startRequestId: randomUUID(), name: nameFrom(brief.who), brief: brief as Prisma.InputJsonObject });
  // Starting a campaign queues its research; that job is not what these tests claim.
  await prisma.job.updateMany({ where: { campaignId: campaign.id, status: "queued" }, data: { status: "done" } });
  const job = await prisma.job.create({ data: { orgId: actor.orgId, ownerUserId: actor.userId, kind: "lead_gen", idempotencyKey: `test:${randomUUID()}`, input: {}, status: "done", campaignId: campaign.id, briefVersion: 1 } });
  return { campaignId: campaign.id, leadGenJobId: job.id };
}

/** A person at `companyKey`, and a queued draft job for them. Jobs are created in call order, so the oldest is claimed first. */
async function draftJobFor(actor: Actor, campaign: { campaignId: string; leadGenJobId: string }, companyKey: string): Promise<string> {
  serial += 1;
  const row = await prisma.campaignPerson.create({
    data: {
      orgId: actor.orgId,
      campaignId: campaign.campaignId,
      briefVersion: 1,
      jobId: campaign.leadGenJobId,
      provider: "lusha",
      providerId: `lusha-${serial}`,
      status: "chosen",
      source: "bought",
      rank: serial,
      score: 80,
      whyPicked: "fits",
      companyKey,
      preview: { name: `Person ${serial}`, company: companyKey },
    },
  });
  const job = await prisma.job.create({
    data: {
      orgId: actor.orgId,
      ownerUserId: actor.userId,
      kind: "outreach_draft",
      idempotencyKey: `draft:${randomUUID()}`,
      input: { requestId: randomUUID(), campaignPersonId: row.id, attempt: 1 },
      campaignId: campaign.campaignId,
      briefVersion: 1,
      createdAt: new Date(Date.now() - 60_000 + serial * 1_000),
      nextAt: new Date(Date.now() - 60_000),
    },
  });
  return job.id;
}

describe("claiming draft jobs for colleagues at one account", () => {
  it("never runs two colleagues' drafts at once, and runs the next colleague once the first is done", async () => {
    const actor = await ensureUser(prisma, session);
    const campaign = await campaignFor(actor);
    const harbourOne = await draftJobFor(actor, campaign, "harbour");
    const harbourTwo = await draftJobFor(actor, campaign, "harbour");
    const kestrel = await draftJobFor(actor, campaign, "kestrel");

    const first = await claimNext(prisma, "worker-a");
    expect(first?.id).toBe(harbourOne);
    // The second Harbour job is older than Kestrel's, and waits: its colleague is running.
    const second = await claimNext(prisma, "worker-a");
    expect(second?.id).toBe(kestrel);
    expect(await claimNext(prisma, "worker-b")).toBeNull();

    await complete(prisma, first!, { responseDigest: "x" });
    expect((await claimNext(prisma, "worker-a"))?.id).toBe(harbourTwo);
  });

  it("keeps other kinds, and colleagues in another campaign, out of it", async () => {
    const actor = await ensureUser(prisma, session);
    const one = await campaignFor(actor);
    const two = await campaignFor(actor);
    const running = await draftJobFor(actor, one, "harbour");
    const otherCampaign = await draftJobFor(actor, two, "harbour");
    const sleep = await prisma.job.create({ data: { orgId: actor.orgId, kind: "sleep", idempotencyKey: `sleep:${randomUUID()}`, input: { ms: 1 } } });

    expect((await claimNext(prisma, "worker-a"))?.id).toBe(running);
    const next = new Set([(await claimNext(prisma, "worker-a"))?.id, (await claimNext(prisma, "worker-a"))?.id]);
    expect(next).toEqual(new Set([otherCampaign, sleep.id]));
  });
});
