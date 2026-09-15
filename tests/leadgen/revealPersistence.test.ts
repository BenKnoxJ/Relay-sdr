import { randomUUID } from "node:crypto";

import type { Campaign as CampaignRow, Job, Prisma } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { nameFrom, toResearchBrief } from "@/lib/campaigns/brief";
import { toCampaign } from "@/lib/campaigns/view";
import { prisma } from "@/lib/db";
import { NO_CRM } from "@/lib/leadgen/crm";
import { FakeLeadGenProvider, FakeRevealProvider, type FakeRevealStep, type FakeStep } from "@/lib/leadgen/fakeProvider";
import type { ProviderCandidate, RevealedContact } from "@/lib/leadgen/provider";
import type { LeadGenSetup } from "@/lib/leadgen/setup";
import { DOCUMENTED_UNVERIFIED_PRICING } from "@/lib/leadgen/spend";
import { CampaignChangeRefused, confirmCampaign, confirmReveal, createCampaign, getCampaignForOwner, reviewPeople, type ChangeRefusal } from "@/lib/repo/campaigns";
import { CAMPAIGN_REVEAL_CONFIRMED, LEADGEN_REVEALED, LEAD_GEN_JOB, REVEAL_JOB, confirmSpend, findConfirmEvent, persistedSpend } from "@/lib/repo/leadgen";
import { mutate } from "@/lib/repo/mutate";
import { recordResearchCompleted } from "@/lib/repo/research";
import { leadGenHandler } from "@/worker/handlers/leadGen";
import { revealHandler, type RevealHandlerDeps } from "@/worker/handlers/reveal";

import { emptyAll, resetDatabase } from "../db/harness";
import { briefFields, completePack } from "../lib/campaignPacks";
import { NO_WAIT, ROLE_TITLES, VOCABULARY, candidate } from "./harness";

/**
 * Reveal emails on the real database with scripted providers (lead gen v2.1
 * §6, §7, §9, §11; v2.2 §9a): the explicit approval, the kept people only,
 * reuse and never buying twice, suppression, the reveal ledger kept apart
 * from the search limit, idempotence across presses, reloads and retries,
 * and org isolation. No provider, no network, no spend.
 */

const ORG = "org_reveal_a";
const OTHER_ORG = "org_reveal_b";
const REP = "user_reveal_a";
const REP_B = "user_reveal_b";

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
  for (const [orgId, id] of [[ORG, REP], [OTHER_ORG, REP_B]] as const) {
    await mutate(prisma, { orgId, actor: { kind: "system" }, kind: "user.upserted", apply: (tx) => tx.user.create({ data: { id, orgId, email: `${id}@example.test` } }) });
  }
});

async function planned(orgId = ORG, userId = orgId === ORG ? REP : REP_B): Promise<CampaignRow> {
  const brief = toResearchBrief(briefFields());
  const pack = completePack();
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
    outcome: "complete",
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
    readBalance: async () => ({ remaining: 100, readAt: new Date(Date.now() - 60_000), source: "sample" }),
    environment: async () => {
      throw new Error("tests hand the handler its provider");
    },
    revealer: () => {
      throw new Error("tests hand the handler its provider");
    },
    ...over,
  };
}

const page = (candidates: ProviderCandidate[]): FakeStep => ({ candidates, charged: candidates.length, hasMore: false });
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => candidate(from + index, { title: ROLE_TITLES[(from + index) % ROLE_TITLES.length] }));

/** A campaign whose search found people 1 to 10 (of 12 returned), all pending. */
async function found(orgId = ORG, people: ProviderCandidate[] = range(1, 12)) {
  const campaign = await planned(orgId);
  await confirmCampaign(prisma, { orgId, userId: campaign.ownerUserId, campaignId: campaign.id, fromBriefVersion: 1, requestId: randomUUID(), setup: setup() });
  const job = await prisma.job.findFirstOrThrow({ where: { campaignId: campaign.id, kind: LEAD_GEN_JOB } });
  const provider = new FakeLeadGenProvider([page(people)]);
  await leadGenHandler({ environment: () => ({ provider, vocabulary: VOCABULARY }), crm: NO_CRM, retry: NO_WAIT })({ db: prisma, job: { ...job, attempts: 1 }, signal: new AbortController().signal });
  const chosen = await prisma.campaignPerson.findMany({ where: { campaignId: campaign.id, status: "chosen" }, orderBy: { rank: "asc" } });
  return { campaign, chosen, byProvider: new Map(chosen.map((row) => [row.providerId, row])) };
}

