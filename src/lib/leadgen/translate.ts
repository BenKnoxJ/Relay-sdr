import type { LeadGenHandoff } from "../../../agents/leadgen/input.schema";

import { compareStrings, containsPhrase, domainKey, norm } from "./normalise";
import type { ProviderFilters, ProviderVocabulary } from "./provider";

/**
 * The handoff's targeting in the provider's terms, leadgen v2.1 §5.
 *
 * Pure: the vocabulary is handed in. Nothing here widens a required term. A
 * term that cannot be represented without widening halts before any search.
 * Provider ids stay inside `filters`; nothing the rep reads carries one.
 */

export type TranslationHalt =
  | { reason: "unmappable"; field: "country" | "location" | "industry"; term: string }
  | { reason: "would_widen"; field: "sizeBand" }
  | { reason: "choose_industry"; field: "industry"; term: string; choices: string[] };

export type Translation = {
  ok: true;
  filters: ProviderFilters;
  /** What was actually searched, for provenance and debugging. */
  effective: {
    vocabulary: string;
    /** The metadata the translation read (v2.1 §5), when the vocabulary carries it. */
    provenance?: { fetchedAt: string; hash: string };
    sizeBand: { min: number; max: number };
    locations: { term: string; value: string; level: "state" | "city"; countryIso2: string }[];
    industries: { term: string; label: string; via: "exact" | "alias" | "choice" }[];
  };
  /** Carried, never searched (v2.1 §5). */
  context: { triggers: string[] };
};

export type TranslateOptions = {
  /** Normalised Research label to a provider label, from `INDUSTRY_ALIASES`. */
  industryAliases?: Readonly<Record<string, string>>;
  /** A rep's choice for a term (normalised term to the label they picked), from a `choose_industry` halt. */
  industryChoices?: Readonly<Record<string, string>>;
};

/**
 * The small curated alias table (v2.1 §5, step 2): a normalised Research
 * industry label to the provider label it means. Entries are text, and ids are
 * always resolved from the vocabulary at run time.
 *
 * Each entry is justified against the verified Lusha V3 taxonomy
 * (`fixtures/tools/lusha/company-industries.json`). The three motor-insurance
 * labels below are the existing insurance campaign's recipe, verbatim once
 * normalised. Each names a line of insurance business, and Lusha has exactly
 * one insurance sub-industry, Finance > Insurance (44). Nothing else in the
 * taxonomy could be meant, so this is not a guess. The recipe's titles, size
 * band and seed firms keep the search as narrow as the plan.
 */
export const INDUSTRY_ALIASES: Readonly<Record<string, string>> = {
  "general insurance personal motor": "Insurance",
  "non standard and specialist motor insurance": "Insurance",
  "motor insurance underwriting and claims": "Insurance",
};

const STOPWORDS = new Set(["a", "an", "and", "for", "in", "of", "the", "to"]);

export function translate(
  handoff: LeadGenHandoff,
  vocabulary: ProviderVocabulary,
  options: TranslateOptions = {},
): Translation | { ok: false; halt: TranslationHalt } {
  const { targeting } = handoff;

  const countries: string[] = [];
  for (const iso of targeting.countries) {
    const hit = vocabulary.countries.find((country) => country.iso2 === iso);
    if (hit === undefined) return { ok: false, halt: { reason: "unmappable", field: "country", term: iso } };
    countries.push(hit.value);
  }

  const locations: Translation["effective"]["locations"] = [];
  for (const term of targeting.locations) {
    const hit = resolveLocation(term, handoff, vocabulary);
    if (hit === null) return { ok: false, halt: { reason: "unmappable", field: "location", term } };
    locations.push({ term, ...hit });
  }

  let sizes: { min: number; max: number }[];
  if (vocabulary.sizes.kind === "range") {
    sizes = [{ ...targeting.sizeBand }];
  } else {
    // Only buckets wholly inside the band: that narrows, and never widens.
    sizes = vocabulary.sizes.buckets
      .filter((bucket) => bucket.min >= targeting.sizeBand.min && bucket.max <= targeting.sizeBand.max)
      .sort((a, b) => a.min - b.min || a.max - b.max);
    if (sizes.length === 0) return { ok: false, halt: { reason: "would_widen", field: "sizeBand" } };
  }
  const sizeBand = { min: Math.min(...sizes.map((size) => size.min)), max: Math.max(...sizes.map((size) => size.max)) };

  const industries: Translation["effective"]["industries"] = [];
  const industryIds: string[] = [];
  for (const term of targeting.industries) {
    const resolved = resolveIndustry(term, handoff, vocabulary, options);
    if (!resolved.ok) return { ok: false, halt: resolved.halt };
    industries.push({ term, label: resolved.label, via: resolved.via });
    for (const industryId of resolved.ids) if (!industryIds.includes(industryId)) industryIds.push(industryId);
  }

  const excludeTitles = unique([...targeting.excludeTitles, ...handoff.exclusions.roles]);
  const excludeDomains = unique(
    handoff.exclusions.firms.map((firm) => domainKey(firm.domain)).filter((value): value is string => value !== undefined),
  );

  return {
    ok: true,
    filters: {
      titles: [...targeting.titles],
      excludeTitles,
      countries,
      locations: locations.map(({ value, level, countryIso2 }) => ({ value, level, countryIso2 })),
      sizes,
      industryIds,
      excludeDomains,
      ...(vocabulary.maxContactsPerCompany ? { maxContactsPerCompany: handoff.perCompanyMax } : {}),
    },
    effective: {
      vocabulary: vocabulary.version,
      ...(vocabulary.provenance === undefined ? {} : { provenance: { ...vocabulary.provenance } }),
      sizeBand,
      locations,
      industries,
    },
    context: { triggers: [...targeting.triggers] },
  };
}

