/**
 * The provider behind lead gen's search, as the smallest interface leadgen
 * v2.1 needs (§4, §5, §6).
 *
 * There is no live client here. The provider's filter vocabulary is handed in
 * (`ProviderVocabulary`), because the zero-spend metadata check that would
 * read it has not run: nothing about Lusha's real vocabulary, page limits or
 * prices is assumed in this module. A live client lands after that check.
 */

/** The provider's filter vocabulary, as metadata would supply it. Injected; never assumed. */
export type ProviderVocabulary = {
  /** Where this vocabulary came from, recorded with the translation. */
  version: string;
  countries: { iso2: string; value: string }[];
  locations: { value: string; level: "state" | "city"; countryIso2: string }[];
  industries: { id: string; label: string; level: "main" | "sub" }[];
  /** Free employee ranges, or fixed buckets only. */
  sizes: { kind: "range" } | { kind: "buckets"; buckets: { min: number; max: number }[] };
  pageSize: { min: number; max: number };
  /** Whether a per-company limit can be sent with a search. */
  maxContactsPerCompany: boolean;
};

/** A search, in the provider's own terms. Built only by `translate`; never shown to a rep. */
export type ProviderFilters = {
  titles: string[];
  excludeTitles: string[];
  countries: string[];
  locations: { value: string; level: "state" | "city"; countryIso2: string }[];
  sizes: { min: number; max: number }[];
  industryIds: string[];
  excludeDomains: string[];
  maxContactsPerCompany?: number;
};

export type ProviderSearchRequest = {
  /** The request's own key: a retry is a new key with its own reservation. */
  key: string;
  filters: ProviderFilters;
  page: number;
  pageSize: number;
};

/** One preview row. No email: the preview never carries one. */
export type ProviderCandidate = {
  providerId: string;
  name: string;
  title: string;
  company: string;
  domain?: string;
  countryIso2?: string;
  state?: string;
  city?: string;
  linkedinUrl?: string;
  /** Whether a reveal would yield an email. */
  hasEmail: boolean;
  /** What revealing the email would cost; 0 when it is already free. Null when the provider did not say. */
  emailRevealCredits: number | null;
};

export type ProviderSearchPage = {
  candidates: ProviderCandidate[];
  /** What the provider reported charging for this request. */
  charged: number;
  hasMore: boolean;
};

export interface LeadGenProvider {
  readonly provider: "lusha";
  search(request: ProviderSearchRequest, options?: { signal?: AbortSignal }): Promise<ProviderSearchPage>;
}

/** The provider refused for load (a 429). Whether it charged is unknown, so the reservation stays. */
export class ProviderBusyError extends Error {
  constructor(message = "the provider is busy") {
    super(message);
    this.name = "ProviderBusyError";
  }
}

/** A timeout or network failure: the request may or may not have been charged. */
export class ProviderUnknownOutcomeError extends Error {
  constructor(message = "the provider's answer never arrived") {
    super(message);
    this.name = "ProviderUnknownOutcomeError";
  }
}
