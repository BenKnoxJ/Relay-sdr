import { describe, expect, it } from "vitest";

import { FakeLeadGenProvider, type FakeStep } from "@/lib/leadgen/fakeProvider";
import { findPeople } from "@/lib/leadgen/findPeople";
import { DOCUMENTED_UNVERIFIED_PRICING, SearchSpend, inMemorySpend, type SpendPort } from "@/lib/leadgen/spend";
import type { ProviderCandidate } from "@/lib/leadgen/provider";

import { NO_CRM } from "@/lib/leadgen/crm";

import { NO_WAIT, VOCABULARY, handoff, handoffV2, knowledge } from "./harness";

/**
 * The account-led search, leadgen v2.2 §4a, on a scripted provider: account
 * discovery through the runs titles one person per company, then one
 * complement search inside those accounts, within the Confirm cap. No
 * network, no spend, no Research.
 */

let n = 0;
function at(account: string, title: string, over: Partial<ProviderCandidate> = {}): ProviderCandidate {
  n += 1;
  return {
    providerId: `al-${String(n).padStart(3, "0")}`,
    name: `Person ${n}`,
    title,
    company: `Account ${account}`,
    domain: `${account}.example`,
    countryIso2: "GB",
    city: "Leeds",
    hasEmail: true,
    emailRevealCredits: 1,
    ...over,
  };
}

/** Alternate the two runs titles, so the lead title limit (v2.2 §8a) is not what a test measures. */
const runs = (index: number) => (index % 2 === 0 ? "Head of Claims" : "Claims Operations Manager");
const step = (candidates: ProviderCandidate[], hasMore = false, charged = 1): FakeStep => ({ candidates, charged, hasMore });
const accounts = (count: number, from = 1) => Array.from({ length: count }, (_, index) => `acct${String(from + index).padStart(2, "0")}`);
const deps = (provider: FakeLeadGenProvider) => ({ provider, vocabulary: VOCABULARY, knowledge: knowledge(), crm: NO_CRM, retry: NO_WAIT });

