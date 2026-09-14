import type { LeadGenHandoffV1 } from "../../agents/leadgen/input.schema";
import type { CrmCheck, OrgKnowledge } from "@/lib/leadgen/holds";
import type { ProviderCandidate, ProviderVocabulary } from "@/lib/leadgen/provider";

/**
 * Lead gen's test fixtures. Not a test file (the node project collects only
 * `*.test.ts`).
 *
 * The vocabulary is hand-built in the shapes the provider's public docs
 * describe. It is not the provider's real vocabulary: the zero-spend metadata
 * check has not run, and nothing here should be read as a fact about Lusha.
 */

export const VOCABULARY: ProviderVocabulary = {
  version: "test-vocabulary-1 (hand-built, unverified)",
  countries: [
    { iso2: "GB", value: "United Kingdom" },
    { iso2: "IE", value: "Ireland" },
  ],
  locations: [
    { value: "Orkney Islands", level: "state", countryIso2: "GB" },
    { value: "Kirkwall", level: "city", countryIso2: "GB" },
    { value: "Leeds", level: "city", countryIso2: "GB" },
    { value: "Richmond", level: "city", countryIso2: "GB" },
    { value: "Richmond", level: "state", countryIso2: "GB" },
    { value: "Cork", level: "city", countryIso2: "IE" },
  ],
  industries: [
    { id: "9", label: "Finance", level: "main" },
    { id: "90", label: "Insurance", level: "main" },
    { id: "44", label: "Insurance", level: "sub" },
    { id: "45", label: "Insurance Brokers", level: "sub" },
    { id: "46", label: "Reinsurance", level: "sub" },
    { id: "70", label: "Veterinary", level: "sub" },
  ],
  sizes: {
    kind: "buckets",
    buckets: [
      { min: 1, max: 10 },
      { min: 11, max: 50 },
      { min: 51, max: 200 },
      { min: 201, max: 500 },
      { min: 501, max: 1000 },
    ],
  },
  pageSize: { min: 10, max: 50 },
  maxContactsPerCompany: true,
};

const BASE: LeadGenHandoffV1 = {
  version: 1,
  campaign: { id: "camp-1", orgId: "org-1", ownerUserId: "user-1", briefVersion: 1, confirmRequestId: "req-1" },
  provenance: { researchJobId: "job-1", researchEventId: "evt-1", outcome: "complete" },
  buyerGroup: { id: "claims-teams", name: "Claims teams", sourceRank: 1 },
  targeting: {
    titles: ["Head of Claims", "Claims Operations Director"],
    excludeTitles: ["Claims Handler"],
    sizeBand: { min: 50, max: 500 },
    countries: ["GB"],
    locations: [],
    industries: ["Insurance"],
    triggers: ["new claims leadership"],
  },
  places: [],
  exclusions: { firms: [], roles: [], orgTypes: [] },
  seedFirms: [
    { name: "Northgate Claims Services", domain: "northgateclaims.co.uk", country: "GB" },
    { name: "Calder Insurance Group Ltd", country: "GB" },
  ],
  howMany: 10,
  perCompanyMax: 3,
  spend: {
    searchCreditCap: 40,
    balanceSnapshot: { remaining: 100, readAt: "2026-09-14T09:00:00Z" },
    pricingAssumptions: "lusha-public-docs-2026-09-14-unverified",
  },
  lawfulBasis: { text: "Legitimate interest: B2B offer, opt out in every email", confirmedByUserId: "user-1", confirmedAt: "2026-09-14T09:00:00Z", briefVersion: 1 },
};

/** A handoff, edited in place by `patch`. */
export function handoff(patch: (value: LeadGenHandoffV1) => void = () => {}): LeadGenHandoffV1 {
  const value = structuredClone(BASE);
  patch(value);
  return value;
}

/** One preview row: an exact-title, emailable person at their own firm, in Leeds. */
export function candidate(n: number, over: Partial<ProviderCandidate> = {}): ProviderCandidate {
  return {
    providerId: `l-${String(n).padStart(3, "0")}`,
    name: `Person ${n}`,
    title: "Head of Claims",
    company: `Firm ${n}`,
    domain: `firm${n}.co.uk`,
    countryIso2: "GB",
    city: "Leeds",
    hasEmail: true,
    emailRevealCredits: 1,
    ...over,
  };
}

export function knowledge(over: Partial<OrgKnowledge> = {}): OrgKnowledge {
  return { people: [], providerIdentities: [], suppressions: [], enrolledPersonIds: [], ...over };
}

/** A CRM that answers only from what it is given, and records what it was asked. */
export function crm(options: { customerDomains?: string[]; optOutEmails?: string[]; customerEmails?: string[] } = {}): CrmCheck & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async isCustomerDomain(domain) {
      asked.push(`domain:${domain}`);
      return (options.customerDomains ?? []).includes(domain);
    },
    async emailStatus(email) {
      asked.push(`email:${email}`);
      return { optOut: (options.optOutEmails ?? []).includes(email), isCustomer: (options.customerEmails ?? []).includes(email) };
    },
  };
}

export const NO_WAIT = { attempts: 3, wait: async () => {} };