const decide = (campaign: CampaignRow, personId: string, decision: "kept" | "dropped" = "kept") =>
  reviewPeople(prisma, { orgId: campaign.orgId, userId: campaign.ownerUserId, campaignId: campaign.id, briefVersion: 1, personId, scope: "person", decision });

const view = async (campaign: CampaignRow) => {
  const record = await getCampaignForOwner(prisma, { orgId: campaign.orgId, userId: campaign.ownerUserId, id: campaign.id });
  if (record === null) throw new Error("tests: campaign not found");
  return toCampaign(record, { available: true, searchCreditCap: 40, sample: true });
};

/** Reveal emails pressed with exactly the figures the page shows. */
async function approve(campaign: CampaignRow, options: { requestId?: string; setup?: LeadGenSetup | null; expected?: { toReveal: number; known: number; maxCredits: number }; userId?: string; orgId?: string } = {}) {
  const plan = (await view(campaign)).peopleFound?.revealPlan;
  return confirmReveal(prisma, {
    orgId: options.orgId ?? campaign.orgId,
    userId: options.userId ?? campaign.ownerUserId,
    campaignId: campaign.id,
    briefVersion: 1,
    requestId: options.requestId ?? randomUUID(),
    expected: options.expected ?? { toReveal: plan?.toReveal ?? 0, known: plan?.known ?? 0, maxCredits: plan?.maxCredits ?? 0 },
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

const revealJob = (campaignId: string) => prisma.job.findFirstOrThrow({ where: { campaignId, kind: REVEAL_JOB } });

const contact = (n: number, over: Partial<Extract<RevealedContact, { status: "found" }>> = {}): RevealedContact => ({
  status: "found",
  name: `Person ${n}`,
  domain: `www.firm${n}.co.uk`,
  emails: [{ address: `person${n}@firm${n}.co.uk`, type: "work", grade: "A+" }],
  ...over,
});
const everyone = (over: Record<string, RevealedContact> = {}): Record<string, RevealedContact> => ({
  ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`l-${String(index + 1).padStart(3, "0")}`, contact(index + 1)])),
  ...over,
});

async function reveal(job: Job, steps: FakeRevealStep[], over: Partial<RevealHandlerDeps> & { attempt?: number } = {}) {
  const provider = new FakeRevealProvider(steps);
  const { attempt = 1, ...deps } = over;
  const result = await revealHandler({ revealer: () => provider, crm: NO_CRM, pricing: DOCUMENTED_UNVERIFIED_PRICING, retry: NO_WAIT, ...deps })({
    db: prisma,
    job: { ...job, attempts: attempt },
    signal: new AbortController().signal,
  });
  return { provider, result };
}