describe("the account-led search (v2.2 §4a)", () => {
  it("@proof finds accounts through the runs titles, then asks for the missing roles inside them: 10 + 10 credits for 20 people", async () => {
    const discovered = accounts(10).map((account, index) => at(account, runs(index)));
    const complements = accounts(10).flatMap((account, index) => (index < 5 ? [at(account, "Complaints Manager"), at(account, "Chief Operating Officer")] : []));
    const provider = new FakeLeadGenProvider([step(discovered), step(complements)]);
    const result = await findPeople(handoffV2(), deps(provider));

    // Search 1: runs titles only, one person per company, the smallest page for ten accounts.
    expect(provider.calls[0]).toMatchObject({
      page: 0,
      pageSize: 10,
      filters: { titles: ["Head of Claims", "Claims Operations Manager"], maxContactsPerCompany: 1 },
    });
    expect(provider.calls[0]?.filters.companyDomains).toBeUndefined();
    // Search 2: the champions and signs titles, inside the ten accounts, two more at most each, the smallest page for the ten left.
    expect(provider.calls[1]).toMatchObject({
      pageSize: 10,
      filters: {
        titles: ["Claims Quality Manager", "Head of Customer Relations", "Complaints Manager", "Claims Director", "Chief Operating Officer"],
        maxContactsPerCompany: 2,
        companyDomains: accounts(10).map((account) => `${account}.example`),
      },
    });
    expect(provider.calls).toHaveLength(2);
    // Each request reserved its own worst case, and together they fit the cap of 20.
    expect(result.ledger.map((entry) => entry.worstCase)).toEqual([10, 10]);
    expect(result.ledger.reduce((total, entry) => total + entry.worstCase, 0)).toBeLessThanOrEqual(20);

    if (result.output.phase !== "pick") throw new Error("tests: expected people");
    expect(result.output.found).toEqual({ n: 20, ofM: 20 });
    expect(result.output.chosen.filter((person) => person.role?.part === "runs")).toHaveLength(10);
    expect(result.output.chosen.filter((person) => person.role?.part === "champions")).toHaveLength(5);
    expect(result.output.chosen.filter((person) => person.role?.part === "signs")).toHaveLength(5);
  });

  it("@proof halts over the cap before any search when the cap cannot cover discovery and the smallest complement", async () => {
    const provider = new FakeLeadGenProvider([]);
    const result = await findPeople(handoffV2((h) => (h.spend.searchCreditCap = 15)), deps(provider));
    expect(result.output).toMatchObject({ phase: "needs_you", reason: "over_cap" });
    expect(provider.calls).toHaveLength(0);
    expect(result.ledger).toHaveLength(0);
  });

  it("makes the complement request smaller to stay inside the cap, and never below the provider's minimum", async () => {
    // 50 asked for: 25 accounts at 25 credits, then a complement that wants 25 but has 15 left under a cap of 40.
    const provider = new FakeLeadGenProvider([
      step(accounts(25).map((account, index) => at(account, runs(index))), false, 25),
      step(accounts(15).map((account) => at(account, "Chief Operating Officer")), false, 15),
    ]);
    const result = await findPeople(handoffV2((h) => ((h.howMany = 50), (h.spend.searchCreditCap = 40))), deps(provider));
    expect(provider.calls.map((call) => call.pageSize)).toEqual([25, 15]);
    expect(result.ledger.reduce((total, entry) => total + (entry.charged ?? entry.worstCase), 0)).toBeLessThanOrEqual(40);
  });

  it("skips the complement when another run has used the room it needed, and says the cap stopped it", async () => {
    const pricing = DOCUMENTED_UNVERIFIED_PRICING;
    const inner = inMemorySpend(new SearchSpend(20, 100, pricing));
    let spentElsewhere = false;
    // Another campaign in the org reserves 12 credits the moment discovery is paid for.
    const spend: SpendPort = {
      ...inner,
      reconcile: async (key, charged) => {
        await inner.reconcile(key, charged);
        if (!spentElsewhere) spentElsewhere = await inner.tryReserve("another-run", 12);
      },
    };
    const provider = new FakeLeadGenProvider([step(accounts(10).map((account, index) => at(account, runs(index))))]);
    const result = await findPeople(handoffV2(), { ...deps(provider), spend, pricing });
    expect(spentElsewhere).toBe(true);
    expect(provider.calls).toHaveLength(1);
    expect(result.output).toMatchObject({ phase: "pick", found: { n: 10, ofM: 20 }, shortfall: "cap_reached" });
  });

  it("ignores anyone the complement search returns outside the accounts it asked about", async () => {
    const provider = new FakeLeadGenProvider([
      step(accounts(10).map((account, index) => at(account, runs(index)))),
      step([at("acct01", "Chief Operating Officer"), at("stranger", "Chief Operating Officer")]),
    ]);
    const result = await findPeople(handoffV2(), deps(provider));
    if (result.output.phase !== "pick") throw new Error("tests: expected people");
    expect(result.output.chosen.map((person) => person.companyKey)).not.toContain("stranger.example");
  });

  it("pages discovery only while short of the target and more remain, as §4a says, and never past the cap", async () => {
    // A page with one lead and some weak titles is short of the target; more remain, so the next page is asked for (§4a).
    const provider = new FakeLeadGenProvider([
      step([at("a", "Office Manager"), at("b", "Office Manager"), at("c", runs(0))], true),
      step(accounts(10).map((account, index) => at(account, runs(index)))),
      step([]),
    ]);
    const result = await findPeople(handoffV2((h) => (h.spend.searchCreditCap = 30)), deps(provider));
    expect(provider.calls.map((call) => call.key.replace(/^campaign:[^:]+:lead_gen:v\d+:/, ""))).toEqual(["accounts:p0:a1", "accounts:p1:a1", "complement:a1"]);
    expect(result.output).toMatchObject({ phase: "pick", found: { n: 11, ofM: 20 } });
  });

  it("moves to the next part after a page that leaves no lead, rather than paging weak results to the cap", async () => {
    // Only weak titles and more remain: the runs pass hands over to champions instead of asking for page 2.
    const provider = new FakeLeadGenProvider([
      step([at("a", "Office Manager"), at("b", "Office Manager")], true),
      step(accounts(10).map((account) => at(account, "Complaints Manager"))),
      step([]),
    ]);
    const result = await findPeople(handoffV2((h) => (h.spend.searchCreditCap = 30)), deps(provider));
    expect(provider.calls.map((call) => call.key.replace(/^campaign:[^:]+:lead_gen:v\d+:/, ""))).toEqual([
      "accounts:p0:a1",
      "accounts:champions:p0:a1",
      "complement:a1",
    ]);
    expect(result.output).toMatchObject({ phase: "pick", found: { n: 10, ofM: 20 } });
  });

  it("keeps paging the last part when a page leaves no lead, since there is no part to move to", async () => {
    const provider = new FakeLeadGenProvider([step([at("a", "Office Manager")], true), step(accounts(3).map((account, index) => at(account, runs(index))))]);
    const result = await findPeople(
      handoffV2((h) => {
        h.targeting.titles = ["Head of Claims", "Claims Operations Manager"];
        h.spend.searchCreditCap = 30;
      }),
      deps(provider),
    );
    expect(provider.calls.map((call) => call.key.replace(/^campaign:[^:]+:lead_gen:v\d+:/, ""))).toEqual(["accounts:p0:a1", "accounts:p1:a1"]);
    expect(result.output).toMatchObject({ phase: "pick", found: { n: 3, ofM: 20 } });
  });

  it("@proof stops discovery mid-way when the cap cannot cover another page and the smallest complement", async () => {
    // Four lead accounts, more remain, but a cap of 20 leaves 19 after the first page: not enough for 10 + 10.
    const provider = new FakeLeadGenProvider([step(accounts(4).map((account, index) => at(account, runs(index))), true), step([])]);
    const result = await findPeople(handoffV2(), deps(provider));
    expect(provider.calls.map((call) => call.key.replace(/^campaign:[^:]+:lead_gen:v\d+:/, ""))).toEqual(["accounts:p0:a1", "complement:a1"]);
    expect(result.output).toMatchObject({ phase: "pick", found: { n: 4, ofM: 20 }, shortfall: "cap_reached" });
  });

  it("@proof leaves an account with no domain out of the complement search", async () => {
    const provider = new FakeLeadGenProvider([
      step([...accounts(9).map((account, index) => at(account, runs(index))), at("nodomain", "Head of Claims", { domain: undefined, companyId: "co-9" })]),
      step([]),
    ]);
    await findPeople(handoffV2(), deps(provider));
    const domains = provider.calls[1]?.filters.companyDomains ?? [];
    expect(domains).toHaveLength(9);
    expect(domains.some((domain) => domain.includes("nodomain"))).toBe(false);
  });

  it("says why it is short: fewer strong matches whenever the cap did not stop it (§8a)", async () => {
    // Every account offers a runs lead and a second runs person, never another role: Relay stops rather than add a second runs.
    const padded = new FakeLeadGenProvider([
      step(accounts(10).map((account, index) => at(account, runs(index)))),
      step(accounts(10).map((account) => at(account, "Claims Operations Manager"))),
    ]);
    const short = await findPeople(handoffV2(), deps(padded));
    expect(short.output).toMatchObject({ phase: "pick", shortfall: "fewer_strong_matches" });
    if (short.output.phase !== "pick") throw new Error("tests: expected people");
    // One runs person per account at most: never a second runs person to make up the number.
    expect(short.output.found.n).toBeLessThanOrEqual(10);
    expect(new Set(short.output.chosen.map((person) => person.companyKey)).size).toBe(short.output.found.n);

    const ran = new FakeLeadGenProvider([step(accounts(3).map((account, index) => at(account, runs(index)))), step([])]);
    expect((await findPeople(handoffV2(), deps(ran))).output).toMatchObject({ phase: "pick", found: { n: 3, ofM: 20 }, shortfall: "fewer_strong_matches" });
  });

  it("makes one search only when the recipe's titles name one part", async () => {
    const provider = new FakeLeadGenProvider([step(accounts(10).map((account, index) => at(account, runs(index))))]);
    await findPeople(handoffV2((h) => (h.targeting.titles = ["Head of Claims"])), deps(provider));
    expect(provider.calls).toHaveLength(1);
  });

  it("@proof falls back to the next role's titles when the runs titles find no accounts, then asks for the rest inside them", async () => {
    const provider = new FakeLeadGenProvider([
      step([]),
      step(accounts(10).map((account) => at(account, "Complaints Manager"))),
      step(accounts(10).map((account) => at(account, "Chief Operating Officer"))),
    ]);
    const result = await findPeople(handoffV2((h) => (h.spend.searchCreditCap = 30)), deps(provider));
    expect(provider.calls.map((call) => call.key.replace(/^campaign:[^:]+:lead_gen:v\d+:/, ""))).toEqual([
      "accounts:p0:a1",
      "accounts:champions:p0:a1",
      "complement:a1",
    ]);
    expect(provider.calls[1]?.filters).toMatchObject({
      titles: ["Claims Quality Manager", "Head of Customer Relations", "Complaints Manager"],
      maxContactsPerCompany: 1,
    });
    expect(provider.calls[1]?.filters.companyDomains).toBeUndefined();
    // The complement asks for the other parts, runs and signs, inside the accounts champions found.
    expect(provider.calls[2]?.filters).toMatchObject({
      titles: ["Head of Claims", "Claims Operations Manager", "Claims Director", "Chief Operating Officer"],
      companyDomains: accounts(10).map((account) => `${account}.example`),
    });
    expect(result.output).toMatchObject({ phase: "pick", found: { n: 20, ofM: 20 } });
    expect(result.ledger.reduce((total, entry) => total + entry.worstCase, 0)).toBeLessThanOrEqual(30);
  });

  it("falls back to the signs titles when neither runs nor champions titles find an account", async () => {
    const provider = new FakeLeadGenProvider([step([]), step([]), step(accounts(3).map((account) => at(account, "Claims Director"))), step([])]);
    const result = await findPeople(handoffV2((h) => (h.spend.searchCreditCap = 40)), deps(provider));
    expect(provider.calls.map((call) => call.key.replace(/^campaign:[^:]+:lead_gen:v\d+:/, ""))).toEqual([
      "accounts:p0:a1",
      "accounts:champions:p0:a1",
      "accounts:signs:p0:a1",
      "complement:a1",
    ]);
    expect(result.output).toMatchObject({ phase: "pick", found: { n: 3, ofM: 20 } });
  });

  it("@proof stops cleanly when the cap cannot cover a second discovery pass, and never spends past it", async () => {
    // A cap of 20: the first discovery page costs 10, leaving 10, not enough for a second page (10) and the smallest complement (10).
    const provider = new FakeLeadGenProvider([step([], false, 10)]);
    const result = await findPeople(handoffV2(), deps(provider));
    expect(provider.calls).toHaveLength(1);
    // The cap stopped the fallback, so the rep is told to raise it, not to change the recipe.
    expect(result.output).toMatchObject({ phase: "needs_you", reason: "over_cap" });
    expect(result.ledger.reduce((total, entry) => total + entry.worstCase, 0)).toBeLessThanOrEqual(20);
  });

  it("@proof leaves a V1 handoff on the v2.1 search: one title list, no per-company limit of one, no domains", async () => {
    const provider = new FakeLeadGenProvider([step(accounts(12).map((account, index) => at(account, runs(index))), false, 10)]);
    const result = await findPeople(handoff(), deps(provider));
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toMatchObject({ pageSize: 10, filters: { titles: ["Head of Claims", "Claims Operations Director"] } });
    expect(provider.calls[0]?.filters.maxContactsPerCompany).not.toBe(1);
    expect(provider.calls[0]?.filters.companyDomains).toBeUndefined();
    if (result.output.phase !== "pick") throw new Error("tests: expected people");
    // No roles on a v2.1 run.
    expect(result.output.chosen.every((person) => person.role === undefined)).toBe(true);
  });
});

