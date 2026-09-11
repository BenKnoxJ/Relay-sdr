import { z } from "zod";

import { regionSchema, scopeSchema, type Scope } from "../input.schema";
import type { CompleteModule } from "./modules";

/**
 * The rep's locked scope and what is enforced against it (research v3.2,
 * `research.v3.signed.md` §10 note 28).
 *
 * Only a field the rep supplied is a constraint; `countries` always is, from
 * the brief's region. The checks here are the deterministic ones, and they
 * prove no more than they say:
 *
 *   * a seed firm's `country`, `orgType` and employee count are compared with
 *     the scope. These are the model's declarations; the check proves the
 *     declaration is inside the scope, not that it is true;
 *   * a sub-national place is checked twice: the firm's `region` must name it,
 *     and a page the firm cites must name it too. That proves the name is on
 *     a page, not that the firm is there;
 *   * the lead gen recipe may not widen the countries, the places or an
 *     employee band, nor reintroduce an excluded role or org type.
 *
 * Seats, sites and which roles to include stay model judgement. Every issue
 * starts with `SCOPE_ISSUE` so the write tool can tell a scope refusal from any
 * other (the m04 lock).
 */

export const SCOPE_ISSUE = "outside the rep's scope: ";

export const SCOPE_FIELDS = ["countries", "places", "orgTypes", "size", "roles", "excludeOrgTypes", "excludeFirms"] as const;
type ScopeField = (typeof SCOPE_FIELDS)[number];

/** The scope the run is held to: countries always present, and which fields the rep supplied. */
export const lockedScopeSchema = scopeSchema.extend({
  countries: z.array(regionSchema).min(1).max(10),
  supplied: z.array(z.enum(SCOPE_FIELDS)),
});
export type LockedScope = z.infer<typeof lockedScopeSchema>;

/** Lock the brief's scope: the fields the rep gave, countries defaulting to the region. */
export function lockScope(brief: { region: string; scope?: Scope | undefined }): { ok: true; scope: LockedScope } | { ok: false; issue: string } {
  const given = brief.scope ?? {};
  const countries = given.countries ?? [brief.region];
  if (!countries.includes(brief.region)) return { ok: false, issue: `the brief's region ${brief.region} is not one of scope.countries (${countries.join(", ")})` };
  const supplied = SCOPE_FIELDS.filter((field) => field === "countries" || given[field] !== undefined);
  return { ok: true, scope: { ...given, countries, supplied } };
}

/** Words only, lower case, single spaces — so "Kirkwall," and "kirkwall" match. */
export function normaliseWords(text: string): string {
  return text.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
}

/** `term` appears in `text` as whole words. */
export function mentions(text: string, term: string): boolean {
  const needle = normaliseWords(term);
  return needle.length > 0 && ` ${normaliseWords(text)} `.includes(` ${needle} `);
}

/** Every name a place goes by. */
export function placeNames(scope: Pick<LockedScope, "places">): string[] {
  return (scope.places ?? []).flatMap((place) => [place.name, ...(place.aliases ?? [])]);
}

const same = (a: string, b: string): boolean => normaliseWords(a) === normaliseWords(b);
const canonicalDomain = (domain: string): string => domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");

type M04 = CompleteModule<"m04">;
type Seed = M04["perArchetype"][number]["seedFirms"][number];
type Recipe = M04["perArchetype"][number]["recipe"];

/** A page's text by url, when the run read it; the place check reads it. Absent means the check cannot be made and is skipped. */
export type PageText = (url: string) => string | undefined;

