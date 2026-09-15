import { describe, expect, it } from "vitest";

import { FakeRevealProvider, type FakeRevealStep } from "@/lib/leadgen/fakeProvider";
import { Knowledge, type OrgKnowledge } from "@/lib/leadgen/holds";
import type { RevealedContact } from "@/lib/leadgen/provider";
import { pickEmail, planReveal, revealEmails, revealTally, revealWorstCase, type RevealCandidate } from "@/lib/leadgen/reveal";
import { DOCUMENTED_UNVERIFIED_PRICING, SearchSpend, inMemorySpend } from "@/lib/leadgen/spend";

import { NO_WAIT, crm as crmOf, knowledge } from "./harness";

/**
 * Reveal emails, provider-free (lead gen v2.1 §6, §7, §9; v2.2 §9a): reuse
 * before buying, suppression, never buying an unusable record again, the
 * approved maximum on every request, partial answers, and a request that
 * never left Relay against one that may have been sent. A scripted provider
 * and an in-memory ledger; no network, no database.
 */

const PRICING = DOCUMENTED_UNVERIFIED_PRICING;
const BASE = "campaign:camp-1:reveal:v1";

function kept(n: number, over: Partial<RevealCandidate> = {}): RevealCandidate {
  return { id: `cp-${n}`, providerId: `l-${n}`, personId: null, name: `Person ${n}`, company: `Firm ${n}`, domain: `firm${n}.co.uk`, hasEmail: true, emailRevealCredits: 1, ...over };
}

function found(n: number, over: Partial<Extract<RevealedContact, { status: "found" }>> = {}): RevealedContact {
  return { status: "found", name: `Person ${n}`, domain: `www.firm${n}.co.uk`, emails: [{ address: `person${n}@firm${n}.co.uk`, type: "work", grade: "A+" }], ...over };
}

async function reveal(
  people: RevealCandidate[],
  steps: FakeRevealStep[],
  options: { knowledge?: OrgKnowledge; cap?: number; balance?: number; crm?: ReturnType<typeof crmOf>; maxIds?: number } = {},
) {
  const provider = new FakeRevealProvider(steps, options.maxIds);
  const org = options.knowledge ?? knowledge();
  const cap = options.cap ?? planReveal(people, new Knowledge(org), PRICING).counts.maxCredits;
  const ledger = new SearchSpend(cap, options.balance ?? 100, PRICING);
  const result = await revealEmails(people, { provider, knowledge: org, crm: options.crm ?? crmOf(), pricing: PRICING, spend: inMemorySpend(ledger), keyBase: BASE, retry: NO_WAIT });
  return { result, provider, ledger, byId: new Map(result.outcomes.map((outcome) => [outcome.id, outcome])) };
}

const OWNED = { id: "person-owned", email: "owned@firm1.co.uk", emailType: "work" as const, grade: "A" };

