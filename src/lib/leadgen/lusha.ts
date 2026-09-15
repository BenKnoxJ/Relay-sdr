import { createHash } from "node:crypto";

import type { LeadGenHandoff } from "../../../agents/leadgen/input.schema";
import {
  LUSHA_ENRICH_MAX_IDS,
  LushaHttpError,
  LushaNoAnswerError,
  LushaNotSentError,
  type LushaClient,
  type LushaContact,
  type LushaEnrichedContact,
  type LushaContactSearch,
  type LushaCountries,
  type LushaIndustries,
  type LushaLocations,
  type LushaSizes,
} from "@/lib/services/lusha";

import { norm } from "./normalise";
import {
  ProviderBusyError,
  ProviderNotSentError,
  ProviderUnknownOutcomeError,
  type LeadGenProvider,
  type ProviderCandidate,
  type ProviderSearchPage,
  type ProviderSearchRequest,
  type ProviderVocabulary,
  type RevealAnswer,
  type RevealProvider,
  type RevealRequest,
  type RevealedContact,
} from "./provider";

/**
 * Lead gen over Lusha V3: the vocabulary from the free filter reads, the
 * search, and the balance. The provider returns previews and what the API
 * charged; ranking, holds and spend stay in the core.
 *
 * What is verified (zero-spend check, 2026-09-14): the filter reads are free;
 * sizes are fixed buckets; industries are main and sub with numeric ids;
 * countries are `{name, code}`; a location lookup returns literal places, not
 * ids. What is taken from the response shape recorded earlier and is checked
 * again at the first paid search: the request field names, `billing`, `has`
 * and `canReveal`.
 */

/** V3 refuses a page below 10 (seen live by earlier clients); 50 is lead gen's own ceiling (v2.1 §4). */
export const LUSHA_PAGE_SIZE = { min: 10, max: 50 } as const;
/** The top size bucket has no upper bound. */
export const OPEN_ENDED = Number.MAX_SAFE_INTEGER;
/** The `has` and `canReveal` field for an email. */
const EMAILS = "emails";
/** Metadata is small and changes rarely; one read per process per six hours is plenty for H1. */
const METADATA_TTL_MS = 6 * 60 * 60 * 1000;

type Metadata = { sizes: LushaSizes; industries: LushaIndustries; countries: LushaCountries; fetchedAt: string };
const metadataCache = new Map<string, { at: number; value: Promise<Metadata> }>();
const locationCache = new Map<string, Promise<LushaLocations>>();

/** Test-only: forget cached metadata. */
export function clearLushaMetadataCache(): void {
  metadataCache.clear();
  locationCache.clear();
}

function metadata(client: LushaClient, now: () => Date): Promise<Metadata> {
  const hit = metadataCache.get(client.cacheKey);
  if (hit !== undefined && now().getTime() - hit.at < METADATA_TTL_MS) return hit.value;
  const at = now();
  const value = Promise.all([client.sizes(), client.industries(), client.countries()]).then(([sizes, industries, countries]) => ({
    sizes,
    industries,
    countries,
    fetchedAt: at.toISOString(),
  }));
  // A failed read is not cached: the next run asks again.
  value.catch(() => metadataCache.delete(client.cacheKey));
  metadataCache.set(client.cacheKey, { at: at.getTime(), value });
  return value;
}

function places(client: LushaClient, query: string): Promise<LushaLocations> {
  const key = `${client.cacheKey}:${norm(query)}`;
  const hit = locationCache.get(key);
  if (hit !== undefined) return hit;
  const value = client.locations(query);
  value.catch(() => locationCache.delete(key));
  locationCache.set(key, value);
  return value;
}

