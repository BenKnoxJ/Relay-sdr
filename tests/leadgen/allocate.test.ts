import { describe, expect, it } from "vitest";

import { allocate, targetAccountsFor, type AllocateOptions } from "@/lib/leadgen/allocate";
import type { ProviderCandidate } from "@/lib/leadgen/provider";
import { companyKeyOf, rankCandidates, type Eligible } from "@/lib/leadgen/rank";
import { roleTable } from "@/lib/leadgen/roles";

import { MOTOR_ROLES, MOTOR_TITLES } from "./harness";

/**
 * Account-led allocation, leadgen v2.2 §8a with note 1: coverage before
 * depth, runs first, a different role before a second of the same, at most
 * three to an account, no limit on how many accounts one title leads, and no
 * padding. Fictional people on
 * `.example` domains.
 */

let n = 0;
function person(account: string, title: string, over: Partial<ProviderCandidate> = {}): Eligible {
  n += 1;
  return {
    candidate: {
      providerId: `p-${String(n).padStart(3, "0")}`,
      name: `Person ${n}`,
      title,
      company: `Account ${account}`,
      domain: `${account}.example`,
      countryIso2: "GB",
      hasEmail: true,
      emailRevealCredits: 1,
      ...over,
    },
    reusedPersonId: null,
  };
}

const options = (over: Partial<AllocateOptions> = {}): AllocateOptions => ({
  titles: MOTOR_TITLES,
  seedFirms: [],
  perCompanyMax: 3,
  howMany: 20,
  roles: roleTable(MOTOR_ROLES),
  ...over,
});

const COO = "Chief Operating Officer";
const RUNS = "Head of Claims";