describe("before anything is bought", () => {
  it("@proof reuses an email the org already owns through the same record, for nothing, with no provider call", async () => {
    const org = knowledge({ people: [OWNED], providerIdentities: [{ provider: "lusha", providerId: "l-1", personId: OWNED.id, status: "usable" }] });
    const { result, provider, ledger } = await reveal([kept(1)], [], { knowledge: org });
    expect(result.plan.counts).toEqual({ kept: 1, known: 1, toReveal: 0, free: 0, maxCredits: 0, noEmail: 0, unavailable: 0 });
    expect(result.outcomes[0]).toMatchObject({ reveal: "known", hold: null, person: { existing: true, personId: OWNED.id }, enrol: true, identity: null });
    expect(provider.calls).toHaveLength(0);
    expect(ledger.list()).toEqual([]);
  });

  it("reuses the Person the search already linked, and never matches a Person by name", async () => {
    const org = knowledge({ people: [OWNED] });
    const { byId, provider } = await reveal([kept(1, { personId: OWNED.id }), kept(2, { name: "Owned Person" })], [{ contacts: { "l-2": found(2, { name: "Owned Person" }) }, charged: 1 }], { knowledge: org });
    expect(byId.get("cp-1")).toMatchObject({ reveal: "known" });
    // Same name as someone owned, a different record: bought, never assumed.
    expect(byId.get("cp-2")).toMatchObject({ reveal: "revealed", person: { existing: false } });
    expect(provider.calls[0]!.providerIds).toEqual(["l-2"]);
  });

  it("@proof never buys a record already known to be unusable, and says why", async () => {
    const org = knowledge({
      providerIdentities: (["no_email", "invalid_id", "wrong_person", "restricted"] as const).map((status, index) => ({ provider: "lusha" as const, providerId: `l-${index + 1}`, personId: null, status })),
    });
    const { byId, provider, result } = await reveal([kept(1), kept(2), kept(3), kept(4)], [], { knowledge: org });
    expect(provider.calls).toHaveLength(0);
    expect(byId.get("cp-1")).toMatchObject({ reveal: "no_email", hold: "no_email" });
    for (const id of ["cp-2", "cp-3", "cp-4"]) expect(byId.get(id)).toMatchObject({ reveal: "held", hold: "provider_unusable", identity: null });
    expect(result.plan.counts).toMatchObject({ toReveal: 0, maxCredits: 0, noEmail: 1, unavailable: 3 });
  });

  it("@proof lets an org-wide opt-out or do-not-contact block the person before anything is bought", async () => {
    const org = knowledge({
      people: [OWNED],
      providerIdentities: [{ provider: "lusha", providerId: "l-1", personId: OWNED.id, status: "usable" }],
      suppressions: [
        { kind: "email", value: OWNED.email, reason: "opted_out" },
        { kind: "domain", value: "firm2.co.uk", reason: "dnc" },
      ],
    });
    const { byId, provider } = await reveal([kept(1), kept(2)], [], { knowledge: org });
    expect(provider.calls).toHaveLength(0);
    expect(byId.get("cp-1")).toMatchObject({ reveal: "suppressed", hold: "opted_out" });
    expect(byId.get("cp-2")).toMatchObject({ reveal: "suppressed", hold: "dnc" });
  });

  it("does not buy someone the preview says has no email", async () => {
    const { byId, provider, result } = await reveal([kept(1, { hasEmail: false })], []);
    expect(provider.calls).toHaveLength(0);
    expect(byId.get("cp-1")).toMatchObject({ reveal: "no_email", hold: "no_email", identity: null });
    expect(result.plan.counts.noEmail).toBe(1);
  });

  it("@proof reserves every email at the documented price at least, so the approved maximum holds whatever the preview said", () => {
    expect(revealWorstCase({ emailRevealCredits: null }, PRICING)).toBe(1);
    expect(revealWorstCase({ emailRevealCredits: 0 }, PRICING)).toBe(1);
    expect(revealWorstCase({ emailRevealCredits: 3 }, PRICING)).toBe(3);
    const plan = planReveal([kept(1, { emailRevealCredits: null }), kept(2, { emailRevealCredits: 0 }), kept(3), kept(4, { emailRevealCredits: 3 })], new Knowledge(knowledge()), PRICING);
    expect(plan.counts).toMatchObject({ toReveal: 4, free: 1, maxCredits: 6 });
  });
});

