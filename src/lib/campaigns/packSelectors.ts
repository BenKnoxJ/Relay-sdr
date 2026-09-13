import type { z } from "zod";

import {
  archetypeIds,
  completeModule,
  type candidateSchema,
  type contradictionSchema,
  type PackShape,
  type Phrase,
  type seedFirmSchema,
  type unknownSchema,
} from "../../../agents/research/output.schema";

/**
 * The readings of a stored research pack that more than one screen needs: the
 * campaign Overview now, and the research view after it.
 *
 * Each one looks something up in the pack research wrote and hands it back as
 * written, so two screens can never disagree about which campaign comes
 * first, whose words are whose, or how many sources there were. There is no
 * rewording and no model here: a second extraction is what the signed
 * contract forbids.
 */

export type Candidate = z.infer<typeof candidateSchema>;
export type ResearchGap = z.infer<typeof unknownSchema>;
export type ResearchContradiction = z.infer<typeof contradictionSchema>;
export type SeedFirm = z.infer<typeof seedFirmSchema>;

/**
 * The campaign research ranks first (m16, rank 1) among the kinds of buyer the
 * pack describes: the same rule `planCards()` uses to choose the group its
 * hook is for.
 */
export function topCandidate(pack: PackShape): Candidate | undefined {
  const ids = archetypeIds(pack);
  return completeModule(pack, "m16")
    ?.candidates.slice()
    .sort((a, b) => a.rank - b.rank)
    .find((candidate) => ids.includes(candidate.archetypeId));
}

/** A kind of buyer's name, as research wrote it (m03). */
export function groupName(pack: PackShape, archetypeId: string): string | undefined {
  return completeModule(pack, "m03")?.archetypes.find((group) => group.id === archetypeId)?.name;
}

/**
 * A candidate's lead angle, as words.
 *
 * Research may write the angle out, or name one of the group's own m09 angles
 * by id (the smoke pack names `ang-a1-1`). An id is looked up; words are kept
 * as written. An id that names nothing falls back to the group's m03 opening
 * angle, so an id never reaches a screen.
 */
export function leadAngle(pack: PackShape, candidate: Candidate): string {
  const angles = completeModule(pack, "m09")?.perArchetype.find((entry) => entry.archetypeId === candidate.archetypeId)?.angles ?? [];
  const named = angles.find((angle) => angle.id === candidate.leadAngle);
  if (named !== undefined) return named.text;
  if (/\s/.test(candidate.leadAngle)) return candidate.leadAngle;
  const listed = angles.find((angle) => candidate.angleIds.includes(angle.id));
  const opening = completeModule(pack, "m03")?.archetypes.find((group) => group.id === candidate.archetypeId)?.openingAngle;
  return listed?.text ?? opening ?? candidate.leadAngle;
}

/**
 * A kind of buyer's phrases (m06), split by whose words they are.
 *
 * Only a practitioner's own words are the buyer's. A regulator's, a vendor's
 * or an adviser's (`notBuyer: true`) are kept apart, so nothing shown as the
 * buyer's language is anyone else's. `voice` is the pack's own field and is
 * dropped, as the plan cards drop it.
 */
export function buyerLanguage(pack: PackShape, archetypeId: string): { buyer: Phrase[]; others: Phrase[] } {
  const phrases = (completeModule(pack, "m06")?.perArchetype.find((entry) => entry.archetypeId === archetypeId)?.phrases ?? []).map(
    (phrase) => Object.fromEntries(Object.entries(phrase).filter(([key]) => key !== "voice")) as Phrase,
  );
  return { buyer: phrases.filter((phrase) => !phrase.notBuyer), others: phrases.filter((phrase) => phrase.notBuyer) };
}

/**
 * How many sources the research rests on: m19, which the runtime assembles
 * from every url the pack cites. A pack a limit cut short before m19 counts
 * the distinct urls its items cite instead.
 */
export function sourceCount(pack: PackShape): number {
  const m19 = completeModule(pack, "m19");
  if (m19 !== undefined) return m19.sources.length;
  const urls = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const evidence = (value as { evidence?: { urls?: unknown } }).evidence;
    if (evidence !== undefined && Array.isArray(evidence.urls)) {
      for (const url of evidence.urls) if (typeof url === "string") urls.add(url);
    }
    Object.values(value).forEach(walk);
  };
  walk(pack.modules);
  return urls.size;
}

/** What research could not settle (m18), whole: the finding, why it matters, what to ask, and what was tried. */
export function researchGaps(pack: PackShape): ResearchGap[] {
  return completeModule(pack, "m18")?.unknowns ?? [];
}

/**
 * The questions to settle first: the gaps that come with a question to ask on
 * the first call, in research's own order, at most `max`.
 */
export function verificationQuestions(pack: PackShape, max = 3): { id: string; question: string; whyItMatters: string }[] {
  return researchGaps(pack)
    .flatMap((gap) => (gap.askOnFirstCall === undefined ? [] : [{ id: gap.id, question: gap.askOnFirstCall, whyItMatters: gap.whyItMatters }]))
    .slice(0, max);
}

/** What argues against the case, or where sources disagree (m17), with what it means for the messaging. */
export function researchContradictions(pack: PackShape): ResearchContradiction[] {
  return completeModule(pack, "m17")?.entries ?? [];
}

/**
 * The example firms research sized for each kind of buyer (m04), kept with the
 * group they were found for. They are research's validation sample, not a
 * list of people to contact.
 */
export function seedFirmsByGroup(pack: PackShape): { archetypeId: string; groupName: string; firms: SeedFirm[] }[] {
  return (completeModule(pack, "m04")?.perArchetype ?? []).flatMap((targeting) => {
    const name = groupName(pack, targeting.archetypeId);
    return name === undefined ? [] : [{ archetypeId: targeting.archetypeId, groupName: name, firms: targeting.seedFirms }];
  });
}
