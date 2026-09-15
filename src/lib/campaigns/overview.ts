import { completeModule, type PackShape } from "../../../agents/research/output.schema";

import {
  buyerLanguage,
  groupName,
  groupsByRank,
  leadAngle,
  researchContradictions,
  researchGaps,
  seedFirmsByGroup,
  sourceCount,
  topCandidate,
  verificationQuestions,
} from "./packSelectors";
import { cleanContradiction, cleanGap, cleanItem, cleanPhrase, readable } from "./readable";
import type { CampaignOverview, PlayView } from "./types";

/**
 * The campaign Overview: research's own findings, read into the six parts a
 * rep decides on. Everything here is a lookup into the stored pack through the
 * shared selectors; nothing is reworded. Research's text passes through
 * `readable`, as on the research page, so no fact id or internal part name
 * reaches a rep (task 19).
 */

/**
 * The rep summary's lines by place (research v3 §3): who to reach, why now,
 * what to say first, the biggest unknown, the size of the opportunity.
 */
const BIGGEST_UNKNOWN = 3;

/** How many first-call questions lead Check first. */
const FIRST_QUESTIONS = 3;

/**
 * Every campaign play research wrote (m16), in rank order, each read with the
 * kind of buyer it aims at (m03), that group's first pain (m05) and the firms
 * research named for it (m04). The rank-1 play is the one Relay recommends.
 * Nothing is reworded; a play whose group is not in the pack is left out, as
 * `topCandidate` leaves it out.
 */
export function playsOf(pack: PackShape): PlayView[] {
  const top = topCandidate(pack);
  const groups = completeModule(pack, "m03")?.archetypes ?? [];
  const firmsByGroup = new Map(seedFirmsByGroup(pack).map((entry) => [entry.archetypeId, entry.firms.map((firm) => firm.name)]));
  return (completeModule(pack, "m16")?.candidates ?? [])
    .slice()
    .sort((a, b) => a.rank - b.rank)
    .flatMap((candidate) => {
      const group = groups.find((entry) => entry.id === candidate.archetypeId);
      if (group === undefined) return [];
      const pain = completeModule(pack, "m05")?.perArchetype.find((entry) => entry.archetypeId === group.id)?.pains[0];
      return [
        {
          id: candidate.id,
          rank: candidate.rank,
          groupId: group.id,
          groupName: group.name,
          situation: readable(group.situation),
          sizeRange: group.sizeRange,
          roles: group.roles.map((role) => ({ part: role.part, title: role.title })),
          angle: readable(leadAngle(pack, candidate)),
          whyNow: readable(candidate.whyNow),
          wrongIf: readable(candidate.wrongIf),
          channels: [...candidate.channelFit],
          pain: pain === undefined ? null : cleanItem(pain),
          firms: firmsByGroup.get(group.id) ?? [],
          recommended: candidate.id === top?.id,
        },
      ];
    });
}

export function overviewOf(pack: PackShape): CampaignOverview {
  const summary = completeModule(pack, "repSummary");
  const top = topCandidate(pack);

  const groups = groupsByRank(pack).map((group) => ({
    id: group.id,
    name: group.name,
    situation: readable(group.situation),
    sizeRange: group.sizeRange,
    roles: group.roles.map((role) => ({ part: role.part, title: role.title })),
    first: group.id === top?.archetypeId,
  }));

  const topName = top === undefined ? undefined : groupName(pack, top.archetypeId);
  const pains = top === undefined ? [] : (completeModule(pack, "m05")?.perArchetype.find((entry) => entry.archetypeId === top.archetypeId)?.pains ?? []);
  const language = top === undefined ? { buyer: [], others: [] } : buyerLanguage(pack, top.archetypeId);
  // Every question research recommends, in its own order: the first three lead, the rest are one click away.
  const questions = verificationQuestions(pack, Number.POSITIVE_INFINITY).map((entry) => ({ ...entry, question: readable(entry.question), whyItMatters: readable(entry.whyItMatters) }));

  return {
    inShort: { lines: (summary?.lines ?? []).map(readable), verdict: ((verdict) => (verdict === undefined ? null : readable(verdict)))(completeModule(pack, "execSummary")?.verdict) },
    sources: sourceCount(pack),
    startWith:
      top === undefined || topName === undefined
        ? null
        : { groupName: topName, angle: readable(leadAngle(pack, top)), whyNow: readable(top.whyNow), wrongIf: readable(top.wrongIf), channels: [...top.channelFit] },
    groups,
    plays: playsOf(pack),
    pain:
      topName === undefined || pains.length === 0
        ? null
        : { groupName: topName, pains: pains.map(cleanItem), buyerWords: language.buyer.map(cleanPhrase), otherVoices: language.others.map(cleanPhrase) },
    firms: seedFirmsByGroup(pack).map(({ groupName: name, firms }) => ({
      groupName: name,
      firms: firms.map((firm) => ({ ...firm, signal: cleanItem(firm.signal), size: { ...firm.size, ...(firm.size.value === undefined ? {} : { value: readable(firm.size.value) }) } })),
    })),
    checkFirst: {
      summary: summary?.lines[BIGGEST_UNKNOWN] ?? null,
      questions: questions.slice(0, FIRST_QUESTIONS),
      more: questions.slice(FIRST_QUESTIONS),
    },
    gaps: researchGaps(pack).map(cleanGap),
    contradictions: researchContradictions(pack).map(cleanContradiction),
    // A stopped pack is partial too, and has its own card; this is only a plan a limit cut short.
    partial: pack.partial && pack.insufficient === undefined ? [...pack.missingModules] : [],
  };
}
