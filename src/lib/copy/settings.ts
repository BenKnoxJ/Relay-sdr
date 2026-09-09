/**
 * Settings, in a rep's words (master doc §23.1f, and the mock's section 5).
 *
 * Four card headings, three of which still carry the one line saying they
 * arrive with their own task. Mailbox is real as of Task 10b, and everything it
 * says is below.
 *
 * Interpolation happens at the call site, never here: the copy sweep in
 * `tests/lib/copy.test.ts` refuses a function, because a template's strings
 * live in a closure it cannot read. So the pieces of "of 10 set by your admin"
 * are separate words and `connections.get` assembles them.
 */
export const settingsCopy = {
  title: "Settings",
  /** The mono note beside the page title, from the signed mock, section 5. */
  note: "yours, not the org's",

  /** One line, under every card that has nothing to show yet. */
  coming: "Coming with the connect step",

  mailbox: "Mailbox",
  linkedin: "LinkedIn",
  voice: "Your voice",
  calls: "Calls",
} as const;

/**
 * The Mailbox card.
 *
 * Nothing here names Microsoft Graph, OAuth, a scope or a refresh: the rep
 * connected their Microsoft 365 mailbox, and when it stops working they are
 * told to connect it again. "Re-link" is the strongest machine-adjacent word on
 * the card and it survives because it is what the rep does, not what Relay
 * calls it.
 */
export const mailboxCopy = {
  /** The provider line under the address, and the label on Connect. */
  provider: "Microsoft 365",
  connect: "Connect your mailbox",
  connectAgain: "Connect it again",
  disconnect: "Disconnect",

  /** Before anything is connected. */
  none: "Relay sends from your own mailbox. Connect it to start.",

  /**
   * The health chip, one word each. `healthy` is the quiet good state; the
   * other two are the only ways a connected mailbox goes wrong in slice 1.
   */
  healthy: "Healthy",
  needsRelink: "Needs re-link",
  paused: "Paused",

  /** Shown under the chip when the mailbox needs connecting again. */
  needsRelinkWhy: "Microsoft stopped accepting the connection. Connect it again to carry on.",

  /** The cap field, and the phrase that says whose ceiling it is. */
  capLabel: "Emails a day",
  capOf: "of",
  capCeiling: "set by your admin",
  capTooHigh: "You can lower this, but only your admin can raise it.",

  windowLabel: "Sending window",
  /** Joins the two ends of the window: "09:00 to 16:30". */
  windowTo: "to",
  daysLabel: "Days",
  rampLabel: "Building up",
  /** Assembled as "Starts at 5 a day and builds up." */
  rampLead: "Starts at",
  rampTail: "a day and builds up.",

  /** Quiet confirmation after a field saves on blur (§23.1f). */
  saved: "Saved",

  /** What Disconnect actually does, said plainly. */
  disconnectNote:
    "Relay stops using this mailbox straight away. To take away its access for good, remove Relay from your Microsoft account.",

  /** After the callback comes back happy. */
  connected: "Your mailbox is connected.",

  /**
   * The three ways a connect can fail, in the rep's words. The provider's own
   * message never reaches this screen: Microsoft's text is written for a
   * developer and often names the app registration.
   */
  failedLink: "That connect link has run out. Start again from this page.",
  failedProvider: "Microsoft could not finish connecting your mailbox. Please try again.",
  failedSetup: "Relay is not set up to connect mailboxes yet. Ask your admin.",
} as const;

/**
 * Weekday names for the days line. Keyed by the three-letter codes the column
 * stores, so a day nobody expected renders as nothing rather than as `sat`.
 */
export const dayNames = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
} as const;
