import { randomUUID } from "node:crypto";

import type { Campaign as CampaignRow, Job, Prisma } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { nameFrom, toResearchBrief } from "@/lib/campaigns/brief";
import { stageLineOf } from "@/lib/campaigns/stageLine";
import { summaryFactsOf } from "@/lib/campaigns/summary";
import { toCampaign, toCampaignResearch } from "@/lib/campaigns/view";
import { campaignsCopy } from "@/lib/copy/campaigns";
import { prisma } from "@/lib/db";
import { NO_CRM } from "@/lib/leadgen/crm";
import { FakeLeadGenProvider, type FakeStep } from "@/lib/leadgen/fakeProvider";
import type { ProviderCandidate } from "@/lib/leadgen/provider";
import type { LeadGenSetup } from "@/lib/leadgen/setup";
import { DOCUMENTED_UNVERIFIED_PRICING } from "@/lib/leadgen/spend";
import {
  CAMPAIGN_CREATED,
  CAMPAIGN_PLAYS_CHOSEN,
  CampaignChangeRefused,
  RESEARCH_JOB,
  confirmCampaign,
  createCampaign,
  createPlayCampaigns,
  editCampaignBrief,
  getCampaignForOwner,
  latestResearchJob,
  listCampaignsForOwner,
  reviewPeople,
  type ChangeRefusal,
} from "@/lib/repo/campaigns";
import { campaignSummariesForOwner } from "@/lib/repo/campaignSummary";
import { LEAD_GEN_JOB, findConfirmEvent, handoffOf, loadOrgKnowledge } from "@/lib/repo/leadgen";
import { mutate } from "@/lib/repo/mutate";
import { recordResearchCompleted } from "@/lib/repo/research";
import { leadGenHandler } from "@/worker/handlers/leadGen";

import { emptyAll, resetDatabase } from "../db/harness";
import { briefFields, completePack } from "../lib/campaignPacks";
import { NO_WAIT, ROLE_TITLES, VOCABULARY, candidate } from "./harness";

/**
 * One campaign per play (Relay P1), on the real database with a scripted
 * provider: ticked plays become campaigns on one research, each confirms its
 * own play, a repeat press is the same press, nothing crosses an org or a rep,
 * and a person kept or revealed in one campaign is held in another.
 */

const ORG = "org_plays_a";
const OTHER_ORG = "org_plays_b";
const REP = "user_plays_a";
const COLLEAGUE = "user_plays_colleague";
const REP_B = "user_plays_b";

// The fixture pack's three plays, all searchable, in research's order.
const CLAIMS = "candidate-claims-teams";
const BROKERS = "candidate-regional-brokers";
const MGAS = "candidate-delegated-mgas";

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
  for (const [orgId, id] of [[ORG, REP], [ORG, COLLEAGUE], [OTHER_ORG, REP_B]] as const) {
    await mutate(prisma, { orgId, actor: { kind: "system" }, kind: "user.upserted", apply: (tx) => tx.user.create({ data: { id, orgId, email: `${id}@example.test` } }) });
  }
});

/** A campaign whose research finished with the fixture plan, written as the research handler writes it. */
async function planned(orgId = ORG, userId = orgId === ORG ? REP : REP_B): Promise<CampaignRow> {
  const brief = toResearchBrief(briefFields());
  const { campaign, job } = await createCampaign(prisma, { orgId, userId, startRequestId: randomUUID(), name: nameFrom(brief.who), brief: brief as Prisma.InputJsonObject });
  if (job === null) throw new Error("tests: a fresh start made no job");
  const pack = completePack();
  await recordResearchCompleted(prisma, {
    orgId,
    jobId: job.id,
    runId: "run_test",
    pack: JSON.parse(JSON.stringify(pack)),
    report: {},
    facts: { product: "insights360", version: 2, hash: "test", draft: false },
    knowledge: { product: "insights360", version: 1, hash: "test" },
    partial: pack.partial,
    missingModules: [...pack.missingModules],
    outcome: "complete",
    scope: JSON.parse(JSON.stringify(pack.scope ?? {})),
  });
  await prisma.job.update({ where: { id: job.id }, data: { status: "done" } });
  return campaign;
}

