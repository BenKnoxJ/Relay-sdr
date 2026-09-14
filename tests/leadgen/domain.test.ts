import { describe, expect, it } from "vitest";

import { FakeLeadGenProvider } from "@/lib/leadgen/fakeProvider";
import { findPeople } from "@/lib/leadgen/findPeople";
import { Knowledge, isExcludedFirm, preRevealChecks } from "@/lib/leadgen/holds";
import { domainKey } from "@/lib/leadgen/normalise";
import { companyKeyOf, isSeedFirm, rankCandidates } from "@/lib/leadgen/rank";

import { NO_WAIT, VOCABULARY, candidate, crm, handoff, knowledge } from "./harness";

/**
 * The registrable domain (leadgen v2.1 §8), public-suffix aware, and the
 * rules that depend on it: company key, seed match, the per-company cap,
 * firm exclusions and domain suppressions.
 */

describe("domainKey", () => {
  it("gives subdomains of one company the same key", () => {
    expect(domainKey("sales.example.com")).toBe("example.com");
    expect(domainKey("support.example.com")).toBe("example.com");
  });

  it("treats www and the bare domain alike", () => {
    expect(domainKey("www.example.com")).toBe("example.com");
    expect(domainKey("example.com")).toBe("example.com");
  });

  it("respects multi-part public suffixes", () => {
    expect(domainKey("sales.example.co.uk")).toBe("example.co.uk");
    expect(domainKey("www.example.co.uk")).toBe("example.co.uk");
    expect(domainKey("a.b.example.org.uk")).toBe("example.org.uk");
  });

  it("keeps distinct registrable domains distinct", () => {
    expect(domainKey("example.com")).not.toBe(domainKey("example.co.uk"));
    expect(domainKey("sales.example.com")).not.toBe(domainKey("sales.other.com"));
    // Two sites on a shared hosting suffix are two companies.
    expect(domainKey("acme.github.io")).not.toBe(domainKey("rival.github.io"));
  });

  it("cleans URLs and email addresses to the same key", () => {
    expect(domainKey("HTTPS://Sales.Example.com:443/about?x=1")).toBe("example.com");
    expect(domainKey("sam@support.example.co.uk")).toBe("example.co.uk");
    expect(domainKey("")).toBeUndefined();
    expect(domainKey(undefined)).toBeUndefined();
  });

  it("keys a host the list cannot place as the host itself", () => {
    expect(domainKey("192.168.0.1")).toBe("192.168.0.1");
  });
});

describe("the rules that use it", () => {
  const OPTIONS = { titles: ["Head of Claims"], seedFirms: [{ name: "Example Group", domain: "example.com" }], perCompanyMax: 3, howMany: 10 };

  it("gives candidates on different subdomains one company key", () => {
    expect(companyKeyOf(candidate(1, { domain: "sales.example.com" }))).toBe("example.com");
    expect(companyKeyOf(candidate(2, { domain: "support.example.com" }))).toBe("example.com");
  });

  it("matches a seed firm recorded at its root to a candidate on a subdomain", () => {
    expect(isSeedFirm(candidate(1, { domain: "sales.example.com" }), OPTIONS.seedFirms)).toBe(true);
    expect(isSeedFirm(candidate(2, { domain: "sales.other.com" }), OPTIONS.seedFirms)).toBe(false);
  });

  it("cannot be talked past the per-company cap by different subdomains", () => {
    const hosts = ["example.com", "www.example.com", "sales.example.com", "support.example.com", "uk.example.com"];
    const result = rankCandidates(
      hosts.map((host, index) => ({ candidate: candidate(index + 1, { domain: host }), reusedPersonId: null })),
      OPTIONS,
    );
    expect(result.chosen).toHaveLength(3);
    expect(result.held.map((hold) => hold.reason)).toEqual(["company_cap", "company_cap"]);
  });

  it("caps across subdomains in a full run too", async () => {
    const provider = new FakeLeadGenProvider([
      { candidates: ["sales", "support", "uk", "www", "eu"].map((sub, index) => candidate(index + 1, { domain: `${sub}.example.co.uk` })), charged: 5, hasMore: false },
    ]);
    const result = await findPeople(handoff(), { provider, vocabulary: VOCABULARY, knowledge: knowledge(), crm: crm(), retry: NO_WAIT });
    expect(result.output.phase === "pick" ? result.output.chosen.map((person) => person.companyKey) : []).toEqual(["example.co.uk", "example.co.uk", "example.co.uk"]);
  });

  it("applies firm exclusions and domain suppressions to every subdomain", () => {
    const research = handoff((h) => (h.exclusions.firms = [{ name: "Old Rival", domain: "oldrival.co.uk" }]));
    expect(isExcludedFirm(candidate(1, { domain: "careers.oldrival.co.uk" }), research)).toBe(true);
    const known = new Knowledge(knowledge({ suppressions: [{ kind: "domain", value: "example.com", reason: "dnc" }] }));
    expect(preRevealChecks(candidate(2, { domain: "sales.example.com" }), handoff(), known, new Set())).toEqual({ kind: "held", reason: "dnc" });
  });

  it("asks the CRM about the registrable domain, once for all of a company's subdomains", async () => {
    const check = crm();
    const provider = new FakeLeadGenProvider([
      { candidates: [candidate(1, { domain: "sales.example.com" }), candidate(2, { domain: "support.example.com" })], charged: 2, hasMore: false },
    ]);
    await findPeople(handoff(), { provider, vocabulary: VOCABULARY, knowledge: knowledge(), crm: check, retry: NO_WAIT });
    expect(check.asked.filter((question) => question.startsWith("domain:"))).toEqual(["domain:example.com"]);
  });
});
