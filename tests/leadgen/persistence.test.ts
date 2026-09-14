import { randomUUID } from "node:crypto";

import type { Campaign as CampaignRow, Job, Prisma } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { PackShape } from "../../agents/research/output.schema";
import { nameFrom, toResearchBrief } from "@/lib/campaigns/brief";
import { toCampaign } from "@/lib/campaigns/view";
import { campaignsCopy } from "@/lib/copy/campaigns";
import { prisma } from "@/lib/db";
import { NO_CRM } from "@/lib/leadgen/crm";
import { FakeLeadGenProvider, type FakeStep } from "@/lib/leadgen/fakeProvider";
import type { ProviderCandidate, ProviderVocabulary } from "@/lib/leadgen/provider";
import type { LeadGenSetup } from "@/lib/leadgen/setup";
import { DOCUMENTED_UNVERIFIED_PRICING } from "@/lib/leadgen/spend";
import { CampaignChangeRefused, confirmCampaign, createCampaign, editCampaignBrief, getCampaignForOwner, rerunPeople, reviewPeople, type ChangeRefusal } from "@/lib/repo/campaigns";
import { CAMPAIGN_CONFIRMED, LEAD_GEN_JOB, findConfirmEvent, findLeadGenResult, handoffOf, persistedSpend } from "@/lib/repo/leadgen";
import { mutate } from "@/lib/repo/mutate";
import { recordResearchCompleted } from "@/lib/repo/research";
import { TerminalError } from "@/worker/errors";
import { leadGenHandler, type LeadGenHandlerDeps } from "@/worker/handlers/leadGen";

import { emptyAll, resetDatabase } from "../db/harness";
import { briefFields, completePack, partialPack } from "../lib/campaignPacks";
import { NO_WAIT, ROLE_TITLES, VOCABULARY, candidate } from "./harness";

/**
 * Confirm, the lead gen job and the campaign it draws, on the real database
 * with a scripted provider: the frozen handoff, the one job, the persisted
 * people and ledger, reuse, org isolation and the shared credit pool.
 * No provider, no network, no spend.
 */

const ORG = "org_leadgen_a";
const OTHER_ORG = "org_leadgen_b";
const REP = "user_leadgen_a";
const REP_B = "user_leadgen_b";

beforeAll(async () => {
  await resetDatabase();
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

afterEach(() => vi.restoreAllMocks());

beforeEach(async () => {
  await emptyAll();
  for (const id of [ORG, OTHER_ORG]) {
    await mutate(prisma, { orgId: id, actor: { kind: "system" }, kind: "org.created", apply: (tx) => tx.org.create({ data: { id, name: id } }) });
  }
  for (const [orgId, id] of [[ORG, REP], [OTHER_ORG, REP_B]] as const) {
    await mutate(prisma, {
      orgId,
      actor: { kind: "system" },
      kind: "user.upserted",
      apply: (tx) => tx.user.create({ data: { id, orgId, email: `${id}@example.test` } }),
    });
  }
});

/** A campaign whose research has finished with a plan, written the way the research handler writes it. */
async function planned(orgId = ORG, userId = orgId === ORG ? REP : REP_B, pack: PackShape = completePack()): Promise<CampaignRow> {
  const brief = toResearchBrief(briefFields());
  const { campaign, job } = await createCampaign(prisma, { orgId, userId, startRequestId: randomUUID(), name: nameFrom(brief.who), brief: brief as Prisma.InputJsonObject });
  if (job === null) throw new Error("tests: a fresh start made no job");
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
    outcome: pack.partial ? "partial" : "complete",
    scope: JSON.parse(JSON.stringify(pack.scope ?? {})),
  });
  await prisma.job.update({ where: { id: job.id }, data: { status: "done" } });
  return campaign;
}

function setup(over: Partial<LeadGenSetup> = {}): LeadGenSetup {
  return {
    sample: true,
    searchCreditCap: 40,
    pricingAssumptions: DOCUMENTED_UNVERIFIED_PRICING.id,
    pricing: DOCUMENTED_UNVERIFIED_PRICING,
    // A minute ago, so every reservation this test makes is after the snapshot.
    readBalance: async () => ({ remaining: 100, readAt: new Date(Date.now() - 60_000), source: "sample" }),
    environment: async () => {
      throw new Error("tests hand the handler its provider");
    },
    ...over,
  };
}

