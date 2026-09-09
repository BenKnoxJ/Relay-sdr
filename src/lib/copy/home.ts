/**
 * Home on day one (master doc §23.1a, "Day one (no campaign)"), and the words
 * of the brief box the signed mock draws in section 1b.
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
   * One line each, above the box, and only while unconnected (§23.1a).
   *
   * The two are not the same sentence because the two connections are not the
   * rep's in the same way: the mailbox is theirs and lives in Settings
   * (§23.1f), while Zoho is the org's and lives in Admin, so the rep is told
   * who to ask rather than sent to a page they cannot act on.
   */
  connectMailbox: "Connect your mailbox in Settings",
  connectZoho: "Ask your admin to connect Zoho",
} as const;
