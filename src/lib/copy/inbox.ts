/**
 * The Inbox, in a rep's words (master doc §23.1b; the signed mock, sections
 * 2, 2a, 2b, 2c).
 *
 * One queue, three kinds of card, and one job per card. Every string a rep
 * reads on the page is here and nowhere else, so the sweep in
 * `tests/lib/copy.test.ts` holds all of it to the rep-words rule (§22.4).
 *
 * Interpolation happens at the call site, never here: the sweep refuses a
 * function, so the pieces of "Approved. Sends Thu 09:00." are separate words
 * and the components assemble them.
 *
 * Until there are Draft, Reply and Call rows, everything on the page is
 * `src/lib/fixtures/inbox.ts`, and the page says so: a banner at the top, and
 * the word "example" where the signed mock had the counts. Nothing here
 * promises a time the next drafts land, because nothing writes them yet.
 *
 * The three vocabularies below — the four reject reasons, the four reply
 * labels, the four call outcomes — are the SIGNED ones (§23.1b) and are
 * exported as `as const` unions so the data model's enums (§25, slice 1) can
 * import them rather than spell them a second time.
 */

/** §23.1b: Reject is one of four reasons, each with a consequence. */
export const REJECT_REASONS = ["wrong_angle", "wrong_person", "wrong_fact", "not_now"] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

/** §23.1b: a reply gets one of four labels. */
export const REPLY_LABELS = ["warm", "later", "no", "stop"] as const;
export type ReplyLabel = (typeof REPLY_LABELS)[number];

/** §23.1b: a call gets one of four outcomes. */
export const CALL_OUTCOMES = ["spoke", "voicemail", "no_answer", "wrong_number"] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

/**
 * Why a draft needs the rep before it can go: the two ways a draft comes back
 * from the checks (§23.1b, "Needs you"). The keys are the page's; the words
 * beside them are what the row says.
 */
export const NEEDS_YOU_REASONS = ["voice", "fact", "checks", "not_written"] as const;
export type NeedsYouReason = (typeof NEEDS_YOU_REASONS)[number];

/** How well a person fits, as a word and never a number (§21 rule 2). */
export const FIT_WORDS = ["strong", "fair", "weak"] as const;
export type FitWord = (typeof FIT_WORDS)[number];

