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

/** Nothing added: research judges every part of who exactly for itself. */
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

/** What Start knows about the rep before it reads the sentence. */
export type StartDefaults = {
  /**
   * The Calls toggle from Settings (§23.1f, card 4: "include a day-3 call in
   * new campaigns by default"). The default for the Calls chip when the
   * sentence says nothing about calls; the sentence wins when it does, and
   * the chip on Start wins over both for that one campaign.
   */
  callByDefault?: boolean;
};

/** What Start sends: the brief as the rep confirmed it, and the request id that makes a second press the same campaign. */
export type StartSubmission = { startRequestId: string; brief: BriefFields };

/** What pressing Start comes back with: the campaign to go to, or a line to show. */
export type StartResult = { id: string } | { error: string };

/**
 * Start's pre-fill, as a keyword mapping.
 *
 * §23.1d has the orchestrator pre-fill this card from the sentence, which is
 * one model call. There is no orchestrator yet and this makes no model call,
 * so the mapping is mechanical and the honesty rule is kept the other way
 * round: a field the sentence does not support is left at its default and
 * named in `guessed`, which is what draws it dashed.
 *
 * Who exactly is never pre-filled. Reading places, kinds of organisation or
 * roles out of a sentence is parsing, and a guessed constraint would hold
 * research to something the rep did not say. The rep adds them.
 */
export function startFromSentence(sentence: string, defaults: StartDefaults = {}): BriefDraft {
  const { callByDefault = true } = defaults;
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

  // One pattern decides whether calls are on, and the same one decides whether
  // the rep said so: two patterns is how "email only, no cold calls" ends up
  // with calls on and no dashed frame to show it was a guess.
  const saidLinkedin = /linkedin/.test(text);
  const saidNoCalls = /\b(no|without)\s+(cold\s+)?calls?\b|email only|no phone/.test(text);
  const saidCalls = /\bcalls?\b|\bphone\b/.test(text);
  if (!saidLinkedin && !saidCalls && !saidNoCalls) guessed.push("channels");

  const channels: Channel[] = ["email"];
  if (saidLinkedin) channels.push("linkedin");
  // Calls follow the rep's Settings default (§23.1f) unless the sentence said
  // otherwise: "no cold calls" turns them off whatever the toggle, and "call
  // them on day 3" turns them on whatever the toggle.
  if (saidNoCalls ? false : saidCalls || callByDefault) channels.push("calls");

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