function confirm(campaign: CampaignRow, options: { requestId?: string; setup?: LeadGenSetup | null; fromBriefVersion?: number; userId?: string } = {}) {
  return confirmCampaign(prisma, {
    orgId: campaign.orgId,
    userId: options.userId ?? campaign.ownerUserId,
    campaignId: campaign.id,
    fromBriefVersion: options.fromBriefVersion ?? campaign.briefVersion,
    requestId: options.requestId ?? randomUUID(),
    setup: options.setup === undefined ? setup() : options.setup,
  });
}

async function refusalOf(promise: Promise<unknown>): Promise<ChangeRefusal | "ok"> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (error instanceof CampaignChangeRefused) return error.refusal;
    throw error;
  }
}

const latestJob = (campaignId: string) =>
  prisma.job.findFirstOrThrow({ where: { campaignId, kind: LEAD_GEN_JOB }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });

const page = (candidates: ProviderCandidate[], hasMore = false, charged = candidates.length): FakeStep => ({ candidates, charged, hasMore });
const range = (from: number, to: number, over: Partial<ProviderCandidate> = {}) =>
  Array.from({ length: to - from + 1 }, (_, index) => candidate(from + index, { title: ROLE_TITLES[(from + index) % ROLE_TITLES.length], ...over }));

async function run(job: Job, steps: FakeStep[], over: Partial<LeadGenHandlerDeps> & { vocabulary?: ProviderVocabulary; attempt?: number } = {}) {
  const provider = new FakeLeadGenProvider(steps);
  const { vocabulary = VOCABULARY, attempt = 1, ...deps } = over;
  const result = await leadGenHandler({ environment: () => ({ provider, vocabulary }), crm: NO_CRM, retry: NO_WAIT, ...deps })({
    db: prisma,
    job: { ...job, attempts: attempt },
    signal: new AbortController().signal,
  });
  return { provider, result };
}

const campaignView = async (campaign: CampaignRow) => {
  const record = await getCampaignForOwner(prisma, { orgId: campaign.orgId, userId: campaign.ownerUserId, id: campaign.id });
  if (record === null) throw new Error("tests: campaign not found");
  return toCampaign(record, { available: true, searchCreditCap: 40, sample: true });
};

describe("Confirm plan", () => {
  it("@proof refuses with balance_unavailable when the balance cannot be read, and freezes and starts nothing", async () => {
    const campaign = await planned();
    const down = setup({
      readBalance: async () => {
        throw new Error("usage read failed");
      },
    });
    expect(await refusalOf(confirm(campaign, { setup: down }))).toBe("balance_unavailable");
    expect(await prisma.event.count({ where: { kind: CAMPAIGN_CONFIRMED } })).toBe(0);
    expect(await prisma.job.count({ where: { kind: LEAD_GEN_JOB } })).toBe(0);
  });

  it("@proof freezes the handoff and the lawful basis, and enqueues exactly one lead gen job; a repeated press is the same press", async () => {
    const campaign = await planned();
    const requestId = randomUUID();
    const first = await confirm(campaign, { requestId });
    const again = await confirm(campaign, { requestId });

    expect(first.repeated).toBe(false);
    expect(again).toMatchObject({ repeated: true, job: null });
    expect(await prisma.job.count({ where: { campaignId: campaign.id, kind: LEAD_GEN_JOB } })).toBe(1);
    expect(await prisma.event.count({ where: { campaignId: campaign.id, kind: CAMPAIGN_CONFIRMED } })).toBe(1);

    const event = await findConfirmEvent(prisma, { orgId: ORG, campaignId: campaign.id, briefVersion: 1 });
    const handoff = handoffOf(event!);
    expect(handoff.buyerGroup).toMatchObject({ id: "claims-teams", sourceRank: 1 });
    expect(handoff.lawfulBasis).toMatchObject({ text: campaignsCopy.lawfulBasis, confirmedByUserId: REP, briefVersion: 1 });
    expect(handoff.spend).toMatchObject({ searchCreditCap: 40, balanceSnapshot: { remaining: 100 }, pricingAssumptions: DOCUMENTED_UNVERIFIED_PRICING.id });
    expect(event!.after).toMatchObject({ requestId, briefVersion: 1, balanceSource: "sample" });
    expect((await latestJob(campaign.id)).input).toEqual({ confirmRequestId: requestId, run: 1 });
  });

  it("refuses a second Confirm of a confirmed version, and makes no second job", async () => {
    const campaign = await planned();
    await confirm(campaign);
    expect(await refusalOf(confirm(campaign))).toBe("wrong_state");
    expect(await prisma.job.count({ where: { campaignId: campaign.id, kind: LEAD_GEN_JOB } })).toBe(1);
  });

  it("refuses where it cannot be honest, and writes nothing", async () => {
    const campaign = await planned();
    expect(await refusalOf(confirm(campaign, { setup: null }))).toBe("not_available");
    expect(await refusalOf(confirm(campaign, { setup: setup({ searchCreditCap: 200 }) }))).toBe("over_cap");
    expect(await refusalOf(confirm(campaign, { fromBriefVersion: 2 }))).toBe("version_ahead");
    expect(await refusalOf(confirm(campaign, { userId: REP_B }))).toBe("not_found");
    // No ranked group: the adapter never falls back to the first group.
    expect(await refusalOf(confirm(await planned(ORG, REP, partialPack())))).toBe("no_ranked_group");
    // Research still reading: nothing to confirm.
    const brief = toResearchBrief(briefFields());
    const { campaign: reading } = await createCampaign(prisma, { orgId: ORG, userId: REP, startRequestId: randomUUID(), name: "Reading", brief: brief as Prisma.InputJsonObject });
    expect(await refusalOf(confirm(reading))).toBe("wrong_state");
    expect(await prisma.job.count({ where: { kind: LEAD_GEN_JOB } })).toBe(0);
    expect(await prisma.event.count({ where: { kind: CAMPAIGN_CONFIRMED } })).toBe(0);
  });
});

