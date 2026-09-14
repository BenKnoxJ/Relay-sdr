import { afterEach, describe, expect, it, vi } from "vitest";

import { leadgenOutputSchema, type Halt, type Pick } from "../../agents/leadgen/output.schema";
import { FakeLeadGenProvider, type FakeStep } from "@/lib/leadgen/fakeProvider";
import { findPeople, type FindPeopleDeps } from "@/lib/leadgen/findPeople";

import { NO_WAIT, VOCABULARY, candidate, crm, handoff, knowledge } from "./harness";

/**
 * Finding people end to end on a scripted provider: handoff, translation,
 * spend, holds and reuse, ranking, and the result (leadgen v2.1 §4 to §8).
 */

afterEach(() => vi.restoreAllMocks());

const page = (candidates: ReturnType<typeof candidate>[], hasMore = false, charged = candidates.length): FakeStep => ({ candidates, charged, hasMore });
const range = (from: number, to: number, over: Parameters<typeof candidate>[1] = {}) =>
  Array.from({ length: to - from + 1 }, (_, index) => candidate(from + index, over));

function deps(steps: FakeStep[], over: Partial<FindPeopleDeps> = {}): FindPeopleDeps & { provider: FakeLeadGenProvider } {
  return { provider: new FakeLeadGenProvider(steps), vocabulary: VOCABULARY, knowledge: knowledge(), crm: crm(), retry: NO_WAIT, ...over } as FindPeopleDeps & {
    provider: FakeLeadGenProvider;
  };
}

function asPick(output: Pick | Halt): Pick {
  if (output.phase !== "pick") throw new Error(`expected people, got ${JSON.stringify(output)}`);
  return output;
}

describe("People found", () => {
  it("finds N and stops searching, with a result the output schema accepts", async () => {
    const d = deps([page(range(1, 12), true, 10)]);
    const result = await findPeople(handoff(), d);
    const pick = asPick(result.output);
    expect(pick.found).toEqual({ n: 10, ofM: 10 });
    expect(pick.shortfall).toBeUndefined();
    expect(result.stoppedBy).toBe("enough");
    expect(d.provider.calls).toHaveLength(1);
    expect(leadgenOutputSchema.safeParse(pick).success).toBe(true);
    expect(pick.spend).toMatchObject({ charged: 10, reserved: 0 });
  });

  it("keeps a useful partial result when the provider runs out: X of N", async () => {
    const result = await findPeople(handoff(), deps([page(range(1, 4))]));
    const pick = asPick(result.output);
    expect(pick.found).toEqual({ n: 4, ofM: 10 });
    expect(pick.shortfall).toBe("no_more_results");
  });

  it("keeps a useful partial result when the cap is reached, and never spends past it", async () => {
    const d = deps([page(range(1, 3), true, 10), page(range(4, 6), true, 10), page(range(7, 9), true, 10)]);
    const result = await findPeople(handoff((h) => (h.spend.searchCreditCap = 20)), d);
    const pick = asPick(result.output);
    expect(pick.found).toEqual({ n: 6, ofM: 10 });
    expect(pick.shortfall).toBe("cap_reached");
    expect(d.provider.calls).toHaveLength(2);
    expect(pick.spend.charged + pick.spend.reserved).toBeLessThanOrEqual(20);
  });

  it("returns Needs you when nobody eligible was found, and never tries another group or a wider search", async () => {
    const d = deps([page(range(1, 3, { countryIso2: "IE" }))]);
    const result = await findPeople(handoff(), d);
    expect(result.output).toMatchObject({ phase: "needs_you", reason: "no_candidates" });
    expect(d.provider.calls).toHaveLength(1);
    expect(result.holds.every((hold) => hold.reason === "wrong_geography")).toBe(true);
  });

  it("sends exactly the translated filters on every page, with one page size for the run", async () => {
    const d = deps([page(range(1, 3), true), page(range(4, 5), false)]);
    const result = await findPeople(handoff(), d);
    expect(d.provider.calls.map((call) => [call.page, call.pageSize])).toEqual([
      [0, 10],
      [1, 10],
    ]);
    for (const call of d.provider.calls) expect(call.filters).toEqual(result.translation?.filters);
    expect(d.provider.calls[0]?.filters.maxContactsPerCompany).toBe(3);
  });

  it("never reads sourceRank: a different rank gives the same search and the same people", async () => {
    const one = await findPeople(handoff(), deps([page(range(1, 5))]));
    const three = await findPeople(handoff((h) => (h.buyerGroup.sourceRank = 3)), deps([page(range(1, 5))]));
    expect(three.output).toEqual(one.output);
    expect(three.translation).toEqual(one.translation);
  });

  it("picks the same people whatever order the provider returned them in", async () => {
    const entries = [candidate(1, { title: "Claims Lead" }), candidate(2, { domain: "northgateclaims.co.uk" }), ...range(3, 14)];
    const forward = asPick((await findPeople(handoff(), deps([page(entries)]))).output);
    const backward = asPick((await findPeople(handoff(), deps([page([...entries].reverse())]))).output);
    expect(backward.chosen).toEqual(forward.chosen);
  });

  it("enforces three per company locally even when the provider ignores the limit", async () => {
    const pick = asPick((await findPeople(handoff(), deps([page(range(1, 6, { domain: "same.example" }))]))).output);
    expect(pick.chosen).toHaveLength(3);
    expect(pick.holdsApplied).toContainEqual({ reason: "company_cap", count: 3 });
  });
});

