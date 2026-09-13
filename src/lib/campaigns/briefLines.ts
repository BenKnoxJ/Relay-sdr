import { campaignsCopy, startCopy } from "@/lib/copy/campaigns";

import { countryName } from "./start";
import type { BriefFields, BriefScope, WidenDimension } from "./types";

/**
 * A brief's parts as one line each, for the brief card and for what a
 * widening option would change.
 *
 * Free of zod and of the research contract, like `start.ts`, because the
 * brief card is drawn in the browser.
 */

/** "5 to 50 people employed", "at least 3 sites", "at most 40 seats". */
export function sizeLine(size: NonNullable<BriefFields["scope"]["size"]>): string {
  const unit = campaignsCopy.sizeUnits[size.unit];
  if (size.min !== undefined && size.max !== undefined) return `${size.min} ${campaignsCopy.sizeTo} ${size.max} ${unit}`;
  if (size.min !== undefined) return `${campaignsCopy.sizeAtLeast} ${size.min} ${unit}`;
  return `${campaignsCopy.sizeAtMost} ${size.max} ${unit}`;
}

const sizeSet = (size: BriefScope["size"]): size is NonNullable<BriefScope["size"]> =>
  size !== null && (size.min !== undefined || size.max !== undefined);

/** Whether the rep has set any hard limit: a country beyond the region, a place, a kind of organisation, a size or a role. */
export function hasLimits(scope: BriefScope): boolean {
  return (
    scope.extraCountries.length > 0 ||
    scope.places.length > 0 ||
    scope.orgTypes.length > 0 ||
    sizeSet(scope.size) ||
    scope.rolesInclude.length > 0 ||
    scope.rolesExclude.length > 0
  );
}

/**
 * The hard limits in one line, for the section while it is closed: "Limits:
 * Ireland · Orkney · veterinary practice · 50 to 250 people employed · never
 * receptionist". In the section's own order, so the same limits always read
 * the same way. Null when there are none.
 */
export function limitsLine(scope: BriefScope): string | null {
  const parts = [
    ...scope.extraCountries.map(countryName),
    ...scope.places.map((place) => place.name),
    ...scope.orgTypes,
    ...(sizeSet(scope.size) ? [sizeLine(scope.size)] : []),
    ...scope.rolesInclude,
    ...scope.rolesExclude.map((role) => `${startCopy.limitsNever} ${role}`),
  ];
  return parts.length === 0 ? null : `${startCopy.limitsLead} ${parts.join(campaignsCopy.noteJoin)}`;
}

/**
 * Where: the region, the countries added to it, and the places, each by name.
 * With `aliases`, a place's other names follow it in brackets.
 */
export function whereLine(brief: BriefFields, { aliases = true }: { aliases?: boolean } = {}): string {
  const places = brief.scope.places.map((place) =>
    !aliases || place.aliases.length === 0 ? place.name : `${place.name} (${campaignsCopy.alsoCalled} ${place.aliases.join(", ")})`,
  );
  return [countryName(brief.region), ...brief.scope.extraCountries.map(countryName), ...places].join(", ");
}

const HEADINGS: Record<WidenDimension, string> = {
  region: campaignsCopy.widenRegion,
  size: campaignsCopy.widenSize,
  sector: campaignsCopy.widenSector,
  role: campaignsCopy.widenRole,
};

/**
 * Each widening option's heading, by the dimension it widens. Research can
 * offer two ways to widen the same thing (brief C offers two regions), and two
 * identical headings would leave the rep telling them apart by research's
 * prose alone, so a repeated heading is numbered within its dimension:
 * "Widen the region · option 1", "Widen the region · option 2". Research's own
 * text is never touched.
 */
export function widenHeadings(dimensions: readonly WidenDimension[]): string[] {
  const seen = new Map<WidenDimension, number>();
  return dimensions.map((dimension) => {
    const count = dimensions.filter((other) => other === dimension).length;
    const n = (seen.get(dimension) ?? 0) + 1;
    seen.set(dimension, n);
    return count === 1 ? HEADINGS[dimension] : `${HEADINGS[dimension]}${campaignsCopy.noteJoin}${campaignsCopy.widenOption} ${n}`;
  });
}

/**
 * What the part of the brief an option widens would read afterwards:
 * "Where becomes United Kingdom". Computed from the brief before and the brief
 * the option makes, not from research's words about it, so two options with
 * similar prose still read as the different changes they are.
 *
 * A constraint with nothing in it afterwards is said as what it is: taken off
 * by this option ("Size limit removed"), or never set by the rep ("No size
 * limit set"). It is never described as something Relay will fill in.
 */
export function becomesLine(dimension: WidenDimension, before: BriefFields, after: BriefFields): string {
  const c = campaignsCopy;
  const line = (label: string, value: string) => `${label} ${c.widenBecomes} ${value}`;
  const list = (label: string, had: readonly string[], has: readonly string[], removed: string, none: string) =>
    has.length > 0 ? line(label, has.join(", ")) : had.length > 0 ? removed : none;
  switch (dimension) {
    case "region":
      return line(c.fieldWhere, whereLine(after, { aliases: false }));
    case "size":
      if (after.scope.size !== null) return line(c.fieldSize, sizeLine(after.scope.size));
      return before.scope.size === null ? c.sizeLimitNone : c.sizeLimitRemoved;
    case "sector":
      return list(c.fieldOrgTypes, before.scope.orgTypes, after.scope.orgTypes, c.orgTypesLimitRemoved, c.orgTypesLimitNone);
    case "role":
      return [
        list(c.fieldRolesInclude, before.scope.rolesInclude, after.scope.rolesInclude, c.rolesIncludeLimitRemoved, c.rolesIncludeLimitNone),
        list(c.fieldRolesExclude, before.scope.rolesExclude, after.scope.rolesExclude, c.rolesExcludeLimitRemoved, c.rolesExcludeLimitNone),
      ].join(c.noteJoin);
  }
}
