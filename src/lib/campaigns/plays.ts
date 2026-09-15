import { archetypeIds, completeModule, leadgenRecipe, type PackShape } from "../../../agents/research/output.schema";

import { groupName, groupRoles, leadAngle, type Candidate } from "./packSelectors";
import { readable } from "./readable";
import type { ResearchPlayView } from "./types";

/**
 * Research's campaign plays (m16 candidates), as the campaign boundary reads
 * them: which exist, in what order, and which can be confirmed.
 *
 * A play is **usable** when the kind of buyer it is for is one the pack
 * describes (m03). It is **executable** when that kind of buyer also has a
 * search recipe (m04): only an executable play can be confirmed, because the
 * recipe is the handoff's targeting. The order is research's rank, ties in
 * research's own order. Nothing here is reworded, and nothing is normalised
 * out of the pack: the pack stays the one record of what research wrote.
 */

/** The three facts ranking and confirming need, from a whole pack or from the few paths a summary reads. */
export type PlayFacts = {
  archetypeIds: readonly string[];
  recipeArchetypeIds: readonly string[];
  candidates: readonly { id: string; rank: number; archetypeId: string }[];
};

export type RankedPlay = { id: string; rank: number; archetypeId: string; executable: boolean };

export function playFactsOf(pack: PackShape): PlayFacts {
  const ids = archetypeIds(pack);
  return {
    archetypeIds: ids,
    recipeArchetypeIds: ids.filter((id) => leadgenRecipe(pack, id) !== undefined),
    candidates: (completeModule(pack, "m16")?.candidates ?? []).map((candidate) => ({ id: candidate.id, rank: candidate.rank, archetypeId: candidate.archetypeId })),
  };
}

/** Every usable play, best first. A stopped pack has none: it is evidence, not a plan. */
export function rankedPlays(facts: PlayFacts): RankedPlay[] {
  const groups = new Set(facts.archetypeIds);
  const recipes = new Set(facts.recipeArchetypeIds);
  return facts.candidates
    .map((candidate, order) => ({ candidate, order }))
    .filter(({ candidate }) => groups.has(candidate.archetypeId))
    .sort((a, b) => a.candidate.rank - b.candidate.rank || a.order - b.order)
    .map(({ candidate }) => ({ ...candidate, executable: recipes.has(candidate.archetypeId) }));
}

/** How many plays could be confirmed. Plan ready needs at least one. */
export function executablePlayCount(facts: PlayFacts): number {
  return rankedPlays(facts).filter((play) => play.executable).length;
}

/**
 * The play Confirm freezes when the rep names none: research's top-ranked
 * usable play, as it always was (lead gen v2.1 §3). It is refused, not
 * swapped, when it cannot be searched.
 */
export function defaultPlayId(facts: PlayFacts): string | null {
  return rankedPlays(facts)[0]?.id ?? null;
}

/**
 * The plays as the rep compares them: research's own words for each, the
 * roles its kind of buyer is reached through, and the firms research named
 * for it. No module structure, no fact id and no internal part name.
 */
export function playsOf(pack: PackShape): ResearchPlayView[] {
  if (pack.insufficient !== undefined) return [];
  const byId = new Map((completeModule(pack, "m16")?.candidates ?? []).map((candidate) => [candidate.id, candidate]));
  const firmsFor = new Map((completeModule(pack, "m04")?.perArchetype ?? []).map((entry) => [entry.archetypeId, entry.seedFirms]));
  const ranked = rankedPlays(playFactsOf(pack));
  const recommended = ranked[0]?.id ?? null;
  return ranked.flatMap((play) => {
    const candidate = byId.get(play.id) as Candidate | undefined;
    const name = groupName(pack, play.archetypeId);
    if (candidate === undefined || name === undefined) return [];
    const firms = firmsFor.get(play.archetypeId) ?? [];
    const named = new Set(candidate.seedFirmIds);
    return [
      {
        id: play.id,
        rank: play.rank,
        recommended: play.id === recommended,
        group: { id: play.archetypeId, name },
        leadAngle: readable(leadAngle(pack, candidate)),
        whyNow: readable(candidate.whyNow),
        wrongIf: readable(candidate.wrongIf),
        channels: [...candidate.channelFit],
        roles: groupRoles(pack, play.archetypeId).map((role) => ({ part: role.part, title: role.title })),
        seedFirms: firms.filter((firm) => named.has(firm.id)).map((firm) => firm.name),
        groupSeedFirms: firms.length,
        executable: play.executable,
      },
    ];
  });
}
