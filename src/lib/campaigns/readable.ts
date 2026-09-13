import type { Item, Phrase } from "../../../agents/research/output.schema";

import { researchCopy } from "@/lib/copy/research";

import type { ResearchContradiction, ResearchGap } from "./packSelectors";

/**
 * Research's text as a rep reads it, on every campaign screen (tasks 18 and
 * 19): the internal names taken out, and nothing else changed. The Overview
 * and the research page both read research's words through this, so neither
 * can show a fact id or a part of the pack by its own name.
 */

/**
 * A fact id as the facts files spell them: product, kind, slug
 * (`i360.boundary.no-compliance-evidence-packs`), sometimes in backticks.
 * Held to the facts files' own kinds, so a domain such as `sabre.co.uk` is
 * never mistaken for one.
 */
const FACT_ID = "`?[a-z0-9]+\\.(?:product|feature|price|integration|boundary|proof|compliance)\\.[a-z0-9]+(?:[.-][a-z0-9]+)*`?";
const FACT_LIST = `${FACT_ID}(?:(?:\\s*,\\s*(?:and\\s+)?|\\s+and\\s+)${FACT_ID})*`;
/** Fact ids cited in brackets: "(i360.product.x, i360.feature.y)". Dropped: the sentence stands without them. */
const FACT_CITATION = new RegExp(`\\s*\\(\\s*${FACT_LIST}\\s*\\)`, "g");
/** "Facts file items i360.x and i360.y": research saying what it inferred from. */
const FACT_FILE = new RegExp(`\\b[Ff]acts? file items?\\s+${FACT_LIST}`, "g");
/** A fact id anywhere else. */
const FACT_BARE = new RegExp(FACT_LIST, "g");
/** One of the pack's own part names, as research writes it in a sentence. */
const PART_ID = /\bm[01]\d\b/g;
/** The two research words for a kind of buyer that are Relay's, not a rep's. */
const BUYER_WORD = /\b(archetype|persona)(s?)\b/gi;

/**
 * Research's sentence with the internal names taken out, and nothing else
 * changed: a cited fact id is dropped, a reference to the facts file reads as
 * Relay's facts about the product, a part of the pack is named as the part of
 * this page that shows it, and "archetype" and "persona" read as the words the
 * rest of Relay uses.
 */
export function readable(text: string): string {
  return text
    .replace(FACT_CITATION, "")
    .replace(FACT_FILE, researchCopy.factsRef)
    .replace(FACT_BARE, researchCopy.factRef)
    .replace(PART_ID, (id) => {
      const name = (researchCopy.partRefs as Record<string, string>)[id];
      return name === undefined ? id : `‘${name}’`;
    })
    .replace(BUYER_WORD, (_word, stem: string, plural: string) =>
      stem.toLowerCase() === "archetype" ? (plural === "" ? researchCopy.kindOfBuyer : researchCopy.kindsOfBuyer) : plural === "" ? researchCopy.role : researchCopy.roles,
    );
}

export const cleanItem = (item: Item): Item => ({
  ...item,
  text: readable(item.text),
  ...(item.inferredFrom === undefined ? {} : { inferredFrom: readable(item.inferredFrom) }),
});
export const cleanPhrase = (phrase: Phrase): Phrase => ({
  ...phrase,
  text: readable(phrase.text),
  ...(phrase.inferredFrom === undefined ? {} : { inferredFrom: readable(phrase.inferredFrom) }),
});

/** An unknown (m18) with its words readable; the searches research ran are kept as it ran them. */
export const cleanGap = (gap: ResearchGap): ResearchGap => ({
  ...gap,
  text: readable(gap.text),
  whyItMatters: readable(gap.whyItMatters),
  ...(gap.askOnFirstCall === undefined ? {} : { askOnFirstCall: readable(gap.askOnFirstCall) }),
});

/** A contradiction (m17) with its words readable, and the two items it rests on. */
export const cleanContradiction = (entry: ResearchContradiction): ResearchContradiction => ({
  ...entry,
  text: readable(entry.text),
  meaning: readable(entry.meaning),
  ...(entry.a === undefined ? {} : { a: cleanItem(entry.a) }),
  ...(entry.b === undefined ? {} : { b: cleanItem(entry.b) }),
});
