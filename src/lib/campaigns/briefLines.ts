import { campaignsCopy } from "@/lib/copy/campaigns";

import { countryName } from "./start";
import type { BriefFields, WidenDimension } from "./types";

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
 * What the part of the brief an option widens would read afterwards, from the
 * widened brief: "Where becomes United Kingdom". Computed from the brief the
 * option makes, not from research's words about it, so two options with
 * similar prose still read as the different changes they are.
 */
export function becomesLine(dimension: WidenDimension, after: BriefFields): string {
  const c = campaignsCopy;
  const line = (label: string, value: string) => `${label} ${c.widenBecomes} ${value}`;
  switch (dimension) {
    case "region":
      return line(c.fieldWhere, whereLine(after, { aliases: false }));
    case "size":
      return line(c.fieldSize, after.scope.size === null ? c.widenAny : sizeLine(after.scope.size));
    case "sector":
      return line(c.fieldOrgTypes, after.scope.orgTypes.length === 0 ? c.widenAny : after.scope.orgTypes.join(", "));
    case "role":
      return [
        line(c.fieldRolesInclude, after.scope.rolesInclude.length === 0 ? c.widenAny : after.scope.rolesInclude.join(", ")),
        line(c.fieldRolesExclude, after.scope.rolesExclude.length === 0 ? c.widenNone : after.scope.rolesExclude.join(", ")),
      ].join(c.noteJoin);
  }
}
