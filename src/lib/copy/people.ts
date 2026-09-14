/**
 * Your people, after the reveal (signed mock §3f).
 *
 * One word of state per row and no more: "Person history and next action is
 * later; the one-word state is all slice 1 shows."
 */
export const peopleCopy = {
  title: "Your people",

  /** The count line above the rows. */
  people: "people",

  /**
   * "Why picked", from the parts of the score that fired (leadgen v2.1 §8):
   * "Exact title match at a firm research found, with an email available."
   */
  why: {
    exactTitle: "Exact title match",
    relatedTitle: "Related title",
    seedFirm: "at a firm research found",
    withEmail: "with an email available",
    noEmail: "no email found yet",
    reused: "and Relay already has their email, so no credit is needed",
  },

  /** The email status, from the reveal grade and the verification check. */
  status: {
    verified: "Verified",
    held: "Held for checking",
    needs_you: "Needs you",
    bounced: "Bounced",
  },
} as const;