export const inboxCopy = {
  title: "Inbox",

  /**
   * The banner above the queue while the queue is the fixture. Persistent
   * and plain: a rep must never mistake these for their own replies.
   */
  demoBanner:
    "Example queue. These replies, calls and drafts are examples. Real drafts arrive here when outreach is written.",
  /** The header note while the queue is the fixture: the signed mock's counts would be counts of examples. */
  exampleNote: "example",
  countDraftOne: "draft to review",
  countDraftMany: "drafts to review",
  /** The header note when the queue is empty (mock section 2c). */
  nothingWaiting: "nothing waiting",

  /** The three headings, in the signed order. */
  headingReplies: "Replies",
  headingCalls: "Calls due",
  headingDrafts: "Drafts due today",

  /** The accessible name of the list. */
  queueLabel: "Your queue",

  /** The one word of state on the right of a row. */
  stateLabel: "label",
  stateToday: "today",
  stateToReview: "to review",
  /** The warn chip on a draft that needs the rep. */
  needsYou: "needs you",

  /** The row's context line for a draft that needs the rep: "Needs you · voice check failed twice". */
  needsYouLead: "Needs you",
  needsYouReason: {
    voice: "voice check failed twice",
    fact: "a fact did not check out",
    /** Outreach v2.1 §6: two generations, and the checks still found something. */
    checks: "Relay's checks still found something after a second try",
    not_written: "Relay couldn't write this one",
  },
  /** Above the body on a draft that needs the rep. */
  needsYouCard: "Read this one before it goes.",
  /** Above what the checks found, on a draft that needs the rep. */
  findingsLead: "What the checks found:",
  /** The Tier B advice line on a draft. */
  adviceLead: "Worth a look:",
  /** A draft that could not be written has nothing to approve. */
  notWrittenCard: "There is no draft to approve. Relay tried twice and kept nothing it could stand behind.",
  /** The chip on a draft when nothing is sent yet (outreach v2.1 §1). */
  nothingSentYet: "Nothing is sent yet",
  /** After Approve, while sending is not built. */
  approvedReady: "Approved. Ready to send; nothing is sent yet.",
  /** A draft someone already approved or rejected, from another tab or an earlier press. */
  alreadyDecided: "This draft was already decided. Reload the Inbox to see where it is.",
  /** A draft that could not be changed, and the reason is not the rep's to act on. */
  cannotDecide: "That did not go through. Reload the Inbox and try again.",
  /** The empty Inbox on real data, while replies and calls are not built. */
  emptyLive: "No drafts waiting. First emails land here when you press Write emails on a campaign.",
  /** The line under a draft's evidence when the opener is the role problem. */
  noPersonFact: "Nothing usable came up about them or their firm, so this opens on the problem their role owns.",
  /** A draft card's small campaign line. */
  fromCampaign: "From",

  /** The row context for a draft: "Email 1 of 3 · Kestrel Couriers". */
  email: "Email",
  of: "of",
  /** The row context for a call: "Day-3 call · Marlow Freight". */
  dayCall: "Day-3 call",
  /** The mono word beside the call card's name line. */
  dayCallSmall: "day-3 call",
  /** Between the two halves of a context line, and between name and title. */
  join: " · ",

  /** The evidence line on a draft card: "Opened on: …". */
  openedOn: "Opened on:",
  /** The evidence line on a call card: "Why call: …". */
  whyCall: "Why call:",

  /** The chips under a draft. */
  emailFound: "Email found",
  noEmailYet: "No email yet",
  fitLabel: "Fit:",
  fit: {
    strong: "strong",
    fair: "fair",
    weak: "weak",
  },
  sends: "Sends",

  /** The draft's three actions. */
  approve: "Approve",
  edit: "Edit",
  editDone: "Done",
  reject: "Reject…",
  /** The accessible name of the body while it is being edited. */
  bodyField: "The email",
  /** A call draft's talking point, when the draft is for a call rather than an email. */
  openWith: "Open with",
  thenAsk: "Then ask",
  listenFor: "Listen for",

  /** Above the four reasons once Reject is pressed. */
  rejectWhy: "Why?",
  rejectReason: {
    wrong_angle: "Wrong angle",
    wrong_person: "Wrong person",
    wrong_fact: "Wrong fact",
    not_now: "Not now",
  },
  /** What each reason does, said before it is chosen and again once it is. */
  rejectConsequence: {
    wrong_angle: "Relay redrafts on another problem.",
    wrong_person: "Closes this person's emails.",
    wrong_fact: "Relay redrafts on the role problem instead.",
    not_now: "Leaves this person for now.",
  },

  /** After Approve: "Approved. Sends Thu 09:00." */
  approved: "Approved.",

  /** The reply card. */
  repliedAt: "replied",
  /** The collapsed line under their message: "Your email, sent Tue 09:00". */
  yourEmail: "Your email, sent",
  labelThis: "Label this reply",
  replyLabel: {
    warm: "Warm",
    later: "Later",
    no: "No",
    stop: "Stop",
  },
  /** After a label: "Labelled warm." */
  labelled: "Labelled",
  replyFromMailbox: "Reply from your mailbox",

  /** The call card. */
  logOutcome: "Log the outcome",
  callOutcome: {
    spoke: "Spoke",
    voicemail: "Voicemail",
    no_answer: "No answer",
    wrong_number: "Wrong number",
  },
  /** The one line Spoke asks for. */
  notesLabel: "What was said",
  notesPlaceholder: "One line on what was said",
  notesDone: "Log it",
  /** After an outcome: "Logged: spoke." */
  logged: "Logged:",

  /**
   * The empty state (§23.1b): "All clear. Replies land here as they arrive."
   * The signed line also said when the next drafts land; that comes back
   * when a schedule exists to read it from, and not as a fixed weekday.
   */
  emptyHeading: "All clear",
  repliesLand: "Replies land here as they arrive.",
} as const;
