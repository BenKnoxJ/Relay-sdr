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

  /** The email status, from the reveal grade and the verification check. */
  status: {
    verified: "Verified",
    held: "Held for checking",
    needs_you: "Needs you",
    bounced: "Bounced",
  },
} as const;
