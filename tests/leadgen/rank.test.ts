import { describe, expect, it } from "vitest";

import { peopleCopy } from "@/lib/copy/people";
import { rankCandidates, type Eligible } from "@/lib/leadgen/rank";

import { candidate } from "./harness";

/** Ranking, leadgen v2.1 §8: fixed scores, a total order, the cap enforced here. */

const OPTIONS = {
  titles: ["Head of Claims", "Claims Operations Director"],
  seedFirms: [
    { name: "Northgate Claims Services", domain: "northgateclaims.co.uk" },
    { name: "Calder Insurance Group Ltd" },
  ],
  perCompanyMax: 3,
  howMany: 10,
};

const bought = (entries: ReturnType<typeof candidate>[]): Eligible[] => entries.map((entry) => ({ candidate: entry, reusedPersonId: null }));
const ids = (result: ReturnType<typeof rankCandidates>) => result.chosen.map((entry) => entry.candidate.providerId);

/** Every ordering of a small list. */
function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]));
}

describe("scores", () => {
  it("scores exact title 3, related 1, seed firm 2 and email 2, after normalising titles", () => {
    const [exact, related, seed, noEmail] = rankCandidates(
      bought([
        candidate(1, { title: "  HEAD   of claims " }),
        candidate(2, { title: "Head of Claims & Risk" }),
        candidate(3, { domain: "https://www.northgateclaims.co.uk/about", company: "Northgate" }),
        candidate(4, { hasEmail: false }),
      ]),
      OPTIONS,
    ).chosen.sort((a, b) => a.candidate.providerId.localeCompare(b.candidate.providerId));
    expect([exact?.score, exact?.exactTitle]).toEqual([5, true]);
    expect([related?.score, related?.exactTitle]).toEqual([3, false]);
    expect([seed?.score, seed?.seedMatch]).toEqual([7, true]);
    expect(noEmail?.score).toBe(3);
  });

  it("matches a seed firm by domain when it has one, and by name only when it has none", () => {
    const result = rankCandidates(
      bought([
        // Seed has no domain: the name, legal suffix stripped, matches.
        candidate(1, { company: "Calder Insurance Group", domain: "calder.example" }),
        // Seed has a domain: the same name at another domain does not match.
        candidate(2, { company: "Northgate Claims Services", domain: "northgate-other.example" }),
      ]),
      OPTIONS,
    );
    const byId = Object.fromEntries(result.chosen.map((entry) => [entry.candidate.providerId, entry.seedMatch]));
    expect(byId).toEqual({ "l-001": true, "l-002": false });
  });

  it("writes why-picked from the parts that fired, the same way every time", () => {
    const [entry] = rankCandidates(bought([candidate(1, { domain: "northgateclaims.co.uk" })]), OPTIONS).chosen;
    expect(entry?.whyPicked).toBe(`${peopleCopy.why.exactTitle} ${peopleCopy.why.seedFirm}, ${peopleCopy.why.withEmail}.`);
    const [related] = rankCandidates(bought([candidate(2, { title: "Claims Lead", hasEmail: false })]), OPTIONS).chosen;
    expect(related?.whyPicked).toBe(`${peopleCopy.why.relatedTitle}, ${peopleCopy.why.noEmail}.`);
  });
});

describe("order", () => {
  it("gives the same pick whatever order the provider returned the candidates in", () => {
    const entries = bought([
      candidate(1),
      candidate(2, { title: "Claims Lead" }),
      candidate(3, { domain: "northgateclaims.co.uk" }),
      candidate(4, { hasEmail: false }),
      candidate(5, { domain: "firm1.co.uk" }),
    ]);
    const expected = rankCandidates(entries, { ...OPTIONS, howMany: 4 });
    for (const ordering of permutations(entries)) {
      const result = rankCandidates(ordering, { ...OPTIONS, howMany: 4 });
      expect(ids(result)).toEqual(ids(expected));
      expect(result.chosen.map((entry) => entry.whyPicked)).toEqual(expected.chosen.map((entry) => entry.whyPicked));
    }
  });

  it("breaks exact ties by company key, then name, then provider id", () => {
    const result = rankCandidates(
      bought([
        candidate(3, { domain: "b.example", name: "Zed" }),
        candidate(1, { domain: "a.example", name: "Yan" }),
        candidate(2, { domain: "a.example", name: "Abe" }),
        candidate(4, { domain: "a.example", name: "Abe" }),
      ]),
      OPTIONS,
    );
    // a.example gets its first pick, then b.example (fewer from the same company),
    // then a.example's remaining two by name, then provider id.
    expect(ids(result)).toEqual(["l-002", "l-003", "l-004", "l-001"]);
  });
});

describe("the per-company cap", () => {
  it("never chooses more than three from one company, whatever the provider sent", () => {
    const result = rankCandidates(bought([1, 2, 3, 4, 5].map((n) => candidate(n, { domain: "same.example" }))), OPTIONS);
    expect(result.chosen).toHaveLength(3);
    expect(result.held).toEqual([
      { providerId: "l-004", reason: "company_cap" },
      { providerId: "l-005", reason: "company_cap" },
    ]);
  });

  it("treats a missing domain by company name, so it cannot slip past the cap", () => {
    const result = rankCandidates(bought([1, 2, 3, 4].map((n) => candidate(n, { domain: undefined, company: "Acme Ltd" }))), OPTIONS);
    expect(result.chosen).toHaveLength(3);
    expect(result.chosen[0]?.companyKey).toBe("acme ltd");
  });

  it("keys a company with no domain by norm(company), so a legal suffix still tells two companies apart", () => {
    const result = rankCandidates(
      bought([
        ...[1, 2, 3].map((n) => candidate(n, { domain: undefined, company: "Acme Ltd" })),
        candidate(4, { domain: undefined, company: "Acme Inc" }),
      ]),
      OPTIONS,
    );
    expect(result.chosen).toHaveLength(4);
    expect(result.held).toEqual([]);
    expect(new Set(result.chosen.map((entry) => entry.companyKey))).toEqual(new Set(["acme ltd", "acme inc"]));
  });
});

describe("reuse", () => {
  it("ranks a reused person like anyone else, with the email Relay already owns", () => {
    const result = rankCandidates(
      [
        { candidate: candidate(1, { hasEmail: false }), reusedPersonId: "person-1" },
        { candidate: candidate(2, { hasEmail: false }), reusedPersonId: null },
      ],
      OPTIONS,
    );
    const reused = result.chosen.find((entry) => entry.reusedPersonId === "person-1");
    expect(reused?.score).toBe(5);
    expect(reused?.whyPicked).toBe(`${peopleCopy.why.exactTitle}, ${peopleCopy.why.reused}.`);
    expect(result.chosen[0]?.reusedPersonId).toBe("person-1");
  });

  it("counts a reused person against the company cap", () => {
    const result = rankCandidates(
      [1, 2, 3, 4].map((n) => ({ candidate: candidate(n, { domain: "same.example" }), reusedPersonId: n === 4 ? "person-4" : null })),
      OPTIONS,
    );
    expect(result.chosen).toHaveLength(3);
  });

  it("never picks one person twice when two provider records resolve to them", () => {
    const result = rankCandidates(
      [
        { candidate: candidate(1), reusedPersonId: "person-1" },
        { candidate: candidate(2), reusedPersonId: "person-1" },
      ],
      OPTIONS,
    );
    expect(result.chosen).toHaveLength(1);
    expect(result.held).toEqual([{ providerId: "l-002", reason: "duplicate_in_campaign" }]);
  });
});
