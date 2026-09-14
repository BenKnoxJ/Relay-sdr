import type { LeadGenHandoff } from "../../../agents/leadgen/input.schema";

import { FakeLeadGenProvider, type FakeStep } from "./fakeProvider";
import type { ProviderCandidate, ProviderVocabulary } from "./provider";

/**
 * The sample lead gen environment: development and test only
 * (`RELAY_LEADGEN_PROVIDER=sample`, which production refuses to boot with).
 *
 * Made-up people at made-up firms on `.example` domains, derived from the
 * handoff so the whole flow (Confirm, finding people, People found) can be
 * seen with no provider at all. Its vocabulary mirrors the recipe, so
 * translation always succeeds, and its balance is sample credits: never a
 * live account, and never shown as one.
 */

export const SAMPLE_BALANCE_REMAINING = 500;
/** Enough for two pages at the largest count Start offers. */
export const SAMPLE_SEARCH_CAP = 120;

export function sampleVocabulary(handoff: LeadGenHandoff): ProviderVocabulary {
  const { countries, locations, industries } = handoff.targeting;
  return {
    version: "sample (made up; not a provider's vocabulary)",
    countries: countries.map((iso2) => ({ iso2, value: iso2 })),
    locations: locations.map((value) => ({ value, level: "state" as const, countryIso2: countries[0]! })),
    industries: industries.map((label, index) => ({ id: `sample-${index + 1}`, label, level: "sub" as const })),
    sizes: { kind: "range" },
    pageSize: { min: 10, max: 50 },
    maxContactsPerCompany: true,
  };
}

/** Eighteen sample people, two to a firm, every fifth with no email. */
export function sampleCandidates(handoff: LeadGenHandoff): ProviderCandidate[] {
  const { titles, countries, locations } = handoff.targeting;
  return Array.from({ length: 18 }, (_, index) => {
    const n = index + 1;
    const firm = Math.ceil(n / 2);
    return {
      providerId: `sample-${String(n).padStart(3, "0")}`,
      name: `Sample Person ${n}`,
      title: titles[index % titles.length]!,
      company: `Sample Firm ${firm}`,
      domain: `www.sample-firm-${firm}.example`,
      countryIso2: countries[0]!,
      ...(locations.length > 0 ? { state: locations[0]! } : { city: "Sample Town" }),
      hasEmail: n % 5 !== 0,
      emailRevealCredits: 1,
    };
  });
}

export function sampleProvider(handoff: LeadGenHandoff): FakeLeadGenProvider {
  const all = sampleCandidates(handoff);
  const pages: FakeStep[] = [
    { candidates: all.slice(0, 12), charged: 12, hasMore: true },
    { candidates: all.slice(12), charged: 6, hasMore: false },
  ];
  return new FakeLeadGenProvider(pages);
}