function setup(): LeadGenSetup {
  return {
    sample: true,
    searchCreditCap: 40,
    pricingAssumptions: DOCUMENTED_UNVERIFIED_PRICING.id,
    pricing: DOCUMENTED_UNVERIFIED_PRICING,
    readBalance: async () => ({ remaining: 100, readAt: new Date(Date.now() - 60_000), source: "sample" }),
    environment: async () => {
      throw new Error("tests hand the handler its provider");
    },
    revealer: () => {
      throw new Error("tests hand the handler its provider");
    },
  };
}

const create = (campaign: CampaignRow, playIds: string[], over: { requestId?: string; userId?: string; orgId?: string; from?: number } = {}) =>
  createPlayCampaigns(prisma, {
    orgId: over.orgId ?? campaign.orgId,
    userId: over.userId ?? campaign.ownerUserId,
    campaignId: campaign.id,
    fromBriefVersion: over.from ?? campaign.briefVersion,
    requestId: over.requestId ?? randomUUID(),
    playIds,
  });

const confirm = (campaign: CampaignRow, candidateId?: string) =>
  confirmCampaign(prisma, {
    orgId: campaign.orgId,
    userId: campaign.ownerUserId,
    campaignId: campaign.id,
    fromBriefVersion: campaign.briefVersion,
    requestId: randomUUID(),
    ...(candidateId === undefined ? {} : { candidateId }),
    setup: setup(),
  });

async function refusalOf(promise: Promise<unknown>): Promise<ChangeRefusal | "ok"> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (error instanceof CampaignChangeRefused) return error.refusal;
    throw error;
  }
}

const view = async (campaign: CampaignRow) => {
  const record = await getCampaignForOwner(prisma, { orgId: campaign.orgId, userId: campaign.ownerUserId, id: campaign.id });
  if (record === null) throw new Error("tests: campaign not found");
  return toCampaign(record, { available: true, searchCreditCap: 40, sample: true });
};

const confirmedPlay = async (campaign: CampaignRow) => {
  const handoff = handoffOf((await findConfirmEvent(prisma, { orgId: campaign.orgId, campaignId: campaign.id, briefVersion: campaign.briefVersion }))!);
  return handoff.version === 2 ? handoff.play.id : null;
};