/** Every spelling a location term may take: the term, and the name and aliases of the place it names. */
function spellings(term: string, handoff: LeadGenHandoff): string[] {
  const all = [term];
  for (const place of handoff.places) {
    const names = [place.name, ...place.aliases];
    if (names.some((name) => norm(name) === norm(term))) all.push(...names);
  }
  const seen = new Set<string>();
  return all.filter((name) => {
    const key = norm(name);
    if (key.length < 2 || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const isoByName = (countries: LushaCountries) => new Map(countries.map((country) => [norm(country.name), country.code.toUpperCase()]));

function hashOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export type LushaEnvironment = { provider: LushaProvider; vocabulary: ProviderVocabulary };

/**
 * The vocabulary for one handoff and a provider that speaks it. The static
 * metadata is cached; each location term is looked up once, in every spelling
 * the brief gives it, and only the places inside a known country are kept.
 */
export async function lushaEnvironment(client: LushaClient, handoff: LeadGenHandoff, now: () => Date = () => new Date()): Promise<LushaEnvironment> {
  const meta = await metadata(client, now);
  const toIso = isoByName(meta.countries);

  const looked: { query: string; values: LushaLocations }[] = [];
  for (const term of handoff.targeting.locations) {
    for (const query of spellings(term, handoff)) looked.push({ query, values: await places(client, query) });
  }
  const locations: ProviderVocabulary["locations"] = [];
  for (const { values } of looked) {
    for (const place of values) {
      const countryIso2 = place.country ? toIso.get(norm(place.country)) : undefined;
      const value = place.city ?? place.state;
      if (countryIso2 === undefined || !value) continue;
      const level = place.city ? ("city" as const) : ("state" as const);
      if (!locations.some((known) => known.value === value && known.level === level && known.countryIso2 === countryIso2)) locations.push({ value, level, countryIso2 });
    }
  }

  const vocabulary: ProviderVocabulary = {
    version: "lusha-v3",
    // Searches send the ISO code, as earlier live clients did; the name maps a preview's country back.
    countries: meta.countries.map((country) => ({ iso2: country.code.toUpperCase(), value: country.code.toUpperCase() })),
    locations,
    industries: meta.industries.flatMap((main) => [
      { id: `main:${main.main_industry_id}`, label: main.main_industry, level: "main" as const },
      ...main.sub_industries.map((sub) => ({ id: `sub:${sub.id}`, label: sub.value, level: "sub" as const })),
    ]),
    sizes: { kind: "buckets", buckets: meta.sizes.map((size) => ({ min: size.min, max: size.max ?? OPEN_ENDED })) },
    pageSize: { ...LUSHA_PAGE_SIZE },
    maxContactsPerCompany: true,
    provenance: {
      fetchedAt: meta.fetchedAt,
      // Over what the translation read, in the order the API gave it: the same answers give the same hash.
      hash: hashOf({ sizes: meta.sizes, industries: meta.industries, countries: meta.countries, locations: looked }),
    },
  };
  return { vocabulary, provider: new LushaProvider(client, meta.countries) };
}

/** A search in V3's terms. Exclusions stay with the core's local guards (v2.1 §5, §7). */
export function lushaSearchBody(request: ProviderSearchRequest, countries: LushaCountries): LushaContactSearch {
  const { filters } = request;
  const nameOf = new Map(countries.map((country) => [country.code.toUpperCase(), country.name]));
  const ids = (level: "main" | "sub") =>
    filters.industryIds.filter((value) => value.startsWith(`${level}:`)).map((value) => Number(value.slice(level.length + 1)));
  const main = ids("main");
  const sub = ids("sub");
  const companies: NonNullable<LushaContactSearch["filters"]["companies"]>["include"] = {
    // v2.2 §4a: the complement search, inside the accounts discovery found.
    ...(filters.companyDomains === undefined || filters.companyDomains.length === 0 ? {} : { domains: [...filters.companyDomains] }),
    ...(filters.sizes.length === 0 ? {} : { sizes: filters.sizes.map((size) => (size.max >= OPEN_ENDED ? { min: size.min } : { min: size.min, max: size.max })) }),
    ...(main.length === 0 ? {} : { mainIndustriesIds: main }),
    ...(sub.length === 0 ? {} : { subIndustriesIds: sub }),
  };
  return {
    filters: {
      contacts: {
        include: {
          ...(filters.titles.length === 0 ? {} : { jobTitles: [...filters.titles] }),
          ...(filters.countries.length === 0 ? {} : { countries: [...filters.countries] }),
          ...(filters.locations.length === 0
            ? {}
            : { locations: filters.locations.map((place) => ({ country: nameOf.get(place.countryIso2) ?? place.countryIso2, [place.level]: place.value })) }),
        },
      },
      ...(Object.keys(companies).length === 0 ? {} : { companies: { include: companies } }),
    },
    ...(filters.maxContactsPerCompany === undefined ? {} : { options: { maxContactsPerCompany: filters.maxContactsPerCompany } }),
    pagination: { page: request.page, size: request.pageSize },
  };
}

/** One preview row. Nothing is revealed; the email's cost is the preview's own `canReveal` entry for it. */
export function lushaCandidate(contact: LushaContact, countries: LushaCountries): ProviderCandidate {
  const toIso = isoByName(countries);
  const has = contact.has ?? [];
  const emailReveal = (contact.canReveal ?? []).find((entry) => entry.field === EMAILS);
  const country = contact.location?.country;
  const optional = (value: string | null | undefined) => (value === null || value === undefined || value.trim() === "" ? undefined : value.trim());
  const domain = optional(contact.company?.domain);
  const companyId = optional(contact.company?.id === null || contact.company?.id === undefined ? undefined : String(contact.company.id));
  const countryIso2 = country ? toIso.get(norm(country)) : undefined;
  const state = optional(contact.location?.state);
  const city = optional(contact.location?.city);
  const linkedinUrl = optional(contact.socialLinks?.linkedin);
  return {
    providerId: contact.id,
    name: [contact.firstName, contact.lastName].map((part) => part?.trim() ?? "").filter((part) => part !== "").join(" "),
    title: optional(contact.jobTitle?.title) ?? "",
    company: optional(contact.company?.name) ?? "",
    ...(domain === undefined ? {} : { domain }),
    ...(companyId === undefined ? {} : { companyId }),
    ...(countryIso2 === undefined ? {} : { countryIso2 }),
    ...(state === undefined ? {} : { state }),
    ...(city === undefined ? {} : { city }),
    ...(linkedinUrl === undefined ? {} : { linkedinUrl }),
    hasEmail: has.includes(EMAILS),
    emailRevealCredits: emailReveal === undefined ? null : emailReveal.credits,
  };
}

/**
 * A load refusal is busy; a request that never left Relay is not sent; no
 * answer, or a server fault, is an unknown outcome. Anything else is a fault.
 */
export function asProviderError(error: unknown): unknown {
  if (error instanceof LushaNotSentError) return new ProviderNotSentError(error.message);
  if (error instanceof LushaHttpError && error.status === 429) return new ProviderBusyError(error.message);
  if (error instanceof LushaNoAnswerError) return new ProviderUnknownOutcomeError(error.message);
  if (error instanceof LushaHttpError && error.status >= 500) return new ProviderUnknownOutcomeError(error.message);
  return error;
}

export class LushaProvider implements LeadGenProvider {
  readonly provider = "lusha" as const;

  constructor(
    private readonly client: LushaClient,
    private readonly countries: LushaCountries,
  ) {}

  async search(request: ProviderSearchRequest): Promise<ProviderSearchPage> {
    let page;
    try {
      page = await this.client.searchContacts(lushaSearchBody(request, this.countries));
    } catch (error) {
      throw asProviderError(error);
    }
    const total = page.pagination?.total;
    const hasMore =
      page.results.length === 0 ? false : total === null || total === undefined ? page.billing.resultsReturned >= request.pageSize : (request.page + 1) * request.pageSize < total;
    return { candidates: page.results.map((contact) => lushaCandidate(contact, this.countries)), charged: page.billing.creditsCharged, hasMore };
  }
}

const optionalText = (value: string | null | undefined) => (value === null || value === undefined || value.trim() === "" ? undefined : value.trim());

/**
 * One enriched contact in Relay's terms. Lusha's `private` email type is
 * Relay's `personal`; its confidence letter is kept as the grade, unread.
 * A per-item error is a reason, never an email; an unknown code is a failure.
 */
export function lushaRevealed(result: LushaEnrichedContact): RevealedContact {
  const code = result.error?.code;
  if (code === "NOT_FOUND") return { status: "not_found" };
  if (code === "COMPLIANCE_RESTRICTED") return { status: "restricted" };
  if (code !== null && code !== undefined) return { status: "failed" };
  // First and last name, as the preview built them, so the two compare like for like.
  const name = [result.firstName, result.lastName].map((part) => part?.trim() ?? "").filter((part) => part !== "").join(" ") || (optionalText(result.fullName) ?? "");
  const domain = optionalText(result.company?.domain);
  const emails = (result.emails ?? []).flatMap((entry) => {
    const address = optionalText(entry.email)?.toLowerCase();
    if (address === undefined || !/^[^\s@]+@[^\s@]+$/.test(address)) return [];
    const type = entry.type === "work" ? ("work" as const) : entry.type === "private" ? ("personal" as const) : ("unknown" as const);
    return [{ address, type, grade: optionalText(entry.confidence) ?? null }];
  });
  return { status: "found", name, ...(domain === undefined ? {} : { domain }), emails };
}

/** Reveal emails over Lusha V3 enrich: emails only, at most 100 ids a request. */
export class LushaRevealer implements RevealProvider {
  readonly provider = "lusha" as const;
  readonly maxIds = LUSHA_ENRICH_MAX_IDS;

  constructor(private readonly client: LushaClient) {}

  async revealEmails(request: RevealRequest): Promise<RevealAnswer> {
    let page;
    try {
      page = await this.client.enrichEmails(request.providerIds);
    } catch (error) {
      throw asProviderError(error);
    }
    const asked = new Set(request.providerIds);
    // Only the ids asked about: anything else in an answer was not bought on purpose.
    const contacts = new Map(page.results.filter((result) => asked.has(result.id)).map((result) => [result.id, lushaRevealed(result)] as const));
    return { contacts, charged: page.billing.creditsCharged };
  }
}

/** The account's credits now. Account-wide: usage names no key. Throws when it cannot be read. */
export async function lushaBalance(client: LushaClient, now: () => Date = () => new Date()) {
  const usage = await client.usage();
  return { remaining: usage.credits.remaining, used: usage.credits.used, total: usage.credits.total, readAt: now(), source: "live" as const };
}
