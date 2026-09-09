/**
 * Settings, in a rep's words (master doc §23.1f, and the mock's section 5).
 *
 * Four card headings, all four real: Mailbox as of Task 10b, and LinkedIn,
 * Your voice and Calls as of Task 9e. Everything each card says is below.
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

  mailbox: "Mailbox",
  linkedin: "LinkedIn",
  voice: "Your voice",
  calls: "Calls",

  /** Quiet confirmation after a field saves on blur (§23.1f). Shared by every card. */
  saved: "Saved",
} as const;

/**
 * The LinkedIn card (§23.1f): a profile link and one line about posting.
 *
 * Nothing here says OAuth or connect. In slice 1 Relay prepares messages and
 * the rep pastes them; the link is so a draft can name the profile.
 */
export const linkedinCopy = {
  profileLabel: "Your profile",
  /** An example of the shape, not a value: the field's placeholder. */
  placeholder: "https://www.linkedin.com/in/your-name",
  /** Under the field, as the mock draws it. */
  note: "Relay prepares LinkedIn messages for you to paste. Posting from Relay arrives with Content.",
  /** When the link is not a LinkedIn profile link. */
  badUrl: "That is not a LinkedIn profile link. It starts https://www.linkedin.com/in/ and ends with your name.",
} as const;

/**
 * The Your voice card (§23.1f): the pasted emails, the note, and the promise.
 *
 * "Emails" and not "samples" on the screen: a rep pasted emails. The count
 * line is assembled at the call site from the number and `emails` or `email`.
 */
export const voiceCopy = {
  /** "7 emails", "1 email", or the line for none. */
  email: "email",
  emails: "emails",
  none: "No emails yet. Paste five to ten you are proud of and Relay writes more like them.",
  /** The button under the first three rows: "Show 4 more", then "Show fewer". */
  show: "Show",
  more: "more",
  fewer: "Show fewer",

  /** The row: "96 words · added 2 Sep". */
  words: "words",
  word: "word",
  added: "added",
  remove: "Remove",
  removed: "Removed",

  /** The Add control, and the box it opens. */
  add: "Add an email you are proud of",
  addLabel: "The email, pasted in full",
  addPlaceholder: "Paste the whole email, subject line first.",
  addConfirm: "Add",
  addCancel: "Cancel",
  /** After an email lands in the list. */
  addedLine: "Added",
  /** An empty box. */
  empty: "Paste the email first.",
  /** Why Add is gone once there are ten. */
  full: "Ten is plenty. Remove one to add another.",

  /** The note. */
  noteLabel: "How I write",
  noteHint: "Ten lines at most.",
  notePlaceholder: "Short. One question per email. British spelling. I sign off with my first name.",
  /** Assembled as "That is 12 lines. Keep it to ten." */
  noteTooLongLead: "That is",
  noteTooLongTail: "lines. Keep it to ten.",

  /** The promise, under everything. */
  promise: "Used as examples in every draft. Never sent, never shared.",
} as const;

/**
 * The Calls card (§23.1f): one toggle.
 */
export const callsCopy = {
  toggle: "Include a day-3 call in new campaigns by default",
  note: "You can still turn Calls off per campaign at Start.",
  on: "On",
  off: "Off",
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

  /** Quiet confirmation after the cap saves on blur (§23.1f). The same word every card uses. */
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

/**
 * Short month names for the day a voice email was added ("2 Sep"). Indexed
 * by month number, zero-based, as `Date` counts them.
 */
export const monthNames = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;
