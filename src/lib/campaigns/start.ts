import { campaignsCopy } from "@/lib/copy/campaigns";

import type { BriefFields, BriefScope, Channel } from "./types";

/**
 * Start's allowed values and its pre-fill (§23.1d).
 *
 * Free of zod and of the research contract, because Start is a client
 * component and this module ships to the browser. The server checks the same
 * values again when the brief is submitted (`brief.ts`).
 */

/** One product, as §23.1d says v1 has: Insights360, with the facts version research reads. */
export type Product = { id: string; name: string; factsVersion: number; factsUpdated: string };

export const PRODUCTS: Product[] = [
  { id: "insights360", name: "Insights360", factsVersion: 2, factsUpdated: "11 Sep" },
];

/**
 * The countries a campaign can be in, as the ISO codes research reads. The
 * screen shows `campaignsCopy.countries`' spelling of each.
 */
export const REGIONS = ["GB", "IE", "US"] as const;
export const REGION_DEFAULT = REGIONS[0];

/** The two pickers' allowed values, straight from §23.1d. */
export const HOW_MANY = [10, 20, 30, 50] as const;
export const HOW_LONG = [2, 3, 4, 6] as const;

/** How a size is counted (research v3.2 scope): only an employee band is checked against a firm. */
export const SIZE_UNITS = ["employees", "seats", "sites"] as const;

export const CHANNELS: readonly Channel[] = ["email", "linkedin", "calls"];

/** No hard limits: research judges every part of the market for itself. */
export const EMPTY_SCOPE: BriefScope = {
  extraCountries: [],
  places: [],
  orgTypes: [],
  size: null,
  rolesInclude: [],
  rolesExclude: [],
};

/** A country as a rep says it, or the code itself when there is no spelling. */
export function countryName(code: string): string {
  const names: Record<string, string> = campaignsCopy.countries;
  return names[code] ?? code;
}

/** The fields the pre-fill can guess, and so the ones that can be drawn dashed. */
export type GuessableField = "motion" | "region" | "howMany" | "weeks" | "channels";

/** What Start pre-filled, and what it had to guess (§23.1d: dashed means guessed). */
export type BriefDraft = BriefFields & { guessed: GuessableField[] };

/** What Start sends: the brief as the rep confirmed it, and the request id that makes a second press the same campaign. */
export type StartSubmission = { startRequestId: string; brief: BriefFields };

/** What pressing Start comes back with: the campaign to go to, or a line to show. */
export type StartResult = { id: string } | { error: string };

/**
 * The campaign and the brief version a change is made from (orchestrator A1,
 * items 4 to 6). Every change names the version the rep was looking at, so a
 * page opened before someone else's change cannot stack one on a brief it has
 * not seen.
 */
export type ChangeTarget = { campaignId: string; briefVersion: number };

/** A chosen widening: which of the stop's options, and the id that makes a second press the same choice. */
export type WidenSubmission = ChangeTarget & { optionIndex: number; requestId: string };

/** Try again: the id that makes a second press the same retry. */
export type RetrySubmission = ChangeTarget & { requestId: string };


/** A chosen industry from a Needs you: the term research wrote, the plain-words label chosen, and the id that makes a second press the same choice. */
export type ChooseIndustrySubmission = ChangeTarget & { requestId: string; term: string; label: string };

/** Keep or drop before Reveal (lead gen v2.2 §9a): one person, or everyone chosen at that person's account. */
export type ReviewSubmission = ChangeTarget & { personId: string; scope: "person" | "account"; decision: "kept" | "dropped" };

/** Reveal emails: the figures the rep approved, and the id that makes a second press the same approval. */
export type RevealSubmission = ChangeTarget & { requestId: string; expected: { toReveal: number; known: number; maxCredits: number } };

/**
 * Start's pre-fill, as a keyword mapping.
 *
 * §23.1d has the orchestrator pre-fill this card from the sentence, which is
 * one model call. There is no orchestrator yet and this makes no model call,
 * so the mapping is mechanical and the honesty rule is kept the other way
 * round: a field the sentence does not support is left at its default and
 * named in `guessed`, which is what draws it dashed.
 *
 * Hard limits are never pre-filled. Reading places, kinds of organisation or
 * roles out of a sentence is parsing, and a guessed constraint would hold
 * research to something the rep did not say. The rep adds them.
 */
export function startFromSentence(sentence: string): BriefDraft {
  const text = sentence.toLowerCase();
  const guessed: GuessableField[] = [];

  const channel = /partner|dealer|reseller|channel/.test(text);
  if (!/direct|partner|dealer|reseller|channel/.test(text)) guessed.push("motion");

  const region = REGIONS.find((code) => text.includes(countryName(code).toLowerCase()));
  if (region === undefined) guessed.push("region");

  // Both number pickers are anchored to a unit, so "vets with 10 or more
  // sites" does not silently become a size of ten and, worse, render solid as
  // though the rep had said it.
  const howManyMatch =
    /\b(10|20|30|50)\s+(people|partners|contacts|prospects|firms|companies|dealers|leads)\b/.exec(
      text,
    );
  if (howManyMatch === null) guessed.push("howMany");

  const weeksMatch = /\b(2|3|4|6)\s*weeks?\b/.exec(text);
  if (weeksMatch === null) guessed.push("weeks");

  // Calls start off and are only ever the rep's tap on the chip. There is no
  // saved Calls preference yet, and a sentence is no signal: Insights360 is
  // sold to people whose work is calls, so "who handle a lot of client calls"
  // describes the buyer, not the channel. "Email only" is the rep answering
  // the channels question, so it is not drawn as a guess.
  const saidLinkedin = /linkedin/.test(text);
  const saidEmailOnly = /\b(no|without)\s+(cold\s+)?calls?\b|email only|no phone/.test(text);
  if (!saidLinkedin && !saidEmailOnly) guessed.push("channels");

  const channels: Channel[] = ["email"];
  if (saidLinkedin) channels.push("linkedin");

  return {
    // §23.1d: never invent a product. v1 has one, so it is the one.
    product: PRODUCTS[0]?.name ?? "",
    motion: channel ? "channel" : "direct",
    // The rep's own words, kept (orchestrator §2, "`who` keeps the rep's words").
    who: sentence.trim(),
    region: region ?? REGION_DEFAULT,
    howMany: howManyMatch === null ? 20 : Number(howManyMatch[1]),
    weeks: weeksMatch === null ? 3 : Number(weeksMatch[1]),
    channels,
    scope: EMPTY_SCOPE,
    existingCustomers: "",
    guessed,
  };
}
