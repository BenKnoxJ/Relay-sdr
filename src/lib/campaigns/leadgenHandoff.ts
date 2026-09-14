import { leadgenRecipe, type PackShape } from "../../../agents/research/output.schema";
import { leadGenHandoffV1Schema, type LeadGenHandoffV1, type Targeting } from "../../../agents/leadgen/input.schema";

import type { ResearchBrief } from "./brief";
import { groupName, seedFirmsByGroup, topCandidate } from "./packSelectors";

/**
 * The campaign boundary between Research and lead gen (leadgen v2.1 §3).
 *
 * This is the one place that reads a research pack and writes the handoff
 * Confirm freezes. Lead gen never sees the pack. H1's selection rule lives
 * here and only here: the top-ranked campaign candidate, recorded with
 * `sourceRank` as provenance. `chosenArchetypeId()`'s fallback to the first
 * group when nothing is ranked is deliberately not used: an unranked pack is
 * refused, and a group with no recipe is refused, never swapped for another.
 */

export type HandoffRefusal = "research_not_ready" | "no_ranked_group" | "no_recipe";

export type ConfirmFacts = {
  campaign: { id: string; orgId: string; ownerUserId: string; briefVersion: number };
  brief: ResearchBrief;
  research: { jobId: string; eventId: string; pack: PackShape };
  confirmRequestId: string;
  spend: LeadGenHandoffV1["spend"];
  lawfulBasis: LeadGenHandoffV1["lawfulBasis"];
};

export function buildLeadGenHandoff(facts: ConfirmFacts): { ok: true; handoff: LeadGenHandoffV1 } | { ok: false; refusal: HandoffRefusal } {
  const { pack, jobId, eventId } = facts.research;
  // A stopped pack is not a plan: there is nothing to confirm.
  if (pack.insufficient !== undefined) return { ok: false, refusal: "research_not_ready" };

  const candidate = topCandidate(pack);
  const name = candidate === undefined ? undefined : groupName(pack, candidate.archetypeId);
  if (candidate === undefined || name === undefined) return { ok: false, refusal: "no_ranked_group" };

  const recipe = leadgenRecipe(pack, candidate.archetypeId);
  if (recipe === undefined) return { ok: false, refusal: "no_recipe" };
  // Research's recipe is the handoff's targeting, field for field. The
  // annotation is the compile-time proof; the parse below is the run-time one.
  const targeting: Targeting = {
    titles: recipe.titles,
    excludeTitles: recipe.excludeTitles,
    sizeBand: recipe.sizeBand,
    countries: recipe.countries,
    locations: recipe.locations ?? [],
    industries: recipe.industries,
    triggers: recipe.triggers,
  };

  const firms = seedFirmsByGroup(pack).find((group) => group.archetypeId === candidate.archetypeId)?.firms ?? [];
  const scope = facts.brief.scope;

  const handoff = leadGenHandoffV1Schema.parse({
    version: 1,
    campaign: { ...facts.campaign, confirmRequestId: facts.confirmRequestId },
    provenance: { researchJobId: jobId, researchEventId: eventId, outcome: pack.partial ? "partial" : "complete" },
    buyerGroup: { id: candidate.archetypeId, name, sourceRank: candidate.rank },
    targeting,
    places: (scope?.places ?? []).map((place) => ({ name: place.name, aliases: place.aliases ?? [] })),
    exclusions: {
      firms: (scope?.excludeFirms ?? []).map((firm) => ({ name: firm.name, ...(firm.domain === undefined ? {} : { domain: firm.domain }) })),
      roles: scope?.roles?.exclude ?? [],
      orgTypes: scope?.excludeOrgTypes ?? [],
    },
    seedFirms: firms.map((firm) => ({ name: firm.name, ...(firm.domain === undefined ? {} : { domain: firm.domain }), country: firm.country })),
    howMany: facts.brief.howMany,
    perCompanyMax: 3,
    spend: facts.spend,
    lawfulBasis: facts.lawfulBasis,
  });
  return { ok: true, handoff };
}
