/**
 * Home (master doc §23.1, §23.1a): day one's brief box, as the signed mock
 * draws it in section 1b, and the three blocks Home becomes once the rep has
 * a campaign: what needs them, what Relay is doing, and the box to start
 * another.
 *
 * Interpolation happens at the call site, never here: the copy sweep in
 * `tests/lib/copy.test.ts` refuses a function, because a template's strings
 * live in a closure it cannot read and would carry a machine word to a screen
 * unchecked. So `welcome` is a word and the page writes "Welcome, Ben".
 */
export const homeCopy = {
  /** Rendered as "Welcome, {first name}" (signed mock 1b). */
  welcome: "Welcome",

  briefQuestion: "Who do you want to reach, and why now?",
  briefHint: "One sentence is enough. Relay asks for anything it still needs.",

  /** The example sentence the signed mock shows greyed inside the box. */
  briefPlaceholder:
    "UK logistics firms opening new depots this year, ops directors, offer call handling",

  briefStart: "Start",
  briefFooter: "Nothing is bought or sent until you confirm a plan.",

  /**
   * One line, above the box, and only while unconnected (§23.1a). The mailbox
   * is the rep's own and lives in Settings (§23.1f). Zoho is the org's and the
   * admin's, and Home says nothing about it: a prompt the rep cannot act on
   * is a nag, not a step.
   */
  connectMailbox: "Connect your mailbox in Settings",

  /** The blocks once there is a campaign (product-truth pass): the Campaigns list's own group words. */
  needsYouLabel: "Needs you",
  needsYouEmpty: "Nothing needs you right now.",
  decideLabel: "To decide",
  readyLabel: "Ready",
  workingLabel: "Relay is working",
  workingEmpty: "Nothing is running.",
  startLabel: "Start a campaign",
} as const;
