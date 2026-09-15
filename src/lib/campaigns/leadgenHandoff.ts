import { leadgenRecipe, type PackShape } from "../../../agents/research/output.schema";
import { leadGenHandoffV2Schema, type LeadGenHandoffV2, type Targeting } from "../../../agents/leadgen/input.schema";

import type { ResearchBrief } from "./brief";
import { candidateById, groupName, groupRoles, seedFirmsByGroup, topCandidate } from "./packSelectors";

/**
 * The campaign boundary between Research and lead gen (leadgen v2.1 §3, v2.2
 * §3a).
 *
 * This is the one place that reads a research pack and writes the handoff
 * Confirm freezes. Lead gen never sees the pack. The selection rule lives
 * here and only here (lead gen v2.3): the play the rep chose, or, when they
 * chose none, the top-ranked campaign candidate, recorded with `sourceRank`
 * as provenance and its id as the play. `chosenArchetypeId()`'s
 * fallback to the first group when nothing is ranked is deliberately not
 * used: an unranked pack is refused, and a group with no recipe is refused,
 * never swapped for another.
 *
 * From v2.2 the handoff is V2: the same fields, plus the play's id and the
 * confirmed group's roles copied verbatim, so lead gen can tell who runs it,
 * who champions it and who signs it off without reading Research.
 */

export type HandoffRefusal = "research_not_ready" | "no_ranked_group" | "no_recipe" | "unknown_candidate";

export type ConfirmFacts = {
  campaign: { id: string; orgId: string; ownerUserId: string; briefVersion: number };
  brief: ResearchBrief;
  research: { jobId: string; eventId: string; pack: PackShape };
  confirmRequestId: string;
  /** The play the rep chose (an m16 candidate id). Absent: research's top-ranked play, as before. */
  candidateId?: string;
  spend: LeadGenHandoffV2["spend"];
  lawfulBasis: LeadGenHandoffV2["lawfulBasis"];
};

export function buildLeadGenHandoff(facts: ConfirmFacts): { ok: true; handoff: LeadGenHandoffV2 } | { ok: false; refusal: HandoffRefusal } {
  const { pack, jobId, eventId } = facts.research;
  // A stopped pack is not a plan: there is nothing to confirm.
  if (pack.insufficient !== undefined) return { ok: false, refusal: "research_not_ready" };

  // A chosen play must be one this pack ranks, for a kind of buyer it describes; never a stale or invented id.
  const candidate = facts.candidateId === undefined ? topCandidate(pack) : candidateById(pack, facts.candidateId);
  if (facts.candidateId !== undefined && candidate === undefined) return { ok: false, refusal: "unknown_candidate" };
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

  const handoff = leadGenHandoffV2Schema.parse({
    version: 2,
    campaign: { ...facts.campaign, confirmRequestId: facts.confirmRequestId },
    provenance: { researchJobId: jobId, researchEventId: eventId, outcome: pack.partial ? "partial" : "complete" },
    buyerGroup: { id: candidate.archetypeId, name, sourceRank: candidate.rank },
    play: { id: candidate.id },
    // The group's roles as research wrote them, field for field: no rewording, no merging.
    buyerRoles: groupRoles(pack, candidate.archetypeId).map((role) => ({ title: role.title, seniority: role.seniority, part: role.part, needs: role.needs })),
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
