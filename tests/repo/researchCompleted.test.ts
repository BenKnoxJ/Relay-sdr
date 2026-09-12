import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { toResearchBrief } from "@/lib/campaigns/brief";
import { prisma } from "@/lib/db";
import { enqueue } from "@/lib/jobs/queue";
import { createCampaign } from "@/lib/repo/campaigns";
import { mutate } from "@/lib/repo/mutate";
import { RESEARCH_COMPLETED, recordResearchCompleted } from "@/lib/repo/research";

import { emptyAll, resetDatabase } from "../db/harness";
import { briefFields } from "../lib/campaignPacks";

/**
 * A research job's completion Event carries the job's campaign
 * (`Event.campaignId`), so a campaign's timeline holds its research without a
 * JSON lookup, and a job with no campaign (the bench) files none. The pack
 * itself is not what is under test: any JSON stands in for it.
 */

const ORG = "org_research_completed";
const REP = "user_research_completed";

beforeAll(async () => {
  await resetDatabase();
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await emptyAll();
  await mutate(prisma, { orgId: ORG, actor: { kind: "system" }, kind: "org.created", apply: (tx) => tx.org.create({ data: { id: ORG, name: ORG } }) });
  await mutate(prisma, {
    orgId: ORG,
    actor: { kind: "system" },
    kind: "user.upserted",
    apply: (tx) => tx.user.create({ data: { id: REP, orgId: ORG, email: "rep@research-completed.test" } }),
  });
});

const complete = (jobId: string) =>
  recordResearchCompleted(prisma, {
    orgId: ORG,
    jobId,
    runId: "run_test",
    pack: { stand: "in" },
    report: {},
    facts: { product: "insights360", version: 2, hash: "test", draft: false },
    knowledge: { product: "insights360", version: 1, hash: "test" },
    partial: false,
    missingModules: [],
    outcome: "complete",
    scope: {},
  });

describe("recordResearchCompleted and the campaign", () => {
  it("@proof files a campaign's research on the campaign: the Event's campaignId is the job's", async () => {
    const { campaign, job } = await createCampaign(prisma, {
      orgId: ORG,
      userId: REP,
      startRequestId: randomUUID(),
      name: "Vets in Orkney",
      brief: toResearchBrief(briefFields()),
    });

    const { event } = await complete(job!.id);

    expect(event.campaignId).toBe(campaign.id);
    expect(event.campaignId).toBe(job!.campaignId);
    // The campaign's timeline, by the indexed column alone: started, then researched.
    const timeline = await prisma.event.findMany({ where: { orgId: ORG, campaignId: campaign.id }, orderBy: { at: "asc" } });
    expect(timeline.map((e) => e.kind)).toEqual(["campaign.created", RESEARCH_COMPLETED]);
  });

  it("@proof leaves a job with no campaign (the bench) filed on no campaign", async () => {
    const { job } = await enqueue(prisma, { orgId: ORG, kind: "research", idempotencyKey: "bench-job", input: {} });
    expect(job.campaignId).toBeNull();

    const { event } = await complete(job.id);
    expect(event.campaignId).toBeNull();
  });

  it("returns the first, linked Event to a retried completion and writes no second", async () => {
    const { campaign, job } = await createCampaign(prisma, {
      orgId: ORG,
      userId: REP,
      startRequestId: randomUUID(),
      name: "Vets in Orkney",
      brief: toResearchBrief(briefFields()),
    });

    const first = await complete(job!.id);
    const again = await complete(job!.id);

    expect(again).toMatchObject({ duplicate: true, event: { id: first.event.id, campaignId: campaign.id } });
    expect(await prisma.event.count({ where: { kind: RESEARCH_COMPLETED } })).toBe(1);
  });
});