const revealCredits = (orgId = ORG) => prisma.creditLedgerEntry.findMany({ where: { orgId, kind: "reveal" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });

describe("the approval", () => {
  it("@proof buys nothing until the rep presses Reveal emails: keeping people is not an approval", async () => {
    const { campaign, chosen } = await found();
    await decide(campaign, chosen[0]!.id);
    await decide(campaign, chosen[1]!.id);
    expect(await prisma.job.count({ where: { kind: REVEAL_JOB } })).toBe(0);
    expect(await prisma.event.count({ where: { kind: { in: [CAMPAIGN_REVEAL_CONFIRMED, LEADGEN_REVEALED] } } })).toBe(0);
    expect(await revealCredits()).toEqual([]);
    const drawn = await view(campaign);
    expect(drawn.state).toBe("peopleFound");
    expect(drawn.can.reveal).toBe(true);
    expect(drawn.peopleFound?.revealPlan).toEqual({ kept: 2, known: 0, toReveal: 2, free: 0, maxCredits: 2, noEmail: 0, unavailable: 0 });
  });

  it("@proof covers the kept people only: pending and dropped are never revealed", async () => {
    const { campaign, chosen } = await found();
    await decide(campaign, chosen[0]!.id);
    await decide(campaign, chosen[1]!.id);
    await decide(campaign, chosen[2]!.id, "dropped");
    await approve(campaign);
    const event = await prisma.event.findFirstOrThrow({ where: { kind: CAMPAIGN_REVEAL_CONFIRMED } });
    expect(event).toMatchObject({ actorUserId: REP, campaignId: campaign.id });
    expect((event.after as { people: string[] }).people).toEqual([chosen[0]!.id, chosen[1]!.id]);
    expect(event.after).toMatchObject({ briefVersion: 1, maxCredits: 2, counts: { kept: 2, toReveal: 2, known: 0 }, balanceSource: "sample" });
    expect((await view(campaign)).state).toBe("revealing");

    const { provider } = await reveal(await revealJob(campaign.id), [{ contacts: everyone(), charged: 2 }]);
    expect(provider.calls.map((call) => call.providerIds)).toEqual([[chosen[0]!.providerId, chosen[1]!.providerId]]);
    const rows = await prisma.campaignPerson.findMany({ where: { campaignId: campaign.id, status: "chosen" } });
    expect(rows.filter((row) => row.reveal !== null).map((row) => row.id).sort()).toEqual([chosen[0]!.id, chosen[1]!.id].sort());
  });

  it("@proof refuses when the figures changed, nobody kept has an email, the balance is short, or it isn't set up, and writes nothing", async () => {
    const { campaign, chosen } = await found();
    // Only a person the preview says has no email is kept: nothing to reveal.
    await prisma.campaignPerson.update({ where: { id: chosen[0]!.id }, data: { preview: { ...(chosen[0]!.preview as Prisma.JsonObject), hasEmail: false } } });
    await decide(campaign, chosen[0]!.id);
    expect(await refusalOf(approve(campaign))).toBe("nothing_to_reveal");
    await decide(campaign, chosen[1]!.id);
    expect(await refusalOf(approve(campaign, { expected: { toReveal: 1, known: 0, maxCredits: 2 } }))).toBe("estimate_changed");
    expect(await refusalOf(approve(campaign, { setup: setup({ readBalance: async () => ({ remaining: 0, readAt: new Date(), source: "sample" }) }) }))).toBe("reveal_over_balance");
    expect(
      await refusalOf(
        approve(campaign, {
          setup: setup({
            readBalance: async () => {
              throw new Error("usage unreadable");
            },
          }),
        }),
      ),
    ).toBe("balance_unavailable");
    expect(await refusalOf(approve(campaign, { setup: null }))).toBe("not_available");
    expect(await prisma.job.count({ where: { kind: REVEAL_JOB } })).toBe(0);
    expect(await prisma.event.count({ where: { kind: CAMPAIGN_REVEAL_CONFIRMED } })).toBe(0);
  });

  it("@proof answers another rep and another org as if the campaign were not there", async () => {
    const { campaign, chosen } = await found();
    await decide(campaign, chosen[0]!.id);
    const colleague = "user_reveal_colleague";
    await mutate(prisma, { orgId: ORG, actor: { kind: "system" }, kind: "user.upserted", apply: (tx) => tx.user.create({ data: { id: colleague, orgId: ORG, email: `${colleague}@example.test` } }) });
    expect(await refusalOf(approve(campaign, { userId: colleague }))).toBe("not_found");
    expect(await refusalOf(approve(campaign, { orgId: OTHER_ORG, userId: REP_B }))).toBe("not_found");
    expect(await prisma.job.count({ where: { kind: REVEAL_JOB } })).toBe(0);
  });

  it("@proof makes a double press one approval, and refuses a reload's second press; keep and drop are then final", async () => {
    const { campaign, chosen } = await found();
    await decide(campaign, chosen[0]!.id);
    const requestId = randomUUID();
    const first = await approve(campaign, { requestId });
    const again = await approve(campaign, { requestId, expected: { toReveal: 1, known: 0, maxCredits: 1 } });
    expect(first.repeated).toBe(false);
    expect(again.repeated).toBe(true);
    expect(await prisma.job.count({ where: { kind: REVEAL_JOB } })).toBe(1);
    expect(await prisma.event.count({ where: { kind: CAMPAIGN_REVEAL_CONFIRMED } })).toBe(1);
    // A reloaded page mints a new request id: refused, not a second reveal.
    expect(await refusalOf(approve(campaign, { expected: { toReveal: 1, known: 0, maxCredits: 1 } }))).toBe("wrong_state");
    expect(await refusalOf(decide(campaign, chosen[1]!.id))).toBe("wrong_state");
    expect(await refusalOf(decide(campaign, chosen[0]!.id, "dropped"))).toBe("wrong_state");
  });
});

describe("the reveal job", () => {
  it("@proof writes the Person, the provider record, the campaign row, the reveal ledger and one Event, and the page shows the email", async () => {
    const { campaign, chosen } = await found();
    await decide(campaign, chosen[0]!.id);
    await decide(campaign, chosen[1]!.id);
    await approve(campaign);
    const job = await revealJob(campaign.id);
    await reveal(job, [{ contacts: everyone({ [chosen[1]!.providerId]: contact(Number(chosen[1]!.providerId.slice(2)), { emails: [] }) }), charged: 1 }]);

    const first = await prisma.campaignPerson.findUniqueOrThrow({ where: { id: chosen[0]!.id }, include: { person: true } });
    const n = Number(chosen[0]!.providerId.slice(2));
    expect(first).toMatchObject({ reveal: "revealed", revealHold: null, source: "bought" });
    expect(first.revealedAt).not.toBeNull();
    expect(first.person).toMatchObject({ orgId: ORG, email: `person${n}@firm${n}.co.uk`, emailType: "work", grade: "A+", name: `Person ${n}` });
    expect(await prisma.providerIdentity.findFirstOrThrow({ where: { orgId: ORG, providerId: chosen[0]!.providerId } })).toMatchObject({ status: "usable", personId: first.personId });
    // No email: the record is marked, no Person is made, and the row says why.
    expect(await prisma.campaignPerson.findUniqueOrThrow({ where: { id: chosen[1]!.id } })).toMatchObject({ reveal: "no_email", revealHold: "no_email", personId: null });
    expect(await prisma.providerIdentity.findFirstOrThrow({ where: { orgId: ORG, providerId: chosen[1]!.providerId } })).toMatchObject({ status: "no_email", personId: null });

    const confirmEvent = await prisma.event.findFirstOrThrow({ where: { kind: CAMPAIGN_REVEAL_CONFIRMED } });
    const ledger = await revealCredits();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ kind: "reveal", state: "reconciled", charged: 1, worstCase: 2, confirmEventId: confirmEvent.id, jobId: job.id });
    const events = await prisma.event.findMany({ where: { kind: LEADGEN_REVEALED } });
    expect(events).toHaveLength(1);
    expect(events[0]!.after).toMatchObject({ jobId: job.id, tally: { revealed: 1, no_email: 1 }, spend: { charged: 1, reserved: 0 } });
    // The Event names nobody's email.
    expect(JSON.stringify(events[0]!.after)).not.toContain("@");

    const drawn = await view(campaign);
    expect(drawn.state).toBe("peopleReady");
    expect(drawn.peopleFound?.phase).toBe("ready");
    const people = drawn.peopleFound!.accounts.flatMap((account) => account.people);
    expect(people).toHaveLength(2);
    expect(people.find((person) => person.id === chosen[0]!.id)).toMatchObject({ reveal: "revealed", email: `person${n}@firm${n}.co.uk`, revealWhy: null });
    expect(people.find((person) => person.id === chosen[1]!.id)).toMatchObject({ reveal: "no_email", email: null });
    expect(drawn.peopleFound?.revealResult).toMatchObject({ tally: { revealed: 1, no_email: 1 }, charged: 1, reserved: 0, maxCredits: 2, notKept: 8 });
  });

  it("@proof is idempotent: a retried job after its result buys nothing more", async () => {
    const { campaign, chosen } = await found();
    await decide(campaign, chosen[0]!.id);
    await approve(campaign);
    const job = await revealJob(campaign.id);
    await reveal(job, [{ contacts: everyone(), charged: 1 }]);
    const { provider } = await reveal(job, [], { attempt: 2 });
    expect(provider.calls).toHaveLength(0);
    expect(await prisma.event.count({ where: { kind: LEADGEN_REVEALED } })).toBe(1);
    expect(await revealCredits()).toHaveLength(1);
  });

  it("@proof keeps an earlier attempt's open reservation held, and the retry cannot buy the same people again", async () => {
    const { campaign, chosen } = await found();
    await decide(campaign, chosen[0]!.id);
    await approve(campaign);
    const job = await revealJob(campaign.id);
    const confirmEvent = await prisma.event.findFirstOrThrow({ where: { kind: CAMPAIGN_REVEAL_CONFIRMED } });
    // Attempt 1 reserved and died before hearing back.
    await prisma.creditLedgerEntry.create({
      data: { orgId: ORG, campaignId: campaign.id, briefVersion: 1, confirmEventId: confirmEvent.id, jobId: job.id, kind: "reveal", key: `campaign:${campaign.id}:reveal:v1:b0:a1:job:${job.id}:a1`, worstCase: 1, state: "reserved" },
    });
    const { provider } = await reveal(job, [{ contacts: everyone(), charged: 1 }], { attempt: 2 });
    expect(provider.calls).toHaveLength(0);
    expect((await revealCredits()).map((entry) => entry.state)).toEqual(["unreconciled"]);
    expect(await prisma.campaignPerson.findUniqueOrThrow({ where: { id: chosen[0]!.id } })).toMatchObject({ reveal: "failed", personId: null });
    expect((await view(campaign)).peopleFound?.revealResult).toMatchObject({ charged: 0, reserved: 1 });
  });

  it("@proof releases a request that never left Relay, and holds one that may have been sent", async () => {
    const released = await found();
    await decide(released.campaign, released.chosen[0]!.id);
    await approve(released.campaign);
    await reveal(await revealJob(released.campaign.id), [{ error: "not_sent" }, { contacts: everyone(), charged: 1 }]);
    expect((await revealCredits()).map((entry) => [entry.state, entry.charged])).toEqual([
      ["released", null],
      ["reconciled", 1],
    ]);
    expect(await prisma.campaignPerson.findUniqueOrThrow({ where: { id: released.chosen[0]!.id } })).toMatchObject({ reveal: "revealed" });

    await emptyAll();
    for (const id of [ORG]) await mutate(prisma, { orgId: id, actor: { kind: "system" }, kind: "org.created", apply: (tx) => tx.org.create({ data: { id, name: id } }) });
    await mutate(prisma, { orgId: ORG, actor: { kind: "system" }, kind: "user.upserted", apply: (tx) => tx.user.create({ data: { id: REP, orgId: ORG, email: `${REP}@example.test` } }) });
    const held = await found();
    await decide(held.campaign, held.chosen[0]!.id);
    await approve(held.campaign);
    const { provider } = await reveal(await revealJob(held.campaign.id), [{ error: "timeout" }]);
    expect(provider.calls).toHaveLength(1);
    expect((await revealCredits()).map((entry) => [entry.state, entry.worstCase])).toEqual([["unreconciled", 1]]);
    expect(await prisma.campaignPerson.findUniqueOrThrow({ where: { id: held.chosen[0]!.id } })).toMatchObject({ reveal: "failed" });
    expect((await view(held.campaign)).peopleFound?.revealResult).toMatchObject({ charged: 0, reserved: 1, tally: { failed: 1 } });
  });
});

