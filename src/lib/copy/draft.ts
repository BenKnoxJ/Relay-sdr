/**
 * The draft card on the Inbox (signed mock §2a).
 *
 * The three buttons are named here and are inert wherever the bench renders
 * them: a bench that could approve a draft would be a way to send email from a
 * page whose whole purpose is looking at things.
 */
export const draftCopy = {
  /** Before the evidence the opener was built on. */
  openedOn: "Opened on:",
  /** When the lookup found nothing usable and the opener came from the pain. */
  noPersonFact: "No fact about this person, so this opens on the pain.",
  /** When the opener names something that is not in the lookup or the plan. */
  openerMissing: "This opens on something that is not in the lookup or the plan.",

  /**
   * Which message this is, in the rep's words rather than the schema's.
   *
   * The schema stores `email1`, `li_dm`, `breakup`; the signed mock's card
   * says "Email 1 of 3". The "of 3" is the sequence's length, which is not in
   * the draft, so the bench says the half it knows.
   */
  touchKind: {
    email1: "Email 1",
    email2: "Email 2",
    breakup: "Last email",
    li_connect: "LinkedIn invite",
    li_dm: "LinkedIn message",
    call: "Call",
  },

  /** Before the time the message is due to go. */
  sends: "Sends",

  approve: "Approve",
  edit: "Edit",
  reject: "Reject…",
} as const;
