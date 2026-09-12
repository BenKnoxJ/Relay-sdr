import { z } from "zod";

import { researchBriefSchema } from "../../../agents/research/input.schema";
import { lockScope } from "../../../agents/research/output.schema";

import { CHANNELS, HOW_LONG, HOW_MANY, PRODUCTS, REGIONS, SIZE_UNITS } from "./start";
import type { BriefFields, Channel } from "./types";

/**
 * The brief as Start holds it, and as research reads it (research v3 §2 with
 * v3.2 note 28).
 *
 * Server side only: it parses with research's own schema, and zod stays off
 * the browser. The mapping is the whole of the rule "only fields the rep
 * supplied or confirmed belong in `brief.scope`": an empty list or an unset
 * size is left out, never sent as an empty constraint, and `who` is the rep's
 * words exactly as they left them.
 */

export type ResearchBrief = z.infer<typeof researchBriefSchema>;

/** The brief could not be made into one research accepts. The message is for a log, not a rep. */
export class BriefRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BriefRefusedError";
  }
}

const term = z.string().max(200);
const oneOf = (values: readonly number[]) => z.number().int().refine((n) => values.includes(n), "not an allowed value");
// A string checked against the list rather than an enum, so the type stays the
// card's `string`: research reads any ISO code, and the card offers these.
const region = z.string().refine((code) => (REGIONS as readonly string[]).includes(code), "not a country the card offers");

/** What Start may submit: every value one the card offers. */
export const briefFieldsSchema = z
  .object({
    product: z.string().refine((name) => PRODUCTS.some((product) => product.name === name), "not a product"),
    motion: z.enum(["direct", "channel"]),
    who: z.string().max(500).refine((who) => who.trim() !== "", "who is required"),
    region,
    howMany: oneOf(HOW_MANY),
    weeks: oneOf(HOW_LONG),
    channels: z.array(z.enum(CHANNELS as [Channel, ...Channel[]])).min(1).max(CHANNELS.length),
    scope: z
      .object({
        extraCountries: z.array(region).max(REGIONS.length),
        places: z.array(z.object({ name: term, aliases: z.array(term).max(10) }).strict()).max(20),
        orgTypes: z.array(term).max(20),
        size: z
          .object({
            unit: z.enum(SIZE_UNITS),
            min: z.number().int().nonnegative().optional(),
            max: z.number().int().positive().optional(),
          })
          .strict()
          .nullable(),
        rolesInclude: z.array(term).max(30),
        rolesExclude: z.array(term).max(30),
      })
      .strict(),
    existingCustomers: z.string().max(1000),
  })
  .strict();

/** Trimmed, blanks dropped, and each term once (the first spelling wins). */
function terms(list: readonly string[]): string[] {
  const seen = new Map<string, string>();
  for (const raw of list) {
    const value = raw.trim();
    if (value !== "" && !seen.has(value.toLowerCase())) seen.set(value.toLowerCase(), value);
  }
  return [...seen.values()];
}

/**
 * Start's card as research's brief.
 *
 * Throws `BriefRefusedError` (or research's own schema error) for a brief
 * research would refuse, so a bad brief is turned away at Start rather than
 * failing as a job twenty minutes later.
 */
export function toResearchBrief(fields: BriefFields): ResearchBrief {
  const given = fields.scope;
  const scope: Record<string, unknown> = {};

  // Countries: the region always, and more only when the rep added them.
  const extra = terms(given.extraCountries).filter((code) => code !== fields.region);
  if (extra.length > 0) scope.countries = [fields.region, ...extra];

  const places = new Map<string, { name: string; aliases?: string[] }>();
  for (const place of given.places) {
    const name = place.name.trim();
    if (name === "" || places.has(name.toLowerCase())) continue;
    const aliases = terms(place.aliases).filter((alias) => alias.toLowerCase() !== name.toLowerCase());
    places.set(name.toLowerCase(), aliases.length > 0 ? { name, aliases } : { name });
  }
  if (places.size > 0) scope.places = [...places.values()];

  const orgTypes = terms(given.orgTypes);
  if (orgTypes.length > 0) scope.orgTypes = orgTypes;

  if (given.size !== null && (given.size.min !== undefined || given.size.max !== undefined)) {
    scope.size = {
      unit: given.size.unit,
      ...(given.size.min === undefined ? {} : { min: given.size.min }),
      ...(given.size.max === undefined ? {} : { max: given.size.max }),
    };
  }

  const include = terms(given.rolesInclude);
  const exclude = terms(given.rolesExclude);
  if (include.length > 0 || exclude.length > 0) {
    scope.roles = { ...(include.length > 0 ? { include } : {}), ...(exclude.length > 0 ? { exclude } : {}) };
  }

  // Email is always on (§23.1d).
  const channels = [...new Set<Channel>(["email", ...fields.channels])];
  const existingCustomers = fields.existingCustomers.trim();

  const brief = researchBriefSchema.parse({
    product: fields.product,
    motion: fields.motion,
    who: fields.who,
    region: fields.region,
    ...(Object.keys(scope).length > 0 ? { scope } : {}),
    howMany: fields.howMany,
    weeks: fields.weeks,
    channels,
    ...(existingCustomers === "" ? {} : { existingCustomers }),
  });
  const locked = lockScope(brief);
  if (!locked.ok) throw new BriefRefusedError(locked.issue);
  return brief;
}

/** Research's brief back as the card's fields, for the brief card and, later, Edit brief. */
export function briefFieldsFrom(brief: ResearchBrief): BriefFields {
  const scope = brief.scope ?? {};
  const channels = brief.channels.filter((channel): channel is Channel => (CHANNELS as readonly string[]).includes(channel));
  return {
    product: brief.product,
    motion: brief.motion,
    who: brief.who,
    region: brief.region,
    howMany: brief.howMany,
    weeks: brief.weeks,
    channels,
    scope: {
      extraCountries: (scope.countries ?? []).filter((code) => code !== brief.region),
      places: (scope.places ?? []).map((place) => ({ name: place.name, aliases: place.aliases ?? [] })),
      orgTypes: scope.orgTypes ?? [],
      size:
        scope.size === undefined
          ? null
          : {
              unit: scope.size.unit,
              ...(scope.size.min === undefined ? {} : { min: scope.size.min }),
              ...(scope.size.max === undefined ? {} : { max: scope.size.max }),
            },
      rolesInclude: scope.roles?.include ?? [],
      rolesExclude: scope.roles?.exclude ?? [],
    },
    existingCustomers: brief.existingCustomers ?? "",
  };
}

/** How long a campaign's name may be (orchestrator §2: forty characters). */
export const NAME_MAX = 40;

/**
 * A campaign's name, from the rep's own words.
 *
 * Orchestrator §2 names a campaign with a model call; there is none yet, so the
 * name is the start of `who`, cut at a word inside forty characters. It is a
 * label and nothing keys on it.
 */
export function nameFrom(who: string): string {
  const words = who.replace(/\s+/g, " ").trim();
  if (words.length <= NAME_MAX) return words;
  const cut = words.slice(0, NAME_MAX + 1);
  const space = cut.lastIndexOf(" ");
  const name = (space >= NAME_MAX / 2 ? cut.slice(0, space) : words.slice(0, NAME_MAX)).replace(/[\s,;:.-]+$/, "");
  return name === "" ? words.slice(0, NAME_MAX) : name;
}