describe("reuse, never twice, and suppression", () => {
  it("@proof reuses an owned email for no credit, and a second campaign never buys the same person again", async () => {
    const owned = await prisma.person.create({ data: { orgId: ORG, email: "owned@firm1.co.uk", emailType: "work", grade: "A", name: "Person 1" } });
    await prisma.providerIdentity.create({ data: { orgId: ORG, provider: "lusha", providerId: "l-001", personId: owned.id, status: "usable" } });

    const one = await found();
    await decide(one.campaign, one.byProvider.get("l-001")!.id);
    await decide(one.campaign, one.byProvider.get("l-002")!.id);
    expect((await view(one.campaign)).peopleFound?.revealPlan).toMatchObject({ kept: 2, known: 1, toReveal: 1, maxCredits: 1 });
    await approve(one.campaign);
    const first = await reveal(await revealJob(one.campaign.id), [{ contacts: everyone(), charged: 1 }]);
    expect(first.provider.calls.map((call) => call.providerIds)).toEqual([["l-002"]]);
    expect(await prisma.campaignPerson.findUniqueOrThrow({ where: { id: one.byProvider.get("l-001")!.id } })).toMatchObject({ reveal: "known", personId: owned.id, source: "reused" });

    // A second campaign finds both again: both are Relay's already, so nothing is bought.
    const two = await found();
    expect(two.byProvider.get("l-002")).toMatchObject({ source: "reused" });
    await decide(two.campaign, two.byProvider.get("l-001")!.id);
    await decide(two.campaign, two.byProvider.get("l-002")!.id);
    expect((await view(two.campaign)).peopleFound?.revealPlan).toMatchObject({ kept: 2, known: 2, toReveal: 0, maxCredits: 0 });
    await approve(two.campaign);
    const second = await reveal(await revealJob(two.campaign.id), []);
    expect(second.provider.calls).toHaveLength(0);
    const emails = (await view(two.campaign)).peopleFound!.accounts.flatMap((account) => account.people).map((person) => [person.reveal, person.email]);
    expect(emails).toEqual([
      ["known", "owned@firm1.co.uk"],
      ["known", "person2@firm2.co.uk"],
    ]);
    expect((await revealCredits()).reduce((total, entry) => total + (entry.charged ?? 0), 0)).toBe(1);
  });

  it("@proof never buys a record again that came back with no email, whichever campaign finds it", async () => {
    const one = await found();
    await decide(one.campaign, one.byProvider.get("l-003")!.id);
    await approve(one.campaign);
    await reveal(await revealJob(one.campaign.id), [{ contacts: everyone({ "l-003": contact(3, { emails: [] }) }), charged: 0 }]);
    const two = await found();
    // Held before ranking in the next search: never chosen, so never offered for a reveal.
    expect(two.byProvider.has("l-003")).toBe(false);
  });

  it("@proof blocks a person under an org-wide do-not-contact, and writes a CRM opt-out org-wide", async () => {
    const { campaign, byProvider } = await found();
    await prisma.contactSuppression.create({ data: { orgId: ORG, kind: "domain", value: "firm2.co.uk", reason: "dnc", source: "test" } });
    await decide(campaign, byProvider.get("l-001")!.id);
    await decide(campaign, byProvider.get("l-002")!.id);
    expect((await view(campaign)).peopleFound?.revealPlan).toMatchObject({ kept: 2, toReveal: 1, unavailable: 1, maxCredits: 1 });
    await approve(campaign);
    const optOut = { isCustomerDomain: async () => false, emailStatus: async (email: string) => ({ optOut: email === "person1@firm1.co.uk", isCustomer: false }) };
    const { provider } = await reveal(await revealJob(campaign.id), [{ contacts: everyone(), charged: 1 }], { crm: optOut });
    expect(provider.calls.map((call) => call.providerIds)).toEqual([["l-001"]]);
    expect(await prisma.campaignPerson.findUniqueOrThrow({ where: { id: byProvider.get("l-002")!.id } })).toMatchObject({ reveal: "suppressed", revealHold: "dnc" });
    expect(await prisma.campaignPerson.findUniqueOrThrow({ where: { id: byProvider.get("l-001")!.id } })).toMatchObject({ reveal: "suppressed", revealHold: "opted_out" });
    expect(await prisma.contactSuppression.findFirst({ where: { orgId: ORG, kind: "email", value: "person1@firm1.co.uk" } })).toMatchObject({ reason: "opted_out", source: "zoho" });
    // Neither email is shown as ready.
    expect((await view(campaign)).peopleFound!.accounts.flatMap((account) => account.people).every((person) => person.email === null)).toBe(true);
  });
});

