/**
 * The Inbox, in a rep's words (master doc §23.1b; the signed mock, sections
 * 2, 2a, 2b, 2c).
 *
 * One queue, three kinds of card, and one job per card. Every string a rep
 * reads on the page is here and nowhere else, so the sweep in
 * `tests/lib/copy.test.ts` holds all of it to the rep-words rule (§22.4).
 *
 * Interpolation happens at the call site, never here: the sweep refuses a
 * function, so the pieces of "2 replies · 1 call · 3 drafts" and "Next drafts
 * Thursday 09:00" are separate words and the components assemble them.
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
export const NEEDS_YOU_REASONS = ["voice", "fact"] as const;
export type NeedsYouReason = (typeof NEEDS_YOU_REASONS)[number];

/** How well a person fits, as a word and never a number (§21 rule 2). */
export const FIT_WORDS = ["strong", "fair", "weak"] as const;
export type FitWord = (typeof FIT_WORDS)[number];

export const inboxCopy = {
  title: "Inbox",

  /** The pieces of the header note: "2 replies · 1 call · 3 drafts". */
  reply: "reply",
  replies: "replies",
  call: "call",
  calls: "calls",
  draft: "draft",
  drafts: "drafts",
  /** Between the counts. */
  countJoin: " · ",
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
  /** The warn chip on a draft that needs the rep. */
  needsYou: "needs you",

  /** The row's context line for a draft that needs the rep: "Needs you · voice check failed twice". */
  needsYouLead: "Needs you",
  needsYouReason: {
    voice: "voice check failed twice",
    fact: "a fact did not check out",
  },
  /** Above the body on a draft that needs the rep. */
  needsYouCard: "Read this one before it goes.",

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
    wrong_angle: "Relay redrafts on another pain.",
    wrong_person: "Closes this person's remaining emails and calls.",
    wrong_fact: "Marks the fact bad and redrafts on what firms like theirs share.",
    not_now: "Snoozes them for 14 days.",
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

  /** The empty state (§23.1b): "All clear. Next drafts Thursday 09:00. Replies land here as they arrive." */
  emptyHeading: "All clear",
  nextDrafts: "Next drafts",
  repliesLand: "Replies land here as they arrive.",
} as const;