/** Every name a location term may be written as: the term, and the aliases of the place it names. */
export function locationNames(term: string, handoff: LeadGenHandoff): Set<string> {
  const names = new Set([norm(term)]);
  for (const place of handoff.places) {
    const all = [place.name, ...place.aliases].map(norm);
    if (all.includes(norm(term))) for (const name of all) names.add(name);
  }
  return names;
}

function resolveLocation(
  term: string,
  handoff: LeadGenHandoff,
  vocabulary: ProviderVocabulary,
): { value: string; level: "state" | "city"; countryIso2: string } | null {
  const names = locationNames(term, handoff);
  const matches = vocabulary.locations.filter(
    (location) => names.has(norm(location.value)) && handoff.targeting.countries.includes(location.countryIso2),
  );
  // Ties are broken by the recipe's own country order. Two matches in the
  // same country are two places, and choosing one would be a guess.
  for (const iso of handoff.targeting.countries) {
    const inCountry = matches.filter((location) => location.countryIso2 === iso);
    if (inCountry.length === 1) return inCountry[0]!;
    if (inCountry.length > 1) return null;
  }
  return null;
}

type Resolved = { ok: true; ids: string[]; label: string; via: "exact" | "alias" | "choice" } | { ok: false; halt: TranslationHalt };

function resolveIndustry(term: string, handoff: LeadGenHandoff, vocabulary: ProviderVocabulary, options: TranslateOptions): Resolved {
  const exact = byLabel(term, vocabulary);
  if (exact.length > 0) return { ok: true, ids: exact.map((entry) => entry.id), label: exact[0]!.label, via: "exact" };

  const alias = options.industryAliases?.[norm(term)];
  if (alias !== undefined) {
    const hits = byLabel(alias, vocabulary);
    if (hits.length > 0) return { ok: true, ids: hits.map((entry) => entry.id), label: hits[0]!.label, via: "alias" };
  }

  const choices = industryChoices(term, vocabulary, handoff.exclusions.orgTypes);
  const picked = options.industryChoices?.[norm(term)];
  if (picked !== undefined && choices.some((choice) => norm(choice) === norm(picked))) {
    const hits = byLabel(picked, vocabulary).filter((entry) => entry.level === "sub");
    if (hits.length > 0) return { ok: true, ids: hits.map((entry) => entry.id), label: hits[0]!.label, via: "choice" };
  }
  if (choices.length > 0) return { ok: false, halt: { reason: "choose_industry", field: "industry", term, choices } };
  return { ok: false, halt: { reason: "unmappable", field: "industry", term } };
}

/** Entries with this label, the narrowest level first: a sub-industry is chosen over a main one of the same name. */
function byLabel(label: string, vocabulary: ProviderVocabulary): ProviderVocabulary["industries"] {
  const hits = vocabulary.industries.filter((entry) => norm(entry.label) === norm(label));
  const sub = hits.filter((entry) => entry.level === "sub");
  return sub.length > 0 ? sub : hits;
}

/**
 * Up to three plain-words choices for a term with no exact or alias match,
 * drawn only from the narrowest level, so a choice cannot silently widen to a
 * whole sector, and never one naming a kind of organisation the brief excludes.
 */
export function industryChoices(term: string, vocabulary: ProviderVocabulary, excludedOrgTypes: readonly string[]): string[] {
  const wanted = tokens(term);
  const seen = new Set<string>();
  return vocabulary.industries
    .filter((entry) => entry.level === "sub")
    .map((entry) => ({ label: entry.label, overlap: [...tokens(entry.label)].filter((token) => wanted.has(token)).length }))
    .filter((entry) => entry.overlap > 0 && !excludedOrgTypes.some((type) => containsPhrase(entry.label, type)))
    .sort((a, b) => b.overlap - a.overlap || compareStrings(norm(a.label), norm(b.label)))
    .filter((entry) => {
      const key = norm(entry.label);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 3)
    .map((entry) => entry.label);
}

function tokens(value: string): Set<string> {
  return new Set(norm(value).split(" ").filter((token) => token !== "" && !STOPWORDS.has(token)));
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = norm(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