describe("two kinds of spend", () => {
  it("@proof never counts reveal credits against the search limit, while the balance counts both", async () => {
    const { campaign, chosen } = await found();
    const searchConfirm = await findConfirmEvent(prisma, { orgId: ORG, campaignId: campaign.id, briefVersion: 1 });
    const searchBefore = await confirmSpend(prisma, { orgId: ORG, confirmEventId: searchConfirm!.id });
    await decide(campaign, chosen[0]!.id);
    await decide(campaign, chosen[1]!.id);
    await approve(campaign);
    await reveal(await revealJob(campaign.id), [{ contacts: everyone(), charged: 2 }]);
    expect(await confirmSpend(prisma, { orgId: ORG, confirmEventId: searchConfirm!.id })).toEqual(searchBefore);

    // Even a reveal row filed under the search's own approval would not use up the search limit.
    const job = await prisma.job.findFirstOrThrow({ where: { campaignId: campaign.id, kind: LEAD_GEN_JOB } });
    await prisma.creditLedgerEntry.create({
      data: { orgId: ORG, campaignId: campaign.id, briefVersion: 1, confirmEventId: searchConfirm!.id, jobId: job.id, kind: "reveal", key: "stray-reveal", worstCase: 5, charged: 5, state: "reconciled" },
    });
    const scope = { orgId: ORG, campaignId: campaign.id, briefVersion: 1, confirmEventId: searchConfirm!.id, jobId: job.id, attempt: 9, pricingAssumptions: DOCUMENTED_UNVERIFIED_PRICING.id };
    const capOnly = persistedSpend(prisma, { ...scope, cap: searchBefore.charged + 1, balance: { remaining: 1000, readAt: new Date(Date.now() - 60 * 60_000) } });
    expect(await capOnly.canReserve(1)).toBe(true);
    // The balance read before all of it counts the search, the reveal and the stray row alike.
    const balanceOnly = persistedSpend(prisma, { ...scope, cap: 1000, balance: { remaining: searchBefore.charged + 2 + 5, readAt: new Date(Date.now() - 60 * 60_000) } });
    expect(await balanceOnly.canReserve(1)).toBe(false);
  });
});