/** Fisher-Yates with a fixed seed: the same shuffle every run. */
function shuffled<T>(values: readonly T[], seed: number): T[] {
  const out = [...values];
  let state = seed;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe("the targets", () => {
  it("aims for half as many accounts as people", () => {
    expect([10, 20, 30, 50].map(targetAccountsFor)).toEqual([5, 10, 15, 25]);
  });
});

describe("allocate", () => {
  it("@proof a pool dominated by COOs does not become a COO list when role diversity exists", () => {
    // The shape the first paid search returned: a sign-off title at every account, and far fewer who run it or champion it.
    const pool: Eligible[] = [];
    const accounts = Array.from({ length: 14 }, (_, index) => `acct${String(index + 1).padStart(2, "0")}`);
    for (const account of accounts) pool.push(person(account, COO));
    for (const account of accounts.slice(0, 5)) pool.push(person(account, RUNS));
    for (const account of accounts.slice(0, 3)) pool.push(person(account, "Complaints Manager"));
    for (const account of accounts.slice(5, 7)) pool.push(person(account, "Claims Quality Manager"));

    const { chosen } = allocate(pool, options());
    const byAccount = new Map<string, string[]>();
    for (const entry of chosen) byAccount.set(entry.companyKey, [...(byAccount.get(entry.companyKey) ?? []), entry.role?.part ?? "none"]);

    // Everyone who runs it or champions it is chosen, and runs leads wherever it exists.
    expect(chosen.filter((entry) => entry.role?.part === "runs")).toHaveLength(5);
    expect(chosen.filter((entry) => entry.role?.part === "champions")).toHaveLength(5);
    for (const account of accounts.slice(0, 5)) expect(byAccount.get(`${account}.example`)?.[0]).toBe("runs");
    // Where someone runs it, they lead: a COO never leads an account that has a runs person.
    const leads = [...byAccount.values()].map((parts) => parts[0]);
    expect(leads.filter((part) => part === "runs")).toHaveLength(5);
    // Every other COO chosen signs off alongside someone who runs or champions it.
    for (const parts of byAccount.values()) {
      if (parts.length > 1) expect(parts.slice(1).every((part) => part !== parts[0])).toBe(true);
    }
    // The old ranking over the same pool, for contrast, leads with the sign-off title.
    const old = rankCandidates(pool, { titles: MOTOR_TITLES, seedFirms: [], perCompanyMax: 3, howMany: 20 });
    expect(old.chosen.filter((entry) => entry.candidate.title === COO).length).toBeGreaterThan(chosen.filter((entry) => entry.candidate.title === COO && byAccount.get(entry.companyKey)?.[0] === "signs").length);
  });

  it("covers accounts before depth: leads for the target first, then a complementary role, then a third", () => {
    const pool = ["a", "b", "c"].flatMap((account) => [person(account, account === "b" ? "Claims Operations Manager" : RUNS), person(account, "Complaints Manager"), person(account, COO)]);
    const { chosen, leadAccounts } = allocate(pool, options({ howMany: 6 }));
    // howMany 6: three account leads first (all runs), then each account's champion.
    expect(leadAccounts).toEqual(["a.example", "b.example", "c.example"]);
    expect(chosen.map((entry) => `${entry.companyKey[0]}:${entry.role?.part}`)).toEqual(["a:runs", "b:runs", "c:runs", "a:champions", "b:champions", "c:champions"]);
  });

  it("@proof never takes two people with one role at an account, and never more than three", () => {
    const pool = [person("a", RUNS), person("a", "Claims Operations Manager"), person("a", COO), person("a", "Claims Director"), person("a", "Complaints Manager")];
    const { chosen, spare, held } = allocate(pool, options());
    expect(chosen.map((entry) => entry.role?.part)).toEqual(["runs", "champions", "signs"]);
    expect(chosen).toHaveLength(3);
    // The account is full: the second runs and the second signs are held by the cap.
    expect(spare).toHaveLength(0);
    expect(held.map((hold) => hold.reason)).toEqual(["company_cap", "company_cap"]);
  });

  it("@proof keeps every strong account that shares a runs title: no title limit discards a target account (note 1)", () => {
    // The live shape: seven accounts led by an exact "Head of Claims", beside six led by other runs titles.
    const same = Array.from({ length: 7 }, (_, index) => person(`hoc${index + 10}`, RUNS));
    const others = ["Head of Claims Operations", "Head of Claims Operations", "Global Head of Claims", "Head of Claims Improvement", "Deputy Head of Claims", "Claims Operations Manager"].map((title, index) =>
      person(`other${index + 10}`, title),
    );
    const weak = [person("weak10", "Head of Supply Chain"), person("weak11", "Head of Customer Claims")];
    const { chosen, spare } = allocate([...same, ...others, ...weak], options());
    // All thirteen strong accounts are kept, seven of them led by the same title.
    expect(chosen).toHaveLength(13);
    expect(chosen.filter((entry) => entry.candidate.title === RUNS)).toHaveLength(7);
    // The related titles stay out: short of 20, rather than padded.
    expect(spare.map((entry) => entry.candidate.title).sort()).toEqual(["Head of Customer Claims", "Head of Supply Chain"]);
  });

  it("@proof stops short rather than pad: only strong people are ever chosen", () => {
    const pool = Array.from({ length: 12 }, (_, index) => person(`coo${index + 10}`, COO));
    const { chosen } = allocate([...pool, person("x1", "Office Manager"), person("x2", "Head of Supply Chain")], options());
    // Twelve strong sign-off accounts, each taken once; the two weak people are never added to reach 20.
    expect(chosen).toHaveLength(12);
    expect(chosen.every((entry) => entry.strong)).toBe(true);
  });

  it("gives an account with one genuinely strong role one person, and never chooses a weak match", () => {
    const pool = [person("solo", RUNS), person("solo", "Head of Motor Claims Fraud Investigation"), person("weak", "Office Manager")];
    const { chosen, spare } = allocate(pool, options());
    // "Head of Motor Claims Fraud Investigation" is a related title and not an exact recipe title: weak.
    expect(chosen.map((entry) => entry.candidate.title)).toEqual([RUNS]);
    expect(spare.map((entry) => entry.strong)).toEqual([false, false]);
  });

  it("chooses the same people in the same order whatever order the provider returned them in", () => {
    const pool = ["a", "b", "c", "d"].flatMap((account) => [person(account, RUNS), person(account, COO), person(account, "Complaints Manager")]);
    const picks = (candidates: Eligible[]) => allocate(candidates, options({ howMany: 10 })).chosen.map((entry) => entry.candidate.providerId);
    const first = picks(pool);
    for (const seed of [1, 7, 42]) expect(picks(shuffled(pool, seed))).toEqual(first);
  });

  it("orders accounts by roles offered, then a seed firm, then best score, then key", () => {
    const pool = [person("zeta", RUNS), person("zeta", COO), person("alpha", "Claims Operations Manager"), person("seeded", RUNS)];
    const { leadAccounts } = allocate(pool, options({ howMany: 6, seedFirms: [{ name: "Account seeded", domain: "seeded.example" }] }));
    expect(leadAccounts).toEqual(["zeta.example", "seeded.example", "alpha.example"]);
  });
});

describe("account identity", () => {
  it("groups one account's people by its registrable domain", () => {
    const pool = [person("one", RUNS, { domain: "sales.one.example" }), person("one", COO, { domain: "www.one.example" })];
    const { chosen } = allocate(pool, options());
    expect(new Set(chosen.map((entry) => entry.companyKey))).toEqual(new Set(["one.example"]));
  });

  it("keys an account with no domain by the provider's company id, and only then by name", () => {
    const base = { providerId: "x", name: "X", title: RUNS, company: "Nameless Mutual", hasEmail: true, emailRevealCredits: 1 };
    expect(companyKeyOf({ ...base, companyId: "co-7" })).toBe("company-id:co-7");
    expect(companyKeyOf(base)).toBe("nameless mutual");
    expect(companyKeyOf({ ...base, domain: "nameless.example", companyId: "co-7" })).toBe("nameless.example");
    // Two people at the same id-only company are one account.
    const pool = [person("", RUNS, { domain: undefined, companyId: "co-7" }), person("", COO, { domain: undefined, companyId: "co-7" })];
    expect(new Set(allocate(pool, options()).chosen.map((entry) => entry.companyKey))).toEqual(new Set(["company-id:co-7"]));
  });
});
