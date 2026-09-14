import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it } from "vitest";

import { NO_CRM } from "@/lib/leadgen/crm";
import { findPeople } from "@/lib/leadgen/findPeople";
import { LushaProvider, OPEN_ENDED, clearLushaMetadataCache, lushaBalance, lushaCandidate, lushaEnvironment, lushaSearchBody } from "@/lib/leadgen/lusha";
import { ProviderBusyError, ProviderUnknownOutcomeError, type ProviderSearchRequest } from "@/lib/leadgen/provider";
import { LUSHA_V3_PRICING, SearchSpend, documentedWorstCaseCharge, inMemorySpend } from "@/lib/leadgen/spend";
import { INDUSTRY_ALIASES, translate } from "@/lib/leadgen/translate";
import { LUSHA_FIXTURES, LushaClient, LushaHttpError, recordedLushaFetch, type LushaContact, type LushaCountries } from "@/lib/services/lusha";

import { NO_WAIT, handoff, knowledge } from "./harness";

/**
 * Lead gen over Lusha V3, from recorded answers only: the vocabulary the
 * zero-spend check read, the translation that never widens, the request and
 * response mapping, the errors, and a whole run to People found X of N. No
 * network, no spend.
 */

const NOW = () => new Date("2026-09-14T16:00:00.000Z");
const page0 = JSON.parse(readFileSync(`${LUSHA_FIXTURES}/prospecting/page-0.json`, "utf8")).body as { results: LushaContact[] };
const countries = JSON.parse(readFileSync(`${LUSHA_FIXTURES}/contact-countries.json`, "utf8")).body.values as LushaCountries;

/** The recorded transport, counting every call, with an optional rewrite of any answer. */
function recorded(rewrite?: (path: string, body: unknown) => unknown) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const replay = recordedLushaFetch();
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ method: init?.method ?? "GET", path: url.pathname + url.search, ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) });
    const answer = await replay(input, init);
    if (rewrite === undefined) return answer;
    return new Response(JSON.stringify(rewrite(url.pathname, await answer.json())), { status: answer.status });
  };
  return { calls, client: new LushaClient("recorded", { fetchImpl, cacheKey: `test:${Math.random()}` }) };
}

/** The existing insurance campaign's recipe, as its Confirm froze it. */
const claims = () =>
  handoff((value) => {
    value.targeting.titles = [
      "Head of Claims",
      "Claims Operations Manager",
      "Claims Operations Director",
      "Head of Motor Claims",
      "Claims Quality Manager",
      "Quality Assurance Manager",
      "Head of Customer Relations",
      "Complaints Manager",
      "Claims Director",
      "Chief Operating Officer",
    ];
    value.targeting.excludeTitles = ["Claims Handler", "Contact Centre Agent", "Chief Executive Officer"];
    value.targeting.sizeBand = { min: 5, max: 250 };
    value.targeting.industries = ["General insurance — personal motor", "Non-standard and specialist motor insurance", "Motor insurance underwriting and claims"];
    value.seedFirms = [];
    value.howMany = 20;
    value.spend.searchCreditCap = 120;
    value.spend.balanceSnapshot.remaining = 500;
    value.spend.pricingAssumptions = LUSHA_V3_PRICING.id;
  });

beforeEach(() => clearLushaMetadataCache());