describe("halts before any search", () => {
  it("makes no provider call when the recipe cannot be translated without widening", async () => {
    const d = deps([]);
    const result = await findPeople(handoff((h) => (h.targeting.sizeBand = { min: 60, max: 150 })), d);
    expect(result.output).toMatchObject({ phase: "needs_you", reason: "would_widen", field: "sizeBand" });
    expect(d.provider.calls).toHaveLength(0);
  });

  it("asks the rep to choose an industry in plain words, and makes no call", async () => {
    const d = deps([]);
    const result = await findPeople(handoff((h) => (h.targeting.industries = ["Specialist insurance"])), d);
    expect(result.output).toMatchObject({ reason: "choose_industry", term: "Specialist insurance", choices: ["Insurance", "Insurance Brokers"] });
    expect(d.provider.calls).toHaveLength(0);
  });

  it("makes no call when even one page could cost more than the approved cap", async () => {
    const d = deps([]);
    const result = await findPeople(handoff((h) => (h.spend.searchCreditCap = 5)), d);
    expect(result.output).toMatchObject({ phase: "needs_you", reason: "over_cap" });
    expect(d.provider.calls).toHaveLength(0);
  });
});

describe("retries and unknown outcomes", () => {
  it("retries a busy provider, reserving again each time, and records every attempt", async () => {
    const d = deps([{ error: "busy" }, { error: "busy" }, page(range(1, 10))]);
    const result = await findPeople(handoff(), d);
    expect(asPick(result.output).found.n).toBe(10);
    expect(result.ledger.map((entry) => entry.state)).toEqual(["unreconciled", "unreconciled", "reconciled"]);
    expect(d.provider.calls.map((call) => call.key)).toEqual([
      "campaign:camp-1:lead_gen:v1:p0:a1",
      "campaign:camp-1:lead_gen:v1:p0:a2",
      "campaign:camp-1:lead_gen:v1:p0:a3",
    ]);
  });

  it("stops with provider_busy after three busy answers, keeping all three reservations", async () => {
    const result = await findPeople(handoff(), deps([{ error: "busy" }, { error: "busy" }, { error: "busy" }]));
    expect(result.output).toMatchObject({ phase: "needs_you", reason: "provider_busy", spend: { charged: 0, reserved: 30 } });
  });

  it("stops with took_too_long after three timeouts", async () => {
    const result = await findPeople(handoff(), deps([{ error: "timeout" }, { error: "timeout" }, { error: "timeout" }]));
    expect(result.output).toMatchObject({ reason: "took_too_long" });
  });

  it("cannot retry past the cap: an unknown outcome stays counted at its worst case", async () => {
    const d = deps([{ error: "timeout" }, { error: "timeout" }, page(range(1, 10))]);
    const result = await findPeople(handoff((h) => (h.spend.searchCreditCap = 20)), d);
    expect(d.provider.calls).toHaveLength(2);
    expect(result.ledger.reduce((total, entry) => total + entry.worstCase, 0)).toBe(20);
    expect(result.output).toMatchObject({ phase: "needs_you", reason: "no_candidates" });
  });

  it("lets any other failure through, with its reservation kept", async () => {
    await expect(findPeople(handoff(), deps([{ error: "fail" }]))).rejects.toThrow(/scripted failure/);
  });
});

describe("reuse and holds in the run", () => {
  const owned = { id: "person-1", email: "person.1@firm1.co.uk", emailType: "work" as const, grade: "A" };

  it("reuses a person Relay already owns: chosen as reused, and nothing to buy for them", async () => {
    const d = deps([page(range(1, 3))], {
      knowledge: knowledge({ people: [owned], providerIdentities: [{ provider: "lusha", providerId: "l-001", personId: "person-1", status: "usable" }] }),
    });
    const pick = asPick((await findPeople(handoff(), d)).output);
    expect(pick.chosen.find((person) => person.lushaId === "l-001")?.source).toBe("reused");
    expect(pick.revealEstimate).toEqual({ toBuy: 2, reused: 1, credits: 2 });
  });

  it("holds a person already enrolled in this campaign as a duplicate", async () => {
    const d = deps([page(range(1, 3))], {
      knowledge: knowledge({
        people: [owned],
        providerIdentities: [{ provider: "lusha", providerId: "l-001", personId: "person-1", status: "usable" }],
        enrolledPersonIds: ["person-1"],
      }),
    });
    const result = await findPeople(handoff(), d);
    expect(result.holds).toContainEqual({ providerId: "l-001", reason: "duplicate_in_campaign" });
  });

  it("holds a reused person whose email this campaign cannot use", async () => {
    const d = deps([page(range(1, 3))], {
      knowledge: knowledge({ people: [{ ...owned, grade: "B" }], providerIdentities: [{ provider: "lusha", providerId: "l-001", personId: "person-1", status: "usable" }] }),
    });
    expect((await findPeople(handoff(), d)).holds).toContainEqual({ providerId: "l-001", reason: "grade" });
  });

  it("counts an email the provider will reveal for free as nothing to buy", async () => {
    const pick = asPick((await findPeople(handoff(), deps([page([candidate(1, { emailRevealCredits: 0 }), candidate(2)])]))).output);
    expect(pick.revealEstimate).toEqual({ toBuy: 1, reused: 0, credits: 1 });
  });

  it("holds customer companies on a positive CRM answer, asking once per domain", async () => {
    const check = crm({ customerDomains: ["firm1.co.uk"] });
    const result = await findPeople(handoff(), deps([page([candidate(1), candidate(2, { domain: "firm1.co.uk" }), candidate(3)])], { crm: check }));
    expect(result.holds.filter((hold) => hold.reason === "customer")).toHaveLength(2);
    expect(check.asked.filter((question) => question === "domain:firm1.co.uk")).toHaveLength(1);
  });
});

describe("no network", () => {
  it("never makes a network request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("lead gen made a network request");
    });
    await findPeople(handoff(), deps([page(range(1, 3), true), page(range(4, 12))]));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
