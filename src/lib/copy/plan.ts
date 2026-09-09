/**
 * The plan cards, and the four confidence words (signed mock §3b-ii).
 *
 * "Confidence is one of four words: strong, moderate, weak, a guess. Never a
 * number." The schema's fourth word is `speculative`, which is a word for a
 * schema and not for a rep, so the map below is where it becomes "a guess".
 * That translation lives here rather than in the component for the same reason
 * every other string does: it is copy, and copy is swept.
 */
export const planCopy = {
  /** The card that holds the plan and the research behind it. */
  heading: "The plan, and the research behind it",

  /** The five card titles, in the order the signed mock draws them. */
  card: {
    pains: "Their pain, in their words",
    who: "Who we found",
    hook: "The hook",
    firms: "Seed firms and who to target",
    unknowns: "What Relay could not find",
  },

  /** Under the unknowns card, which is the one card that never guesses. */
  unknownsNote: "nothing is guessed here",

  /** The confidence word a rep reads, keyed by the word the schema stores. */
  confidence: {
    strong: "strong",
    moderate: "moderate",
    weak: "weak",
    speculative: "a guess",
  },

  /** What an item with no source says instead of naming one. */
  noSource: "No direct source",

  /**
   * The nouns in a card's `▸ n …` note.
   *
   * "Kinds of buyer" and not the word the signed mock uses there. The mock
   * writes "2 archetypes", and `MACHINE_WORDS` bans that word outright — it is
   * on the list precisely because a rep does not have them. The two signed
   * documents disagree, the rep-words rule is the one with a test behind it,
   * and which of them gives is Benny-san's call, not this file's.
   */
  count: {
    groups: "kinds of buyer",
    sources: "sources",
    firms: "firms",
    items: "items",
    shown: "shown",
    unknowns: "unknowns",
    recipe: "who to target",
    whyNow: "why now",
  },
} as const;