describe("the Lusha vocabulary", () => {
  it("is built from the recorded metadata: size buckets, main and sub industries, ISO countries", async () => {
    const { vocabulary } = await lushaEnvironment(recorded().client, claims(), NOW);
    expect(vocabulary.version).toBe("lusha-v3");
    expect(vocabulary.sizes).toEqual({
      kind: "buckets",
      buckets: [
        { min: 1, max: 10 },
        { min: 11, max: 50 },
        { min: 51, max: 200 },
        { min: 201, max: 500 },
        { min: 501, max: 1000 },
        { min: 1001, max: 5000 },
        { min: 5001, max: 10000 },
        { min: 10001, max: 100000 },
        { min: 100001, max: OPEN_ENDED },
      ],
    });
    expect(vocabulary.industries).toContainEqual({ id: "main:9", label: "Finance", level: "main" });
    expect(vocabulary.industries).toContainEqual({ id: "sub:44", label: "Insurance", level: "sub" });
    expect(vocabulary.countries).toContainEqual({ iso2: "GB", value: "GB" });
    expect(vocabulary.pageSize).toEqual({ min: 10, max: 50 });
    expect(vocabulary.maxContactsPerCompany).toBe(true);
  });

  it("carries when its metadata was read and a hash that changes only when the metadata does", async () => {
    const one = (await lushaEnvironment(recorded().client, claims(), NOW)).vocabulary.provenance!;
    clearLushaMetadataCache();
    const two = (await lushaEnvironment(recorded().client, claims(), NOW)).vocabulary.provenance!;
    expect(one).toEqual({ fetchedAt: "2026-09-14T16:00:00.000Z", hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(two.hash).toBe(one.hash);
    clearLushaMetadataCache();
    const changed = recorded((path, body) => (path.endsWith("/sizes") ? { values: [{ min: 1, max: 10 }] } : body));
    expect((await lushaEnvironment(changed.client, claims(), NOW)).vocabulary.provenance!.hash).not.toBe(one.hash);
  });

  it("reads the static metadata once per process, not once per run", async () => {
    const { calls, client } = recorded();
    await lushaEnvironment(client, claims(), NOW);
    await lushaEnvironment(client, claims(), NOW);
    expect(calls.filter((call) => call.path.includes("/filters/"))).toHaveLength(3);
  });
});

describe("translation against the real Lusha taxonomy", () => {
  it("narrows 5 to 250 people to the buckets wholly inside it, 11 to 200, and never takes 201 to 500", async () => {
    const { vocabulary } = await lushaEnvironment(recorded().client, claims(), NOW);
    const translated = translate(claims(), vocabulary, { industryAliases: INDUSTRY_ALIASES });
    if (!translated.ok) throw new Error(`tests: ${JSON.stringify(translated.halt)}`);
    expect(translated.filters.sizes).toEqual([
      { min: 11, max: 50 },
      { min: 51, max: 200 },
    ]);
    expect(translated.effective.sizeBand).toEqual({ min: 11, max: 200 });
  });

  it("never reaches the open top bucket, and halts when no bucket fits inside the band", async () => {
    const { vocabulary } = await lushaEnvironment(recorded().client, claims(), NOW);
    const wide = translate(handoff((value) => (value.targeting.sizeBand = { min: 1, max: 1_000_000 })), vocabulary);
    if (!wide.ok) throw new Error("tests: expected a translation");
    expect(wide.filters.sizes.some((size) => size.max === OPEN_ENDED)).toBe(false);
    expect(translate(handoff((value) => (value.targeting.sizeBand = { min: 5, max: 9 })), vocabulary)).toEqual({ ok: false, halt: { reason: "would_widen", field: "sizeBand" } });
  });

  it("maps the insurance campaign's three labels to Insurance (44) through the documented aliases, once", async () => {
    const { vocabulary } = await lushaEnvironment(recorded().client, claims(), NOW);
    const translated = translate(claims(), vocabulary, { industryAliases: INDUSTRY_ALIASES });
    if (!translated.ok) throw new Error(`tests: ${JSON.stringify(translated.halt)}`);
    expect(translated.filters.industryIds).toEqual(["sub:44"]);
    expect(translated.effective.industries.map((industry) => [industry.label, industry.via])).toEqual([
      ["Insurance", "alias"],
      ["Insurance", "alias"],
      ["Insurance", "alias"],
    ]);
  });

  it("matches an exact label directly, asks the rep about a near one, and halts on a term with nothing near it", async () => {
    const { vocabulary } = await lushaEnvironment(recorded().client, claims(), NOW);
    const exact = translate(handoff((value) => (value.targeting.industries = ["Insurance"])), vocabulary);
    expect(exact.ok && exact.filters.industryIds).toEqual(["sub:44"]);
    // Without the aliases the same recipe is not guessed at: the rep chooses.
    const near = translate(claims(), vocabulary, { industryAliases: {} });
    expect(near.ok).toBe(false);
    expect(!near.ok && near.halt.reason).toBe("choose_industry");
    expect(!near.ok && near.halt.reason === "choose_industry" && near.halt.choices).toContain("Insurance");
    const none = translate(handoff((value) => (value.targeting.industries = ["Quantum gardening"])), vocabulary);
    expect(none).toEqual({ ok: false, halt: { reason: "unmappable", field: "industry", term: "Quantum gardening" } });
  });

  it("sends GB as its ISO code, and halts on a country Lusha does not have", async () => {
    const { vocabulary } = await lushaEnvironment(recorded().client, claims(), NOW);
    const gb = translate(claims(), vocabulary, { industryAliases: INDUSTRY_ALIASES });
    expect(gb.ok && gb.filters.countries).toEqual(["GB"]);
    expect(translate(handoff((value) => (value.targeting.countries = ["XK"])), vocabulary)).toEqual({ ok: false, halt: { reason: "unmappable", field: "country", term: "XK" } });
  });

  it("@proof halts a GB Orkney recipe as unmappable: South Africa's Orkney is never used, and nothing is searched", async () => {
    const orkney = handoff((value) => {
      value.targeting.locations = ["Orkney"];
      value.places = [{ name: "Orkney", aliases: ["Orkney Islands"] }];
      value.spend.pricingAssumptions = LUSHA_V3_PRICING.id;
    });
    const { calls, client } = recorded();
    const environment = await lushaEnvironment(client, orkney, NOW);
    // Both spellings were looked up; the only place found is in South Africa.
    expect(calls.map((call) => call.path).filter((path) => path.includes("/locations"))).toEqual([
      "/v3/contacts/prospecting/filters/locations?query=Orkney",
      "/v3/contacts/prospecting/filters/locations?query=Orkney%20Islands",
    ]);
    expect(environment.vocabulary.locations).toEqual([{ value: "Orkney", level: "city", countryIso2: "ZA" }]);
    expect(translate(orkney, environment.vocabulary)).toEqual({ ok: false, halt: { reason: "unmappable", field: "location", term: "Orkney" } });

    const result = await findPeople(orkney, { ...environment, knowledge: knowledge(), crm: NO_CRM, retry: NO_WAIT, pricing: LUSHA_V3_PRICING });
    expect(result.output).toMatchObject({ phase: "needs_you", reason: "unmappable", field: "location", term: "Orkney" });
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });
});

describe("the search request and its answer", () => {
  const request = (over: Partial<ProviderSearchRequest["filters"]> = {}, page = 0): ProviderSearchRequest => ({
    key: "k",
    page,
    pageSize: 20,
    filters: {
      titles: ["Head of Claims"],
      excludeTitles: ["Claims Handler"],
      countries: ["GB"],
      locations: [],
      sizes: [
        { min: 11, max: 50 },
        { min: 51, max: 200 },
      ],
      industryIds: ["sub:44"],
      excludeDomains: ["excluded.example"],
      maxContactsPerCompany: 3,
      ...over,
    },
  });

  it("maps the filters to V3's request, with the per-company limit, and leaves exclusions to the local guards", () => {
    expect(lushaSearchBody(request(), countries)).toEqual({
      filters: {
        contacts: { include: { jobTitles: ["Head of Claims"], countries: ["GB"] } },
        companies: { include: { sizes: [{ min: 11, max: 50 }, { min: 51, max: 200 }], subIndustriesIds: [44] } },
      },
      options: { maxContactsPerCompany: 3 },
      pagination: { page: 0, size: 20 },
    });
  });

  it("sends a place as the literal values the lookup returned, a main industry by its own field, and the open bucket with no top", () => {
    const body = lushaSearchBody(
      request({ locations: [{ value: "Leeds", level: "city", countryIso2: "GB" }], industryIds: ["main:9", "sub:44"], sizes: [{ min: 100001, max: OPEN_ENDED }] }, 2),
      countries,
    );
    expect(body.filters.contacts.include.locations).toEqual([{ country: "United Kingdom", city: "Leeds" }]);
    expect(body.filters.companies?.include).toEqual({ sizes: [{ min: 100001 }], mainIndustriesIds: [9], subIndustriesIds: [44] });
    expect(body.pagination).toEqual({ page: 2, size: 20 });
  });

  it("maps a preview: names, title, firm, raw domain, ISO country, place, LinkedIn, whether an email exists and what it would cost", () => {
    const byId = (id: string) => lushaCandidate(page0.results.find((contact) => contact.id === id)!, countries);
    expect(byId("fx-001")).toEqual({
      providerId: "fx-001",
      name: "Alex Morgan",
      title: "Head of Claims",
      company: "Northfield Motor Insurance",
      domain: "northfield-motor.example",
      countryIso2: "GB",
      state: "England",
      city: "Leeds",
      linkedinUrl: "https://www.linkedin.com/in/fx-alex-morgan",
      hasEmail: true,
      emailRevealCredits: 1,
    });
    // Phones only: no email, and no email price.
    expect(byId("fx-004")).toMatchObject({ hasEmail: false, emailRevealCredits: null });
    // Already revealed: the email costs nothing.
    expect(byId("fx-005")).toMatchObject({ hasEmail: true, emailRevealCredits: 0 });
    expect(byId("fx-009")).toMatchObject({ countryIso2: "IE", city: "Dublin" });
    expect(byId("fx-014")).not.toHaveProperty("domain");
  });

  it("reports what the API charged, and whether another page exists from its total", async () => {
    const provider = new LushaProvider(recorded().client, countries);
    const answer = await provider.search(request());
    expect(answer.charged).toBe(1);
    expect(answer.candidates).toHaveLength(14);
    expect(answer.hasMore).toBe(false);
    const more = new LushaProvider(recorded((path, body) => (path === "/v3/contacts/prospecting" ? { ...(body as object), pagination: { page: 0, size: 20, total: 60 } } : body)).client, countries);
    expect((await more.search(request())).hasMore).toBe(true);
    const noTotal = new LushaProvider(
      recorded((path, body) =>
        path === "/v3/contacts/prospecting" ? { results: (body as { results: unknown[] }).results.slice(0, 10), billing: { creditsCharged: 1, resultsReturned: 10 } } : body,
      ).client,
      countries,
    );
    expect((await noTotal.search({ ...request(), pageSize: 10 })).hasMore).toBe(true);
  });

  it("turns a 429 into busy, no answer or a server fault into an unknown outcome, and passes anything else through", async () => {
    const failing = (status: number | "timeout") =>
      new LushaProvider(
        new LushaClient("k", {
          timeoutMs: 20,
          fetchImpl:
            status === "timeout"
              ? (_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))
              : async () => new Response("{}", { status }),
        }),
        countries,
      );
    await expect(failing(429).search(request())).rejects.toBeInstanceOf(ProviderBusyError);
    await expect(failing("timeout").search(request())).rejects.toBeInstanceOf(ProviderUnknownOutcomeError);
    await expect(failing(503).search(request())).rejects.toBeInstanceOf(ProviderUnknownOutcomeError);
    await expect(failing(400).search(request())).rejects.toBeInstanceOf(LushaHttpError);
  });
});

describe("a whole run on Lusha's shape", () => {
  it("@proof finds the insurance campaign's people from the recorded page: X of N, ranked the same whatever order Lusha sends", async () => {
    const run = async (reverse: boolean) => {
      clearLushaMetadataCache();
      const { calls, client } = recorded((path, body) =>
        reverse && path === "/v3/contacts/prospecting" ? { ...(body as object), results: [...(body as { results: unknown[] }).results].reverse() } : body,
      );
      const environment = await lushaEnvironment(client, claims(), NOW);
      const spend = inMemorySpend(new SearchSpend(120, 500, LUSHA_V3_PRICING));
      const result = await findPeople(claims(), { ...environment, knowledge: knowledge(), crm: NO_CRM, retry: NO_WAIT, pricing: LUSHA_V3_PRICING, spend });
      return { result, calls, spend: await spend.list() };
    };
    const { result, calls, spend } = await run(false);
    if (result.output.phase !== "pick") throw new Error(`tests: ${JSON.stringify(result.output)}`);
    // 14 returned: the Claims Handler is held for the excluded title, Dublin
    // for geography, and the fourth at Pennine for the per-company limit.
    expect(result.output.found).toEqual({ n: 11, ofM: 20 });
    expect(result.output.shortfall).toBe("no_more_results");
    expect(result.holds.map((hold) => [hold.providerId, hold.reason]).sort()).toEqual(
      [
        ["fx-007", "excluded_title"],
        ["fx-009", "wrong_geography"],
        ["fx-013", "company_cap"],
      ].sort(),
    );
    expect(result.output.chosen.filter((person) => person.company === "Pennine Insurance Services")).toHaveLength(3);
    // One search, reserved at the documented worst case for a page of 20 and reconciled to what Lusha charged.
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(spend).toEqual([{ key: "campaign:camp-1:lead_gen:v1:p0:a1", worstCase: documentedWorstCaseCharge(20, LUSHA_V3_PRICING), state: "reconciled", charged: 1 }]);
    expect(documentedWorstCaseCharge(20, LUSHA_V3_PRICING)).toBe(20);
    // What was searched is recorded in words, with the metadata it read.
    expect(result.translation?.effective.provenance?.fetchedAt).toBe("2026-09-14T16:00:00.000Z");

    const reversed = (await run(true)).result.output;
    if (reversed.phase !== "pick") throw new Error("tests: expected people");
    expect(reversed.chosen.map((person) => [person.lushaId, person.rank])).toEqual(result.output.chosen.map((person) => [person.lushaId, person.rank]));
  });
});

describe("the Lusha balance", () => {
  it("reads the account's remaining credits as a live balance", async () => {
    expect(await lushaBalance(recorded().client, NOW)).toEqual({ remaining: 900, used: 100, total: 1000, readAt: NOW(), source: "live" });
  });

  it("throws when usage cannot be read, rather than guessing", async () => {
    const down = new LushaClient("k", { fetchImpl: async () => new Response("{}", { status: 503 }) });
    await expect(lushaBalance(down)).rejects.toBeInstanceOf(LushaHttpError);
  });

  it("matches the account's recorded pricing: search 1 per 25 results, an email 1", () => {
    const usage = JSON.parse(readFileSync(`${LUSHA_FIXTURES}/account-usage.json`, "utf8")).body;
    expect(LUSHA_V3_PRICING.perBlock).toEqual({ size: usage.pricing.contactSearch.perQuantity, credits: usage.pricing.contactSearch.credits });
    expect(LUSHA_V3_PRICING.revealPerEmail).toBe(usage.pricing.revealEmail.credits);
    // The docs' per-result model is kept until the paid smoke settles it.
    expect(LUSHA_V3_PRICING.perResult).toBe(1);
  });
});