describe("org isolation", () => {
  it("@proof never reuses, reads or writes another org's people, records or suppressions", async () => {
    const theirs = await prisma.person.create({ data: { orgId: OTHER_ORG, email: "person1@firm1.co.uk", emailType: "work", grade: "A", name: "Person 1" } });
    await prisma.providerIdentity.create({ data: { orgId: OTHER_ORG, provider: "lusha", providerId: "l-001", personId: theirs.id, status: "usable" } });
    await prisma.contactSuppression.create({ data: { orgId: OTHER_ORG, kind: "domain", value: "firm1.co.uk", reason: "dnc", source: "test" } });

    const { campaign, byProvider } = await found();
    expect(byProvider.get("l-001")).toMatchObject({ source: "bought", personId: null });
    await decide(campaign, byProvider.get("l-001")!.id);
    expect((await view(campaign)).peopleFound?.revealPlan).toMatchObject({ known: 0, toReveal: 1, unavailable: 0 });
    await approve(campaign);
    const { provider } = await reveal(await revealJob(campaign.id), [{ contacts: everyone(), charged: 1 }]);
    expect(provider.calls).toHaveLength(1);
    const mine = await prisma.campaignPerson.findUniqueOrThrow({ where: { id: byProvider.get("l-001")!.id }, include: { person: true } });
    expect(mine.person).toMatchObject({ orgId: ORG, email: "person1@firm1.co.uk" });
    expect(mine.personId).not.toBe(theirs.id);
    // Their org is exactly as it was.
    expect(await prisma.person.count({ where: { orgId: OTHER_ORG } })).toBe(1);
    expect(await prisma.providerIdentity.findFirstOrThrow({ where: { orgId: OTHER_ORG, providerId: "l-001" } })).toMatchObject({ personId: theirs.id, status: "usable" });
    expect(await prisma.creditLedgerEntry.count({ where: { orgId: OTHER_ORG } })).toBe(0);
  });
});

describe("the database", () => {
  it("refuses a reveal on someone not kept, and a usable email with no Person", async () => {
    const { chosen } = await found();
    await expect(prisma.campaignPerson.update({ where: { id: chosen[0]!.id }, data: { reveal: "no_email", revealedAt: new Date() } })).rejects.toThrow();
    await prisma.campaignPerson.update({ where: { id: chosen[1]!.id }, data: { review: "kept", reviewedAt: new Date(), reviewedByUserId: REP } });
    await expect(prisma.campaignPerson.update({ where: { id: chosen[1]!.id }, data: { reveal: "revealed", revealedAt: new Date() } })).rejects.toThrow();
    await expect(prisma.campaignPerson.update({ where: { id: chosen[1]!.id }, data: { reveal: "no_email" } })).rejects.toThrow();
  });
});