/** One seed firm against the scope. */
export function seedScopeIssues(firm: Seed, where: string, scope: LockedScope, pageText?: PageText): string[] {
  const out: string[] = [];
  const say = (message: string): void => {
    out.push(`${SCOPE_ISSUE}${where} (${firm.name}) ${message}`);
  };
  if (!scope.countries.includes(firm.country)) say(`is in ${firm.country}; the brief is ${scope.countries.join(", ")}`);

  const names = placeNames(scope);
  if (names.length > 0) {
    if (!names.some((name) => mentions(firm.region, name))) {
      say(`is in "${firm.region}", which names none of the brief's places (${names.join(", ")})`);
    } else if (pageText !== undefined) {
      const urls = [...firm.signal.evidence.urls, ...(firm.size.source === undefined ? [] : [firm.size.source])];
      const onPage = urls.some((url) => {
        const text = pageText(url);
        return text !== undefined && names.some((name) => mentions(text, name));
      });
      if (!onPage) say(`cites no page that names ${names.join(" or ")}`);
    }
  }

  if (scope.orgTypes !== undefined) {
    if (firm.orgType === undefined) say(`needs orgType, one of: ${scope.orgTypes.join(", ")}`);
    else if (!scope.orgTypes.some((type) => same(type, firm.orgType!))) say(`is a "${firm.orgType}"; the brief is ${scope.orgTypes.join(", ")}`);
  }
  if (firm.orgType !== undefined && (scope.excludeOrgTypes ?? []).some((type) => same(type, firm.orgType!))) say(`is a "${firm.orgType}", which the brief excludes`);

  if (scope.size !== undefined && scope.size.unit === "employees" && firm.size.status !== "unknown") {
    const band = firm.size.employees;
    if (band === undefined || (band.min === undefined && band.max === undefined)) {
      say("has a size but no size.employees; the brief sets an employee band");
    } else {
      // Overlap: the firm's band and the brief's share at least one head count.
      const low = band.min ?? band.max!;
      const high = band.max ?? band.min!;
      if (scope.size.max !== undefined && low > scope.size.max) say(`has ${low}+ employees; the brief's band ends at ${scope.size.max}`);
      if (scope.size.min !== undefined && high < scope.size.min) say(`has at most ${high} employees; the brief's band starts at ${scope.size.min}`);
    }
  }

  for (const excluded of scope.excludeFirms ?? []) {
    const byDomain = excluded.domain !== undefined && firm.domain !== undefined && canonicalDomain(excluded.domain) === canonicalDomain(firm.domain);
    if (byDomain || same(excluded.name, firm.name)) say("is a firm the brief excludes");
  }
  return out;
}

/** One targeting recipe against the scope: it may narrow, never widen. */
export function recipeScopeIssues(recipe: Recipe, where: string, scope: LockedScope): string[] {
  const out: string[] = [];
  const say = (message: string): void => {
    out.push(`${SCOPE_ISSUE}${where}.recipe ${message}`);
  };
  const wider = recipe.countries.filter((country) => !scope.countries.includes(country));
  if (wider.length > 0) say(`adds countries ${wider.join(", ")}; the brief is ${scope.countries.join(", ")}`);

  const names = placeNames(scope);
  if (names.length > 0) {
    const locations = recipe.locations ?? [];
    if (locations.length === 0) say(`must carry the brief's places in locations (${(scope.places ?? []).map((p) => p.name).join(", ")}) so lead gen searches there`);
    for (const location of locations) if (!names.some((name) => same(name, location))) say(`locations names "${location}", which is not one of the brief's places`);
  }

  if (scope.size !== undefined && scope.size.unit === "employees") {
    if (scope.size.min !== undefined && recipe.sizeBand.min < scope.size.min) say(`sizeBand starts at ${recipe.sizeBand.min}; the brief's band starts at ${scope.size.min}`);
    if (scope.size.max !== undefined && recipe.sizeBand.max > scope.size.max) say(`sizeBand ends at ${recipe.sizeBand.max}; the brief's band ends at ${scope.size.max}`);
  }

  for (const role of scope.roles?.exclude ?? []) {
    if (!recipe.excludeTitles.some((title) => mentions(title, role))) say(`excludeTitles must exclude "${role}"`);
    for (const title of recipe.titles) if (mentions(title, role)) say(`titles include "${title}", an excluded role`);
  }
  for (const type of scope.excludeOrgTypes ?? []) {
    for (const industry of recipe.industries) if (mentions(industry, type)) say(`industries include "${industry}", an excluded kind of organisation`);
  }
  return out;
}

/** m04 against the scope: every recipe and every seed firm. */
export function m04ScopeIssues(m04: M04, scope: LockedScope, pageText?: PageText): string[] {
  return m04.perArchetype.flatMap((t, i) => [
    ...recipeScopeIssues(t.recipe, `m04.perArchetype.${i}`, scope),
    ...t.seedFirms.flatMap((f, j) => seedScopeIssues(f, `m04.perArchetype.${i}.seedFirms.${j}`, scope, pageText)),
  ]);
}

// ---------------------------------------------------------------------------
// Widening options (the stop's): each one a scope change the rep approves.

export const WIDEN_DIMENSIONS = ["region", "size", "sector", "role"] as const;

/** A scope change: the fields of the one dimension, where `null` removes the constraint. */
export const scopePatchSchema = z
  .object({
    countries: z.array(regionSchema).min(1).max(10).optional(),
    places: scopeSchema.shape.places.unwrap().nullable().optional(),
    size: scopeSchema.shape.size.unwrap().nullable().optional(),
    orgTypes: scopeSchema.shape.orgTypes.unwrap().nullable().optional(),
    excludeOrgTypes: scopeSchema.shape.excludeOrgTypes.unwrap().nullable().optional(),
    roles: scopeSchema.shape.roles.unwrap().nullable().optional(),
  })
  .strict();