describe("the reveal itself", () => {
  it("@proof asks for emails only for the people to buy, in requests of at most the provider's limit, and ledgers each", async () => {
    const people = [kept(1), kept(2), kept(3)];
    const answer = { "l-1": found(1), "l-2": found(2), "l-3": found(3) };
    const { provider, ledger, result } = await reveal(people, [{ contacts: answer, charged: 2 }, { contacts: answer, charged: 1 }], { maxIds: 2 });
    expect(provider.calls.map((call) => call.providerIds)).toEqual([["l-1", "l-2"], ["l-3"]]);
    expect(provider.calls.map((call) => call.key)).toEqual([`${BASE}:b0:a1`, `${BASE}:b1:a1`]);
    expect(ledger.list()).toEqual([
      { key: `${BASE}:b0:a1`, worstCase: 2, state: "reconciled", charged: 2 },
      { key: `${BASE}:b1:a1`, worstCase: 1, state: "reconciled", charged: 1 },
    ]);
    expect(revealTally(result.outcomes)).toMatchObject({ revealed: 3 });
  });

  it("@proof records a partial answer honestly: revealed, no email, not found, refused, failed and missing", async () => {
    const people = [1, 2, 3, 4, 5, 6].map((n) => kept(n));
    const contacts: Record<string, RevealedContact> = {
      "l-1": found(1),
      "l-2": found(2, { emails: [] }),
      "l-3": { status: "not_found" },
      "l-4": { status: "restricted" },
      "l-5": { status: "failed" },
      // l-6 is not in the answer at all.
    };
    const { byId, ledger } = await reveal(people, [{ contacts, charged: 1 }]);
    expect(byId.get("cp-1")).toMatchObject({ reveal: "revealed", enrol: true, person: { existing: false, email: "person1@firm1.co.uk", emailType: "work", grade: "A+" }, identity: { status: "usable", toPerson: true } });
    expect(byId.get("cp-2")).toMatchObject({ reveal: "no_email", hold: "no_email", person: null, identity: { status: "no_email", toPerson: false } });
    expect(byId.get("cp-3")).toMatchObject({ reveal: "held", hold: "invalid_id", identity: { status: "invalid_id" } });
    expect(byId.get("cp-4")).toMatchObject({ reveal: "held", hold: "provider_unusable", identity: { status: "restricted" } });
    for (const id of ["cp-5", "cp-6"]) expect(byId.get(id)).toMatchObject({ reveal: "failed", person: null, identity: null });
    // One request, charged what the provider said: nothing is made up.
    expect(ledger.summary()).toMatchObject({ charged: 1, reserved: 0 });
  });

  it("holds a reveal whose person does not match the preview, and marks the record so it is never bought again", async () => {
    const { byId } = await reveal([kept(1)], [{ contacts: { "l-1": found(1, { name: "Somebody Else" }) }, charged: 1 }]);
    expect(byId.get("cp-1")).toMatchObject({ reveal: "held", hold: "wrong_person", person: null, identity: { status: "wrong_person", toPerson: false } });
  });

  it("@proof joins an address the org already has to that Person, rather than making another", async () => {
    const org = knowledge({ people: [{ id: "person-1", email: "person1@firm1.co.uk", emailType: "work", grade: "A" }] });
    const { byId } = await reveal([kept(1)], [{ contacts: { "l-1": found(1) }, charged: 1 }], { knowledge: org });
    expect(byId.get("cp-1")).toMatchObject({ reveal: "revealed", person: { existing: true, personId: "person-1" }, identity: { status: "usable", toPerson: true } });
  });

  it("enrols one human once when two records return the same new address", async () => {
    const same = found(1);
    const { byId } = await reveal([kept(1), kept(2, { name: "Person 1" })], [{ contacts: { "l-1": same, "l-2": { ...same } }, charged: 2 }]);
    expect(byId.get("cp-1")).toMatchObject({ reveal: "revealed", enrol: true });
    expect(byId.get("cp-2")).toMatchObject({ reveal: "held", hold: "duplicate_in_campaign", enrol: false, identity: { status: "usable", toPerson: true } });
  });

  it("applies this campaign's email rules, and a CRM opt-out becomes an org-wide suppression", async () => {
    const people = [1, 2, 3, 4].map((n) => kept(n));
    const contacts: Record<string, RevealedContact> = {
      "l-1": found(1, { emails: [{ address: "person1@mail.example", type: "personal", grade: "A" }] }),
      "l-2": found(2, { emails: [{ address: "person2@firm2.co.uk", type: "work", grade: "C" }] }),
      "l-3": found(3),
      "l-4": found(4),
    };
    const crm = crmOf({ optOutEmails: ["person3@firm3.co.uk"], customerEmails: ["person4@firm4.co.uk"] });
    const { byId } = await reveal(people, [{ contacts, charged: 4 }], { crm });
    expect(byId.get("cp-1")).toMatchObject({ reveal: "held", hold: "not_work_email", enrol: true });
    expect(byId.get("cp-2")).toMatchObject({ reveal: "held", hold: "grade" });
    expect(byId.get("cp-3")).toMatchObject({ reveal: "suppressed", hold: "opted_out", suppress: { kind: "email", value: "person3@firm3.co.uk", reason: "opted_out" } });
    expect(byId.get("cp-4")).toMatchObject({ reveal: "held", hold: "customer" });
  });

  it("keeps the work email when several come back, then the best grade", () => {
    expect(
      pickEmail([
        { address: "a@mail.example", type: "personal", grade: "A+" },
        { address: "b@firm.example", type: "work", grade: "B" },
        { address: "c@firm.example", type: "work", grade: "A" },
      ])?.address,
    ).toBe("c@firm.example");
    expect(pickEmail([])).toBeUndefined();
  });
});

describe("spend on every request", () => {
  it("@proof releases a request that never left Relay and tries again, still inside the approved maximum", async () => {
    const { byId, provider, ledger } = await reveal([kept(1)], [{ error: "not_sent" }, { contacts: { "l-1": found(1) }, charged: 1 }]);
    expect(provider.calls).toHaveLength(2);
    expect(ledger.list().map((entry) => [entry.key, entry.state])).toEqual([
      [`${BASE}:b0:a1`, "released"],
      [`${BASE}:b0:a2`, "reconciled"],
    ]);
    expect(byId.get("cp-1")).toMatchObject({ reveal: "revealed" });
  });

  it("@proof keeps a request that may have been sent held at its worst case, and never asks for it again", async () => {
    for (const error of ["timeout", "busy", "fail"] as const) {
      const { byId, provider, ledger } = await reveal([kept(1), kept(2)], [{ error }], { cap: 10 });
      expect(provider.calls).toHaveLength(1);
      expect(ledger.list()).toEqual([{ key: `${BASE}:b0:a1`, worstCase: 2, state: "unreconciled", charged: null }]);
      expect(ledger.summary()).toMatchObject({ charged: 0, reserved: 2 });
      for (const id of ["cp-1", "cp-2"]) expect(byId.get(id)).toMatchObject({ reveal: "failed", identity: null, person: null });
    }
  });

  it("@proof stops at the approved maximum or the balance rather than spend past either", async () => {
    for (const bound of [{ cap: 1 }, { cap: 5, balance: 1 }]) {
      const { byId, provider, ledger } = await reveal([kept(1), kept(2)], [], bound);
      expect(provider.calls).toHaveLength(0);
      expect(ledger.list()).toEqual([]);
      expect(byId.get("cp-1")).toMatchObject({ reveal: "failed" });
    }
  });
});