describe("the lead gen job", () => {
  it("@proof finds people from the frozen handoff and persists them in rank order", async () => {
    const campaign = await planned();
    await confirm(campaign);
    const { provider, result } = await run(await latestJob(campaign.id), [page(range(1, 12), true, 10)]);

    expect(result).toEqual({ eventId: expect.any(String) });
    expect(provider.calls).toHaveLength(1);
    const rows = await prisma.campaignPerson.findMany({ where: { orgId: ORG, campaignId: campaign.id }, orderBy: [{ status: "asc" }, { rank: "asc" }] });
    expect(rows.filter((row) => row.status === "chosen").map((row) => row.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(rows.filter((row) => row.status === "spare")).toHaveLength(2);
    expect(await prisma.creditLedgerEntry.findMany({ where: { orgId: ORG }, select: { state: true, charged: true, worstCase: true } })).toEqual([
      { state: "reconciled", charged: 10, worstCase: 10 },
    ]);

    const view = await campaignView(campaign);
    expect(view.state).toBe("peopleFound");
    expect(view.chip).toBe(campaignsCopy.chipPeopleFound);
    expect(view.peopleFound).toMatchObject({ found: { n: 10, ofM: 10 }, shortfall: null, spend: { charged: 10, reserved: 0, cap: 40 }, sample: true });
    expect(view.peopleFound?.accounts.flatMap((account) => account.people)).toHaveLength(10);
    expect(view.credits).toEqual({ used: 10, left: 30 });
    expect(view.can).toMatchObject({ edit: true, confirm: false, retryPeople: false });
  });

  it("keeps a partial result: X of N, and why it ended short", async () => {
    const campaign = await planned();
    await confirm(campaign);
    await run(await latestJob(campaign.id), [page(range(1, 4))]);
    const view = await campaignView(campaign);
    expect(view.peopleFound).toMatchObject({ found: { n: 4, ofM: 10 }, shortfall: "no_more_results" });
  });

  it("records Needs you when nobody fits, and writes no candidates", async () => {
    const campaign = await planned();
    await confirm(campaign);
    await run(await latestJob(campaign.id), [page(range(1, 3, { countryIso2: "IE" }))]);
    expect(await prisma.campaignPerson.count({ where: { campaignId: campaign.id } })).toBe(0);
    const view = await campaignView(campaign);
    expect(view.state).toBe("peopleNeedsYou");
    expect(view.peopleNeedsYou).toMatchObject({ reason: "no_candidates", line: campaignsCopy.haltNoCandidates });
  });

  it("makes no search when the recipe cannot be translated, and says why", async () => {
    const campaign = await planned();
    await confirm(campaign);
    const { provider } = await run(await latestJob(campaign.id), [], { vocabulary: { ...VOCABULARY, industries: [{ id: "70", label: "Veterinary", level: "sub" }] } });
    expect(provider.calls).toHaveLength(0);
    expect(await prisma.creditLedgerEntry.count()).toBe(0);
    expect((await campaignView(campaign)).peopleNeedsYou).toMatchObject({ reason: "unmappable", term: "Insurance" });
  });

  it("uses the frozen handoff, not the brief or research as they are now", async () => {
    const campaign = await planned();
    await confirm(campaign);
    // The brief moves on after Confirm (a direct write, as no screen would allow it mid-run).
    await prisma.campaign.update({ where: { id: campaign.id }, data: { brief: { ...(campaign.brief as object), howMany: 30 } } });
    const { provider } = await run(await latestJob(campaign.id), [page(range(1, 4))]);
    expect(provider.calls[0]?.pageSize).toBe(10);
    const event = await findLeadGenResult(prisma, { orgId: ORG, jobId: (await latestJob(campaign.id)).id });
    expect(event?.after).toMatchObject({ output: { found: { n: 4, ofM: 10 } } });
  });

  it("@proof is idempotent: a retried job records one result and searches again for nothing", async () => {
    const campaign = await planned();
    await confirm(campaign);
    const job = await latestJob(campaign.id);
    const first = await run(job, [page(range(1, 12))]);
    const second = await run(job, [], { attempt: 2 });
    expect(second.result).toEqual(first.result);
    expect(second.provider.calls).toHaveLength(0);
    expect(await prisma.event.count({ where: { campaignId: campaign.id, kind: { in: ["leadgen.picked", "leadgen.halted"] } } })).toBe(1);
    expect(await prisma.campaignPerson.count({ where: { campaignId: campaign.id } })).toBe(12);
  });

  it("keeps an earlier attempt's open reservation at its worst case, and a retry cannot pass the cap", async () => {
    const campaign = await planned();
    await confirm(campaign, { setup: setup({ searchCreditCap: 20 }) });
    const job = await latestJob(campaign.id);
    const confirmEvent = await findConfirmEvent(prisma, { orgId: ORG, campaignId: campaign.id, briefVersion: 1 });
    // Attempt 1 reserved and then died before the provider answered.
    const died = persistedSpend(prisma, {
      orgId: ORG,
      campaignId: campaign.id,
      briefVersion: 1,
      confirmEventId: confirmEvent!.id,
      jobId: job.id,
      attempt: 1,
      cap: 20,
      balance: { remaining: 100, readAt: new Date(Date.now() - 60_000) },
      pricingAssumptions: DOCUMENTED_UNVERIFIED_PRICING.id,
    });
    expect(await died.tryReserve("p0:a1", 10)).toBe(true);

    const { provider } = await run(job, [page(range(1, 3), true, 10), page(range(4, 6), true, 10)], { attempt: 2 });
    expect(provider.calls).toHaveLength(1);
    const entries = await prisma.creditLedgerEntry.findMany({ where: { jobId: job.id }, orderBy: { createdAt: "asc" } });
    expect(entries.map((entry) => entry.state)).toEqual(["unreconciled", "reconciled"]);
    expect(entries.reduce((total, entry) => total + (entry.state === "reconciled" ? (entry.charged ?? 0) : entry.worstCase), 0)).toBeLessThanOrEqual(20);
  });

  it("offers Try again after a busy provider, and runs again under the same Confirm", async () => {
    const campaign = await planned();
    await confirm(campaign);
    await run(await latestJob(campaign.id), [{ error: "busy" }, { error: "busy" }, { error: "busy" }]);
    const busy = await campaignView(campaign);
    expect(busy.peopleNeedsYou?.reason).toBe("provider_busy");
    expect(busy.can.retryPeople).toBe(true);

    await rerunPeople(prisma, { orgId: ORG, userId: REP, campaignId: campaign.id, briefVersion: 1, requestId: randomUUID() });
    const next = await latestJob(campaign.id);
    expect(next.input).toMatchObject({ run: 2 });
    await run(next, [page(range(1, 12))]);
    expect((await campaignView(campaign)).state).toBe("peopleFound");
    // Found: nothing to try again.
    expect(await refusalOf(rerunPeople(prisma, { orgId: ORG, userId: REP, campaignId: campaign.id, briefVersion: 1, requestId: randomUUID() }))).toBe("wrong_state");
  });

  it("searches with the industry the rep chose, from the choices offered", async () => {
    const campaign = await planned();
    await confirm(campaign);
    const vocabulary: ProviderVocabulary = { ...VOCABULARY, industries: [{ id: "45", label: "Insurance Brokers", level: "sub" }] };
    await run(await latestJob(campaign.id), [], { vocabulary });
    const halted = await campaignView(campaign);
    expect(halted.peopleNeedsYou).toMatchObject({ reason: "choose_industry", term: "Insurance", choices: ["Insurance Brokers"] });

    const choose = (label: string) =>
      rerunPeople(prisma, { orgId: ORG, userId: REP, campaignId: campaign.id, briefVersion: 1, requestId: randomUUID(), choice: { term: "Insurance", label } });
    expect(await refusalOf(choose("Finance"))).toBe("bad_option");
    await choose("Insurance Brokers");
    const next = await latestJob(campaign.id);
    expect(next.input).toMatchObject({ run: 2, industryChoices: { insurance: "Insurance Brokers" } });
    const { provider } = await run(next, [page(range(1, 12))], { vocabulary });
    expect(provider.calls[0]?.filters.industryIds).toEqual(["45"]);
    expect((await campaignView(campaign)).state).toBe("peopleFound");
  });

  it("refuses Edit brief while people are being found, and allows it once they are found", async () => {
    const campaign = await planned();
    await confirm(campaign);
    const edit = () =>
      editCampaignBrief(prisma, { orgId: ORG, userId: REP, campaignId: campaign.id, fromBriefVersion: 1, requestId: randomUUID(), brief: toResearchBrief(briefFields({ howMany: 20 })) });
    expect(await refusalOf(edit())).toBe("wrong_state");
    await run(await latestJob(campaign.id), [page(range(1, 12))]);
    expect((await campaignView(campaign)).spentAtThisVersion).toBe(true);
    expect(await refusalOf(edit())).toBe("ok");
    const moved = await campaignView(campaign);
    expect(moved.state).toBe("researching");
    // The old version's people and spend stay on the record.
    expect(await prisma.campaignPerson.count({ where: { campaignId: campaign.id, briefVersion: 1 } })).toBe(12);
  });

  it("never makes a network request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("lead gen made a network request");
    });
    const campaign = await planned();
    await confirm(campaign);
    await run(await latestJob(campaign.id), [page(range(1, 12))]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("reuse, identity and one enrolment per person", () => {
  async function owned(orgId: string, providerId: string, options: { email?: string; status?: "usable" | "wrong_person" | "no_email"; personId?: string } = {}) {
    const personId =
      options.personId ??
      (options.status === undefined || options.status === "usable"
        ? (await prisma.person.create({ data: { orgId, email: options.email ?? `${providerId}@owned.example`, emailType: "work", grade: "A", name: "Owned Person" } })).id
        : null);
    await prisma.providerIdentity.create({ data: { orgId, provider: "lusha", providerId, personId, status: options.status ?? "usable" } });
    return personId;
  }

  it("@proof reuses a usable owned person: nothing to buy, linked to the Person, and again in another campaign", async () => {
    const personId = await owned(ORG, "l-001");
    for (const campaign of [await planned(), await planned()]) {
      await confirm(campaign);
      await run(await latestJob(campaign.id), [page(range(1, 12))]);
      const row = await prisma.campaignPerson.findFirstOrThrow({ where: { campaignId: campaign.id, providerId: "l-001" } });
      expect(row).toMatchObject({ source: "reused", personId, status: "chosen" });
      // Nothing is kept yet, so nothing would be revealed: pending is not kept (v2.2 §9a).
      expect((await campaignView(campaign)).peopleFound?.revealEstimate).toEqual({ kept: 0, toBuy: 0, reused: 0, credits: 0 });
      for (const chosen of await prisma.campaignPerson.findMany({ where: { campaignId: campaign.id, status: "chosen" } })) {
        await reviewPeople(prisma, { orgId: ORG, userId: REP, campaignId: campaign.id, briefVersion: 1, personId: chosen.id, scope: "person", decision: "kept" });
      }
      const view = await campaignView(campaign);
      expect(view.peopleFound?.revealEstimate).toMatchObject({ kept: 10, reused: 1, toBuy: 9 });
      expect(view.peopleFound?.accounts.flatMap((account) => account.people).find((person) => person.reused)).toBeDefined();
    }
  });

  it("enrols one human once per campaign version, even through two provider records", async () => {
    const personId = await owned(ORG, "l-001");
    await owned(ORG, "l-002", { personId: personId! });
    const campaign = await planned();
    await confirm(campaign);
    await run(await latestJob(campaign.id), [page(range(1, 12))]);
    expect(await prisma.campaignPerson.count({ where: { campaignId: campaign.id, personId } })).toBe(1);
    // And the database says so too.
    const row = await prisma.campaignPerson.findFirstOrThrow({ where: { campaignId: campaign.id, personId } });
    await expect(
      prisma.campaignPerson.create({
        data: { ...row, id: undefined, providerId: "l-999", rank: 99, preview: row.preview as Prisma.InputJsonValue, createdAt: undefined, updatedAt: undefined },
      }),
    ).rejects.toThrow();
  });

  it("does not let an unusable record block the same human reached through another record", async () => {
    await owned(ORG, "l-001", { status: "wrong_person" });
    const personId = await owned(ORG, "l-002");
    const campaign = await planned();
    await confirm(campaign);
    await run(await latestJob(campaign.id), [page(range(1, 12))]);
    expect(await prisma.campaignPerson.count({ where: { campaignId: campaign.id, providerId: "l-001" } })).toBe(0);
    expect(await prisma.campaignPerson.findFirstOrThrow({ where: { campaignId: campaign.id, providerId: "l-002" } })).toMatchObject({ source: "reused", personId });
  });

  it("keeps the provider's raw domain on the candidate while keying by the registrable domain", async () => {
    const campaign = await planned();
    await confirm(campaign);
    await run(await latestJob(campaign.id), [page([candidate(1, { domain: "Sales.Firm1.co.uk" }), ...range(2, 12)])]);
    const row = await prisma.campaignPerson.findFirstOrThrow({ where: { campaignId: campaign.id, providerId: "l-001" } });
    expect(row.companyKey).toBe("firm1.co.uk");
    expect(row.preview).toMatchObject({ domain: "Sales.Firm1.co.uk" });
  });
});

describe("org isolation", () => {
  it("@proof keeps another org's people, provider records, suppressions and spend out of this org's run", async () => {
    // Org B: the same provider ids, the same email, the same domain, and a spent pool.
    await owned(OTHER_ORG, "l-001", "wrong_person");
    const bPerson = await prisma.person.create({ data: { orgId: OTHER_ORG, email: "person.2@firm2.co.uk", emailType: "work", grade: "A", name: "B" } });
    await prisma.providerIdentity.create({ data: { orgId: OTHER_ORG, provider: "lusha", providerId: "l-002", personId: bPerson.id, status: "usable" } });
    await prisma.contactSuppression.create({ data: { orgId: OTHER_ORG, kind: "domain", value: "firm3.co.uk", reason: "dnc", source: "test" } });
    const bCampaign = await planned(OTHER_ORG);
    await confirm(bCampaign, { setup: setup({ searchCreditCap: 30, readBalance: async () => ({ remaining: 30, readAt: new Date(Date.now() - 60_000), source: "sample" }) }) });
    await run(await latestJob(bCampaign.id), [page(range(1, 3), true, 10), page(range(4, 6), true, 10), page(range(7, 9), true, 10)]);

    const campaign = await planned();
    await confirm(campaign);
    await run(await latestJob(campaign.id), [page(range(1, 12))]);

    const rows = await prisma.campaignPerson.findMany({ where: { orgId: ORG, campaignId: campaign.id } });
    const byId = Object.fromEntries(rows.map((row) => [row.providerId, row]));
    // Not provider_unusable, not reused as B's person, not held as B's do-not-contact.
    expect(byId["l-001"]).toMatchObject({ source: "bought", personId: null });
    expect(byId["l-002"]).toMatchObject({ source: "bought", personId: null });
    expect(byId["l-003"]).toBeDefined();
    // B's spend never touched A's pool.
    expect((await campaignView(campaign)).credits).toEqual({ used: 12, left: 28 });
    expect(await prisma.campaignPerson.count({ where: { orgId: ORG, personId: bPerson.id } })).toBe(0);

    // A job of org A cannot be pointed at org B's Confirm.
    const bConfirm = await findConfirmEvent(prisma, { orgId: OTHER_ORG, campaignId: bCampaign.id, briefVersion: 1 });
    const aJob = await latestJob(campaign.id);
    const pointedAtB = { ...aJob, id: "job-not-yet-run", input: { confirmRequestId: (bConfirm!.after as { requestId: string }).requestId, run: 1 } } as Job;
    await expect(run(pointedAtB, [])).rejects.toThrow(TerminalError);
  });

  async function owned(orgId: string, providerId: string, status: "wrong_person") {
    await prisma.providerIdentity.create({ data: { orgId, provider: "lusha", providerId, personId: null, status } });
  }
});

describe("one credit pool per org", () => {
  it("@proof lets no two reservations in one org spend the same credits", async () => {
    const campaign = await planned();
    await confirm(campaign, { setup: setup({ searchCreditCap: 100, readBalance: async () => ({ remaining: 100, readAt: new Date(Date.now() - 60_000), source: "sample" }) }) });
    const confirmEvent = await findConfirmEvent(prisma, { orgId: ORG, campaignId: campaign.id, briefVersion: 1 });
    const job = await latestJob(campaign.id);
    const spend = persistedSpend(prisma, {
      orgId: ORG,
      campaignId: campaign.id,
      briefVersion: 1,
      confirmEventId: confirmEvent!.id,
      jobId: job.id,
      attempt: 1,
      cap: 100,
      balance: { remaining: 30, readAt: new Date(Date.now() - 60_000) },
      pricingAssumptions: DOCUMENTED_UNVERIFIED_PRICING.id,
    });
    const granted = await Promise.all(Array.from({ length: 10 }, (_, index) => spend.tryReserve(`race:${index}`, 10)));
    expect(granted.filter(Boolean)).toHaveLength(3);
  });

  it("@proof keeps two campaigns running at once in one org inside the balance they share", async () => {
    const shared = setup({ searchCreditCap: 30, readBalance: async () => ({ remaining: 30, readAt: new Date(Date.now() - 60_000), source: "sample" }) });
    const [one, two] = [await planned(), await planned()];
    await confirm(one, { setup: shared });
    await confirm(two, { setup: shared });
    const pages = (from: number) => Array.from({ length: 5 }, (_, index) => page(range(from + index * 2, from + index * 2 + 1), true, 10));
    const [a, b] = await Promise.all([run(await latestJob(one.id), pages(100)), run(await latestJob(two.id), pages(200))]);

    expect(a.provider.calls.length + b.provider.calls.length).toBe(3);
    const entries = await prisma.creditLedgerEntry.findMany({ where: { orgId: ORG } });
    expect(entries.reduce((total, entry) => total + (entry.state === "reconciled" ? (entry.charged ?? 0) : entry.worstCase), 0)).toBeLessThanOrEqual(30);
  });
});

describe("keep or drop before Reveal (v2.2 §9a)", () => {
  async function found(people: ProviderCandidate[] = range(1, 12)) {
    const campaign = await planned();
    await confirm(campaign);
    await run(await latestJob(campaign.id), [page(people)]);
    const chosen = await prisma.campaignPerson.findMany({ where: { campaignId: campaign.id, status: "chosen" }, orderBy: { rank: "asc" } });
    return { campaign, chosen };
  }
  const review = (
    campaign: CampaignRow,
    personId: string,
    decision: "kept" | "dropped",
    scope: "person" | "account" = "person",
    over: { userId?: string; orgId?: string; briefVersion?: number; now?: () => Date } = {},
  ) =>
    reviewPeople(prisma, {
      orgId: over.orgId ?? campaign.orgId,
      userId: over.userId ?? campaign.ownerUserId,
      campaignId: campaign.id,
      briefVersion: over.briefVersion ?? 1,
      personId,
      scope,
      decision,
      ...(over.now === undefined ? {} : { now: over.now }),
    });
  const titleOf = (row: { preview: unknown }) => (row.preview as { title: string }).title;

  it("@proof starts every chosen person pending, records the role each plays, and counts nobody as kept", async () => {
    const { campaign, chosen } = await found();
    expect(chosen.every((row) => row.review === "pending" && row.reviewedAt === null && row.reviewedByUserId === null)).toBe(true);
    // The test pack's roles: "Head of claims" signs it off, "Claims team leader" runs it.
    expect(chosen.find((row) => titleOf(row) === "Claims Team Leader")).toMatchObject({ rolePart: "runs", roleTitle: "Claims team leader", roleMatch: "exact" });
    expect(chosen.find((row) => titleOf(row) === "Deputy Head of Claims")).toMatchObject({ rolePart: "signs", roleTitle: "Head of claims", roleMatch: "phrase" });
    const view = await campaignView(campaign);
    expect(view.peopleFound?.review).toEqual({ kept: 0, dropped: 0, pending: 10 });
    expect(view.peopleFound?.revealEstimate).toEqual({ kept: 0, toBuy: 0, reused: 0, credits: 0 });
    // Why each person fits is their role's needs, as research wrote them.
    const people = view.peopleFound!.accounts.flatMap((account) => account.people);
    expect(people.find((person) => person.role === "runs")?.needs).toBe("Less manual checking.");
  });

  it("@proof keeps and drops one person with who and when, one Event each, and the decision survives a reload", async () => {
    const { campaign, chosen } = await found();
    const [first, second] = chosen;
    const at = new Date("2026-09-14T15:00:00Z");
    await review(campaign, first!.id, "kept", "person", { now: () => at });
    await review(campaign, second!.id, "dropped");

    expect(await prisma.campaignPerson.findUniqueOrThrow({ where: { id: first!.id } })).toMatchObject({ review: "kept", reviewedByUserId: REP, reviewedAt: at });
    expect(await prisma.campaignPerson.findUniqueOrThrow({ where: { id: second!.id } })).toMatchObject({ review: "dropped", reviewedByUserId: REP });
    const events = await prisma.event.findMany({ where: { campaignId: campaign.id, kind: "campaign.people_reviewed" }, orderBy: [{ at: "asc" }, { id: "asc" }] });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      actorUserId: REP,
      before: { people: [{ id: first!.id, review: "pending" }] },
      after: { briefVersion: 1, scope: "person", decision: "kept", people: [first!.id] },
    });

    // A reload is a fresh read of the same rows.
    const view = await campaignView(campaign);
    expect(view.peopleFound?.review).toEqual({ kept: 1, dropped: 1, pending: 8 });
    expect(view.peopleFound?.accounts.flatMap((account) => account.people).find((person) => person.id === first!.id)?.review).toBe("kept");
    // Only the kept person counts towards a reveal.
    expect(view.peopleFound?.revealEstimate).toEqual({ kept: 1, toBuy: 1, reused: 0, credits: 1 });

    // The same press again changes nothing and records nothing; a decision can still be changed.
    expect((await review(campaign, first!.id, "kept")).changed).toEqual([]);
    expect(await prisma.event.count({ where: { kind: "campaign.people_reviewed" } })).toBe(2);
    await review(campaign, second!.id, "kept");
    expect((await campaignView(campaign)).peopleFound?.review).toEqual({ kept: 2, dropped: 0, pending: 8 });
  });

  it("@proof drops a whole account in one transaction, and nobody outside it", async () => {
    // Two people at one account: its lead (who runs it) and a complement (who signs it off).
    const { campaign, chosen } = await found([candidate(1, { title: "Claims Team Leader" }), candidate(2, { title: "Head of Claims", company: "Firm 1", domain: "firm1.co.uk" }), ...range(3, 12)]);
    const account = chosen.filter((row) => row.companyKey === "firm1.co.uk");
    expect(account.map((row) => row.rolePart).sort()).toEqual(["runs", "signs"]);

    const result = await review(campaign, account[0]!.id, "dropped", "account");
    expect(result.changed.sort()).toEqual(account.map((row) => row.id).sort());
    const after = await prisma.campaignPerson.findMany({ where: { campaignId: campaign.id, status: "chosen" } });
    expect(after.filter((row) => row.review === "dropped").map((row) => row.companyKey)).toEqual(["firm1.co.uk", "firm1.co.uk"]);
    expect(after.filter((row) => row.companyKey !== "firm1.co.uk").every((row) => row.review === "pending")).toBe(true);
    const events = await prisma.event.findMany({ where: { campaignId: campaign.id, kind: "campaign.people_reviewed" } });
    expect(events).toHaveLength(1);
    expect(events[0]?.after).toMatchObject({ scope: "account", decision: "dropped" });
  });

  it("@proof refuses another rep's or org's campaign, a stale page, a spare or unknown person, and a campaign with nobody found yet", async () => {
    const { campaign, chosen } = await found();
    const spare = await prisma.campaignPerson.findFirstOrThrow({ where: { campaignId: campaign.id, status: "spare" } });
    expect(await refusalOf(review(campaign, chosen[0]!.id, "kept", "person", { orgId: OTHER_ORG, userId: REP_B }))).toBe("not_found");
    expect(await refusalOf(review(campaign, chosen[0]!.id, "kept", "person", { briefVersion: 2 }))).toBe("version_ahead");
    expect(await refusalOf(review(campaign, spare.id, "kept"))).toBe("not_found");
    expect(await refusalOf(review(campaign, "no-such-person", "kept"))).toBe("not_found");

    const waiting = await planned();
    await confirm(waiting);
    expect(await refusalOf(review(waiting, chosen[0]!.id, "kept"))).toBe("wrong_state");
    expect(await prisma.event.count({ where: { kind: "campaign.people_reviewed" } })).toBe(0);
    expect(await prisma.campaignPerson.count({ where: { review: { not: "pending" } } })).toBe(0);
  });

  it("the database refuses a half-recorded decision or role", async () => {
    const { chosen } = await found();
    await expect(prisma.campaignPerson.update({ where: { id: chosen[0]!.id }, data: { review: "kept" } })).rejects.toThrow();
    await expect(prisma.campaignPerson.update({ where: { id: chosen[0]!.id }, data: { roleTitle: null } })).rejects.toThrow();
  });
});
