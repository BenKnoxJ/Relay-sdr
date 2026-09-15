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
  /** When the metadata behind this vocabulary was read, and a hash of it (v2.1 §5). A live provider always sets it. */
  provenance?: { fetchedAt: string; hash: string };
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
  /** v2.2 §4a: the complement search asks only inside these accounts' domains. */
  companyDomains?: string[];
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
  /** The provider's own company id: the account key when there is no domain (v2.2 §8a). Never shown to a rep. */
  companyId?: string;
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

/**
 * What revealing one contact's email returned, in Relay's terms. `found` may
 * carry no email at all. Phone numbers are never asked for and have no field.
 */
export type RevealedContact =
  | {
      status: "found";
      name: string;
      domain?: string;
      emails: { address: string; type: "work" | "personal" | "unknown"; grade: string | null }[];
    }
  /** The provider has no such record. */
  | { status: "not_found" }
  /** The provider will not reveal this record. */
  | { status: "restricted" }
  /** The provider could not reveal it this time; whether it charged is not said per person. */
  | { status: "failed" };

export type RevealRequest = {
  /** The request's own key: a retry is a new key with its own reservation. */
  key: string;
  providerIds: string[];
};

export type RevealAnswer = {
  /** By provider id. An id the answer does not mention is missing, not revealed. */
  contacts: Map<string, RevealedContact>;
  /** What the provider reported charging for this request. */
  charged: number;
};

/** The provider behind Reveal emails: emails only (lead gen v2.1 §6). */
export interface RevealProvider {
  readonly provider: "lusha";
  /** At most this many ids in one request. */
  readonly maxIds: number;
  revealEmails(request: RevealRequest): Promise<RevealAnswer>;
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

/** The request never left Relay (v2.2 note 2): nothing can have been charged, so its reservation is released. */
export class ProviderNotSentError extends Error {
  constructor(message = "the request never reached the provider") {
    super(message);
    this.name = "ProviderNotSentError";
  }
}