describe("Create campaigns from ticked plays", () => {
  it("@proof makes one campaign per ticked play on the one research: no second research job and no second research cost", async () => {
    const source = await planned();
    const { campaigns, repeated } = await create(source, [BROKERS, CLAIMS]);

    expect(repeated).toBe(false);
    expect(campaigns).toHaveLength(2);
    const [kept, made] = campaigns;
    // Research's order, not the order ticked: the first ticked play in research's order stays on this campaign.
    expect(kept).toMatchObject({ id: source.id, playId: CLAIMS, name: "The claims teams", researchFromCampaignId: null });
    expect(made).toMatchObject({ playId: BROKERS, name: "The regional brokers", briefVersion: 1, researchFromCampaignId: source.id, researchFromBriefVersion: 1 });
    expect(made!.brief).toEqual(source.brief);

    // One research job in the org, and both campaigns read it.
    expect(await prisma.job.count({ where: { orgId: ORG, kind: RESEARCH_JOB } })).toBe(1);
    const research = await latestResearchJob(prisma, source);
    expect((await latestResearchJob(prisma, made!))?.id).toBe(research?.id);
    // The research's cost is the source's alone.
    const records = await listCampaignsForOwner(prisma, { orgId: ORG, userId: REP });
    expect(records.find((record) => record.campaign.id === made!.id)?.researchCost).toEqual([]);

    // Events: the choice on the source, and a created Event for the new campaign.
    expect(await prisma.event.findFirst({ where: { campaignId: source.id, kind: CAMPAIGN_PLAYS_CHOSEN } })).toMatchObject({ actorUserId: REP });
    expect(await prisma.event.findFirst({ where: { campaignId: made!.id, kind: CAMPAIGN_CREATED } })).toMatchObject({
      after: { playId: BROKERS, researchFrom: { campaignId: source.id, briefVersion: 1 } },
    });
  });

  it("@proof shows each campaign its own play on Plan ready, in the list as well as on the page", async () => {
    const source = await planned();
    const { campaigns } = await create(source, [CLAIMS, BROKERS, MGAS]);
    expect(campaigns.map((campaign) => campaign.playId)).toEqual([CLAIMS, BROKERS, MGAS]);

    for (const campaign of campaigns) {
      const page = await view(campaign);
      expect(page.state).toBe("planReady");
      expect(page.plays?.map((play) => play.id)).toEqual([campaign.playId]);
      expect(page.canCreatePlays).toBe(false);
    }
    const summaries = await campaignSummariesForOwner(prisma, { orgId: ORG, userId: REP }, { leadGenAvailable: true });
    expect(summaries).toHaveLength(3);
    // Every row reads the one plan: done research, a complete outcome, and the plays it ranked.
    for (const summary of summaries) {
      expect(summary.input.stage.research.job?.status).toBe("done");
      expect(summary.input.research).toMatchObject({ outcome: "complete", viablePlays: 3 });
    }
    // Each row names its own play, not "3 plays found"; the page's line says the same.
    for (const campaign of campaigns) {
      const page = await view(campaign);
      const line = `${campaignsCopy.summaryPlayFor} ${page.plays?.[0]?.group.name}`;
      expect(stageLineOf(summaryFactsOf(summaries.find((summary) => summary.campaign.id === campaign.id)!.input).facts)).toBe(line);
      expect(stageLineOf(page.facts!)).toBe(line);
    }
    // A campaign with no play chosen still counts what research found.
    const unmade = await planned();
    const row = (await campaignSummariesForOwner(prisma, { orgId: ORG, userId: REP }, { leadGenAvailable: true })).find((summary) => summary.campaign.id === unmade.id)!;
    expect(stageLineOf(summaryFactsOf(row.input).facts)).toBe(`3 ${campaignsCopy.summaryPlays}`);
  });

  it("offers the tick boxes only on the campaign research ran on, before a play is chosen", async () => {
    const source = await planned();
    expect((await view(source)).canCreatePlays).toBe(true);
    expect((await view(source)).plays).toHaveLength(3);
    await create(source, [CLAIMS]);
    // One ticked play: this campaign takes it, and nothing new is made.
    expect(await prisma.campaign.count({ where: { orgId: ORG } })).toBe(1);
    expect((await view(source)).canCreatePlays).toBe(false);
  });

  it("@proof confirms each campaign for its own play, and refuses another play on a campaign made for one", async () => {
    const source = await planned();
    const [kept, made] = (await create(source, [CLAIMS, BROKERS])).campaigns;

    expect(await refusalOf(confirm(made!, MGAS))).toBe("unknown_candidate");
    await confirm(kept!);
    await confirm(made!);
    expect(await confirmedPlay(kept!)).toBe(CLAIMS);
    expect(await confirmedPlay(made!)).toBe(BROKERS);
    const confirms = await prisma.event.findMany({ where: { kind: "campaign.confirmed", campaignId: { in: [kept!.id, made!.id] } } });
    expect(confirms.map((event) => (event.after as { selection?: string }).selection)).toEqual(["chosen", "chosen"]);
    // Each has its own lead gen job under its own campaign.
    expect(await prisma.job.count({ where: { kind: LEAD_GEN_JOB, campaignId: made!.id } })).toBe(1);
    expect((await view(made!)).state).toBe("findingPeople");
  });

  it("leaves Confirm on a campaign that never chose plays exactly as it was: research's first play, or the one named", async () => {
    const first = await planned();
    await confirm(first);
    expect(await confirmedPlay(first)).toBe(CLAIMS);
    expect((await prisma.event.findFirstOrThrow({ where: { kind: "campaign.confirmed", campaignId: first.id } })).after).toMatchObject({ selection: "default" });

    const named = await planned();
    await confirm(named, MGAS);
    expect(await confirmedPlay(named)).toBe(MGAS);
  });

  it("@proof answers a repeated or doubled press with the campaigns the first made, and makes none twice", async () => {
    const source = await planned();
    const requestId = randomUUID();
    const [a, b] = await Promise.all([create(source, [CLAIMS, BROKERS, MGAS], { requestId }), create(source, [CLAIMS, BROKERS, MGAS], { requestId })]);
    const later = await create(source, [CLAIMS, BROKERS, MGAS], { requestId });

    expect([a.repeated, b.repeated].sort()).toEqual([false, true]);
    expect(later.repeated).toBe(true);
    const ids = a.campaigns.map((campaign) => campaign.id).sort();
    expect(b.campaigns.map((campaign) => campaign.id).sort()).toEqual(ids);
    expect(later.campaigns.map((campaign) => campaign.id).sort()).toEqual(ids);
    expect(await prisma.campaign.count({ where: { orgId: ORG } })).toBe(3);
    expect(await prisma.event.count({ where: { kind: CAMPAIGN_PLAYS_CHOSEN } })).toBe(1);
    // The same request id for a different choice is not a repeat of it.
    expect(await refusalOf(create(source, [CLAIMS], { requestId }))).toBe("request_reused");
  });

  it("@proof lets no other rep and no other org use a campaign as the research for theirs", async () => {
    const source = await planned();
    expect(await refusalOf(create(source, [CLAIMS, BROKERS], { userId: COLLEAGUE }))).toBe("not_found");
    expect(await refusalOf(create(source, [CLAIMS, BROKERS], { userId: REP_B, orgId: OTHER_ORG }))).toBe("not_found");
    expect(await prisma.campaign.count()).toBe(1);
    expect(await prisma.event.count({ where: { kind: CAMPAIGN_PLAYS_CHOSEN } })).toBe(0);

    // And a campaign in another org that names this one as its source reads nothing through it.
    const foreign = await prisma.campaign.create({
      data: { orgId: OTHER_ORG, ownerUserId: REP_B, name: "Foreign", brief: source.brief as Prisma.InputJsonObject, startRequestId: randomUUID(), researchFromCampaignId: source.id, researchFromBriefVersion: 1, playId: CLAIMS },
    });
    expect(await latestResearchJob(prisma, foreign)).toBeNull();
    expect((await view(foreign)).plays ?? null).toBeNull();
  });

  it("refuses a play research did not rank, a stale page, a second choice, and a campaign already confirmed", async () => {
    const source = await planned();
    expect(await refusalOf(create(source, ["candidate-nobody"]))).toBe("unknown_candidate");
    expect(await refusalOf(create(source, []))).toBe("unknown_candidate");
    expect(await refusalOf(create(source, [CLAIMS], { from: 2 }))).toBe("version_ahead");

    const [, made] = (await create(source, [CLAIMS, BROKERS])).campaigns;
    expect(await refusalOf(create(source, [MGAS]))).toBe("wrong_state");
    expect(await refusalOf(create(made!, [MGAS]))).toBe("wrong_state");

    const confirmed = await planned();
    await confirm(confirmed);
    expect(await refusalOf(create(confirmed, [BROKERS, MGAS]))).toBe("wrong_state");
  });

  it("@proof shows a made campaign its own play, not research's top one: Start with, the pain, and the research page", async () => {
    const source = await planned();
    const [kept, made] = (await create(source, [BROKERS, MGAS])).campaigns;
    // Research's top play is neither of these.
    const topName = (await view(await planned())).overview?.startWith?.groupName;

    for (const [campaign, playId] of [[made!, MGAS], [kept!, BROKERS]] as const) {
      const shown = await view(campaign);
      const name = shown.plays?.find((play) => play.id === playId)?.group.name;
      expect(name).toBeDefined();
      expect(name).not.toBe(topName);
      expect(shown.overview?.startWith?.groupName).toBe(name);
      expect(shown.overview?.pain?.groupName).toBe(name);
      expect(shown.confirmPlan?.groupName).toBe(name);
      const record = await getCampaignForOwner(prisma, { orgId: ORG, userId: REP, id: campaign.id });
      expect(toCampaignResearch(record!).summary?.startWith?.groupName).toBe(name);
    }
  });

  it("surfaces a unique violation on anything but a play's start request id, and creates nothing", async () => {
    const source = await planned();
    // A second campaign.created in this org now clashes: the source's own creation wrote the first.
    await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX test_only_one_created_per_org ON events (org_id, kind) WHERE kind = 'campaign.created'`);
    try {
      const error = await create(source, [CLAIMS, BROKERS]).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect((error as { code?: string } | null)?.code).toBe("P2002");
    } finally {
      await prisma.$executeRawUnsafe(`DROP INDEX test_only_one_created_per_org`);
    }
    expect(await prisma.campaign.count({ where: { orgId: ORG } })).toBe(1);
    expect(await prisma.campaign.findUniqueOrThrow({ where: { id: source.id } })).toMatchObject({ playId: null, name: source.name });
  });

  it("treats a clash on a play's start request id as the press that landed", async () => {
    const source = await planned();
    const requestId = randomUUID();
    // The row a landed press made, without the Event that would have stopped this press earlier.
    const landed = await prisma.campaign.create({
      data: { orgId: ORG, ownerUserId: REP, name: "landed", brief: source.brief as Prisma.InputJsonObject, startRequestId: `plays:${requestId}:${BROKERS}`, researchFromCampaignId: source.id, researchFromBriefVersion: 1, playId: BROKERS },
    });
    const { campaigns, repeated } = await create(source, [CLAIMS, BROKERS], { requestId });
    expect(repeated).toBe(true);
    expect(campaigns.map((campaign) => campaign.id)).toEqual([source.id, landed.id]);
  });

  it("runs research of its own once a made campaign's brief is edited, reading the plan it came from, and the play is chosen again", async () => {
    const source = await planned();
    const [, made] = (await create(source, [CLAIMS, BROKERS])).campaigns;
    const plan = await prisma.event.findFirstOrThrow({ where: { campaignId: source.id, kind: "research.completed" } });
    const edited = await editCampaignBrief(prisma, {
      orgId: ORG,
      userId: REP,
      campaignId: made!.id,
      fromBriefVersion: 1,
      requestId: randomUUID(),
      brief: toResearchBrief(briefFields({ howMany: 50 })),
    });
    expect(edited.job).toMatchObject({ campaignId: made!.id, briefVersion: 2 });
    expect((edited.job?.input as { priorPackIds?: string[] }).priorPackIds).toEqual([plan.id]);
    expect((await latestResearchJob(prisma, edited.campaign))?.id).toBe(edited.job?.id);
    expect(edited.campaign.playId).toBeNull();
    expect(await prisma.event.findFirstOrThrow({ where: { campaignId: made!.id, kind: "campaign.brief_changed" } })).toMatchObject({ before: { playId: BROKERS } });
  });
});

describe("a person already in another campaign (Relay P1)", () => {
  const page = (candidates: ProviderCandidate[]): FakeStep => ({ candidates, charged: candidates.length, hasMore: false });
  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => candidate(from + index, { title: ROLE_TITLES[(from + index) % ROLE_TITLES.length] }));
  const leadGenJob = (campaignId: string) => prisma.job.findFirstOrThrow({ where: { campaignId, kind: LEAD_GEN_JOB }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });

  async function run(job: Job, steps: FakeStep[]) {
    const provider = new FakeLeadGenProvider(steps);
    await leadGenHandler({ environment: () => ({ provider, vocabulary: VOCABULARY }), crm: NO_CRM, retry: NO_WAIT })({ db: prisma, job: { ...job, attempts: 1 }, signal: new AbortController().signal });
  }

  /** Two campaigns from one plan, the first with people found and one of them kept. */
  async function keptInFirst(providerId: string) {
    const source = await planned();
    const [a, b] = (await create(source, [CLAIMS, BROKERS])).campaigns;
    await confirm(a!);
    await run(await leadGenJob(a!.id), [page(range(1, 12))]);
    const row = await prisma.campaignPerson.findFirstOrThrow({ where: { campaignId: a!.id, providerId } });
    await reviewPeople(prisma, { orgId: ORG, userId: REP, campaignId: a!.id, briefVersion: 1, personId: row.id, scope: "person", decision: "kept" });
    await confirm(b!);
    return { a: a!, b: b!, row };
  }

  it("@proof holds someone kept in one campaign when another campaign's lead gen finds them, by provider record", async () => {
    const { b } = await keptInFirst("l-001");
    await run(await leadGenJob(b.id), [page(range(1, 12))]);

    expect(await prisma.campaignPerson.count({ where: { campaignId: b.id, providerId: "l-001" } })).toBe(0);
    expect(await prisma.campaignPerson.count({ where: { campaignId: b.id, providerId: "l-002" } })).toBe(1);
    const found = (await view(b)).peopleFound;
    expect(found?.inOtherCampaign).toBe(1);
    expect(found?.onHold).toBe(1);
  });

  it("@proof holds the same human reached through another provider record, by Person", async () => {
    const { b, row } = await keptInFirst("l-001");
    // Revealed in the first campaign: the human is a Person, and l-005 is another record of them.
    const person = await prisma.person.create({ data: { orgId: ORG, email: "person.1@firm1.co.uk", emailType: "work", grade: "A", name: "Person 1" } });
    await prisma.campaignPerson.update({ where: { id: row.id }, data: { personId: person.id, reveal: "revealed", revealedAt: new Date() } });
    await prisma.providerIdentity.create({ data: { orgId: ORG, provider: "lusha", providerId: "l-005", personId: person.id, status: "usable" } });

    await run(await leadGenJob(b.id), [page(range(1, 12))]);
    expect(await prisma.campaignPerson.count({ where: { campaignId: b.id, providerId: { in: ["l-001", "l-005"] } } })).toBe(0);
    expect((await view(b)).peopleFound?.inOtherCampaign).toBe(2);
  });

  it("@proof counts each other campaign's current brief version only: a superseded version holds no one", async () => {
    const { a, b } = await keptInFirst("l-001");
    expect((await loadOrgKnowledge(prisma, { orgId: ORG, campaignId: b.id, briefVersion: 1 })).inOtherCampaigns).toHaveLength(1);

    // The first campaign's brief is edited: its kept person stays on version 1, which is no longer live work.
    await editCampaignBrief(prisma, { orgId: ORG, userId: REP, campaignId: a.id, fromBriefVersion: 1, requestId: randomUUID(), brief: toResearchBrief(briefFields({ howMany: 50 })) });
    expect(await prisma.campaignPerson.count({ where: { campaignId: a.id, briefVersion: 1, providerId: "l-001", review: "kept" } })).toBe(1);
    expect((await loadOrgKnowledge(prisma, { orgId: ORG, campaignId: b.id, briefVersion: 1 })).inOtherCampaigns).toEqual([]);

    await run(await leadGenJob(b.id), [page(range(1, 12))]);
    expect(await prisma.campaignPerson.count({ where: { campaignId: b.id, providerId: "l-001" } })).toBe(1);
    expect((await view(b)).peopleFound?.inOtherCampaign).toBe(0);
  });

  it("does not hold someone only found, never kept or revealed, elsewhere; nor in another org", async () => {
    const source = await planned();
    const [a, b] = (await create(source, [CLAIMS, BROKERS])).campaigns;
    await confirm(a!);
    await run(await leadGenJob(a!.id), [page(range(1, 12))]);
    await confirm(b!);
    await run(await leadGenJob(b!.id), [page(range(1, 12))]);
    expect(await prisma.campaignPerson.count({ where: { campaignId: b!.id, providerId: "l-001" } })).toBe(1);

    // Another org's kept person is not this org's knowledge.
    const other = await planned(OTHER_ORG);
    await confirm(other);
    await run(await leadGenJob(other.id), [page(range(1, 12))]);
    const theirs = await prisma.campaignPerson.findFirstOrThrow({ where: { campaignId: other.id, providerId: "l-001" } });
    await reviewPeople(prisma, { orgId: OTHER_ORG, userId: REP_B, campaignId: other.id, briefVersion: 1, personId: theirs.id, scope: "person", decision: "kept" });
    const knowledge = await loadOrgKnowledge(prisma, { orgId: ORG, campaignId: b!.id, briefVersion: 1 });
    expect(knowledge.inOtherCampaigns).toEqual([]);
  });
});