describe("a search request that never left Relay (v2.2 note 2)", () => {
  const runsAccounts = () => step(accounts(10).map((account, index) => at(account, runs(index))));

  it("@proof releases a request that was never sent, so the retry and the complement still fit the cap", async () => {
    const provider = new FakeLeadGenProvider([{ error: "not_sent" }, runsAccounts(), step([at("acct01", "Chief Operating Officer")])]);
    const result = await findPeople(handoffV2(), deps(provider));
    // Never sent, then the retry, then the complement: all inside a cap of 20.
    expect(provider.calls.map((call) => call.key.replace(/^campaign:[^:]+:lead_gen:v\d+:/, ""))).toEqual(["accounts:p0:a1", "accounts:p0:a2", "complement:a1"]);
    expect(result.ledger.map((entry) => entry.state)).toEqual(["released", "reconciled", "reconciled"]);
    expect(result.output).toMatchObject({ phase: "pick", spend: { reserved: 0, charged: 2 } });
  });

  it("@proof keeps a request that may have been sent at its worst case, and the cap then counts it", async () => {
    const provider = new FakeLeadGenProvider([{ error: "timeout" }, runsAccounts()]);
    const result = await findPeople(handoffV2(), deps(provider));
    expect(result.ledger.map((entry) => entry.state)).toEqual(["unreconciled", "reconciled"]);
    // 10 held for the unknown attempt and 1 charged leave 9: no room for the smallest complement, so the cap stopped it.
    expect(provider.calls).toHaveLength(2);
    expect(result.output).toMatchObject({ phase: "pick", shortfall: "cap_reached", spend: { reserved: 10, charged: 1 } });
  });

  it("halts as busy when every attempt was refused before it left, having held nothing", async () => {
    const provider = new FakeLeadGenProvider([{ error: "not_sent" }, { error: "not_sent" }, { error: "not_sent" }]);
    const result = await findPeople(handoffV2(), deps(provider));
    expect(result.output).toMatchObject({ phase: "needs_you", reason: "provider_busy", spend: { reserved: 0, charged: 0 } });
    expect(result.ledger.every((entry) => entry.state === "released")).toBe(true);
  });
});