export const wideningSchema = z
  .object({ dimension: z.enum(WIDEN_DIMENSIONS), text: z.string().min(1).max(400), scopePatch: scopePatchSchema })
  .strict();
export type Widening = z.infer<typeof wideningSchema>;

const FIELDS_OF: Record<Widening["dimension"], ReadonlyArray<keyof z.infer<typeof scopePatchSchema>>> = {
  region: ["countries", "places"],
  size: ["size"],
  sector: ["orgTypes", "excludeOrgTypes"],
  role: ["roles"],
};

const SUPPLIED_OF: Record<Widening["dimension"], ReadonlyArray<ScopeField>> = {
  region: ["countries", "places"],
  size: ["size"],
  sector: ["orgTypes", "excludeOrgTypes"],
  role: ["roles"],
};

/**
 * Whether a list relation widens: `null` removes the constraint (wider when
 * there was one); otherwise `more` must hold every old entry, and for a
 * strict widening one more.
 */
function listWidens(before: string[] | undefined, after: string[] | null | undefined, more: boolean): "wider" | "same" | "narrower" {
  if (after === undefined) return "same";
  const had = before ?? [];
  if (after === null) return had.length > 0 ? (more ? "wider" : "narrower") : "same";
  const keep = (list: string[], other: string[]) => list.every((x) => other.some((y) => same(x, y)));
  if (more) {
    if (!keep(had, after)) return "narrower";
    return after.length > had.length ? "wider" : "same";
  }
  // A list that constrains by exclusion widens by losing entries.
  if (!keep(after, had)) return "narrower";
  return after.length < had.length ? "wider" : "same";
}

/**
 * Why a widening option is not one, or null when it genuinely widens the
 * locked scope on its dimension and changes nothing else.
 */
export function wideningIssue(scope: LockedScope, widening: Widening): string | null {
  const patch = widening.scopePatch;
  const touched = (Object.keys(patch) as Array<keyof typeof patch>).filter((key) => patch[key] !== undefined);
  const allowed = FIELDS_OF[widening.dimension];
  const stray = touched.filter((key) => !allowed.includes(key));
  if (touched.length === 0) return `a ${widening.dimension} widening changes nothing`;
  if (stray.length > 0) return `a ${widening.dimension} widening may change only ${allowed.join(" and ")}, not ${stray.join(", ")}`;
  if (!SUPPLIED_OF[widening.dimension].some((field) => scope.supplied.includes(field))) return `the rep set no ${widening.dimension} to widen`;

  const verdicts: Array<"wider" | "same" | "narrower"> = [];
  switch (widening.dimension) {
    case "region": {
      if (patch.countries !== undefined) verdicts.push(listWidens(scope.countries, patch.countries, true));
      if (patch.places !== undefined) verdicts.push(listWidens(scope.places?.map((p) => p.name), patch.places === null ? null : patch.places.map((p) => p.name), true));
      break;
    }
    case "size": {
      const before = scope.size!;
      const after = patch.size;
      if (after === null) verdicts.push("wider");
      else if (after !== undefined) {
        if (after.unit !== before.unit) return `a size widening keeps the unit (${before.unit})`;
        const lowWider = before.min !== undefined && (after.min === undefined || after.min < before.min);
        const lowNarrower = after.min !== undefined && (before.min === undefined || after.min > before.min);
        const highWider = before.max !== undefined && (after.max === undefined || after.max > before.max);
        const highNarrower = after.max !== undefined && (before.max === undefined || after.max < before.max);
        verdicts.push(lowNarrower || highNarrower ? "narrower" : lowWider || highWider ? "wider" : "same");
      }
      break;
    }
    case "sector": {
      if (patch.orgTypes !== undefined) verdicts.push(listWidens(scope.orgTypes, patch.orgTypes, true));
      if (patch.excludeOrgTypes !== undefined) verdicts.push(listWidens(scope.excludeOrgTypes, patch.excludeOrgTypes, false));
      break;
    }
    case "role": {
      const after = patch.roles;
      if (after === null) verdicts.push((scope.roles?.include?.length ?? 0) + (scope.roles?.exclude?.length ?? 0) > 0 ? "wider" : "same");
      else if (after !== undefined) {
        // A sub-list the patch leaves out is unchanged.
        verdicts.push(listWidens(scope.roles?.include, after.include, true));
        verdicts.push(listWidens(scope.roles?.exclude, after.exclude, false));
      }
      break;
    }
  }
  if (verdicts.includes("narrower")) return `the ${widening.dimension} option narrows the brief instead of widening it`;
  if (!verdicts.includes("wider")) return `the ${widening.dimension} option does not widen the brief`;
  return null;
}
