/**
 * Campaigns: the list, Start, and the campaign page (master doc §23.1c and
 * §23.1d, as drawn in sections 3a to 3d of the signed mock).
 *
 * Every string a rep reads on those three screens is here, and nothing here is
 * a function: `tests/lib/copy.test.ts` sweeps this file for machine words and
 * for a template function whose strings would hide in a closure. Numbers are
 * interpolated at the call site, which is why the fragments below read as
 * halves of sentences.
 *
 * Two deliberate departures from the mock's own wording, both because the
 * plain-words rule (§22.4) outranks the drawing:
 *
 * - the mock's "2 archetypes" reads "2 groups" here, because `archetype` is on
 *   the banned list and a rep does not have archetypes;
 * - the mock's fourth confidence word is "a guess", which is what the schema's
 *   `speculative` renders as. The schema keeps its word; the screen never
 *   shows it.
 */
export const campaignsCopy = {
  /**
   * What Home's brief box's Start comes back with. Kept from day one: the
   * router that returns it is still the Campaigns router, and Start (§23.1d)
   * is a page the rep navigates to rather than something that box became.
   */
  next: "Campaigns arrive next",

  title: "Campaigns",
  newCampaign: "New campaign",
  /** The page-header note, assembled with the two counts: "2 running · 1 done". */
  noteRunning: "running",
  noteDone: "done",
  noteJoin: " · ",

  /** The list row (mock 3a). */
  of: "of",
  contacted: "contacted",
  nextPrefix: "Next:",

  /**
   * The row's "next" line, which is the same sentence as the page's action
   * (§23.1c). One per state, so a state added later has nowhere to hide.
   */
  nextResearching: "reading around the brief",
  nextStopped: "widen the brief",
  nextPlanReady: "confirm the plan",
  nextFindingPeople: "pick your people",
  nextDrafting: "first drafts on the way",
  nextRunningDrafts: "drafts due today",
  nextRunningQuiet: "nothing due today",
  nextPaused: "resume when you are ready",
  doneWarm: "warm",
  doneMeetings: "meetings",

  /** The state chip, one word of state (mock 3a). */
  chipResearching: "Researching",
  chipStopped: "Stopped",
  chipPlanReady: "Plan ready",
  chipFindingPeople: "Finding people",
  chipDrafting: "Drafting",
  chipRunning: "Running",
  chipPaused: "Paused",
  chipDone: "Done",

  /** The steps row across the top of the campaign page (mock 3b). */
  stepBrief: "Brief",
  stepResearching: "Researching",
  stepStopped: "Researching · stopped",
  stepPlanReady: "Plan ready",
  stepFindingPeople: "Finding people",
  stepDrafting: "Drafting",
  stepRunning: "Running",
  stepDone: "Done",
  stepsLabel: "Where this campaign is",

  /** The one action, matching the state (§23.1c). */
  actionConfirm: "Confirm plan",
  actionPause: "Pause",
  actionResume: "Resume",
  actionWiden: "Widen the brief",

  /** Researching: a line, and no spinner (§23.1c). */
  researchingNote: "Reading around the brief now. Back in about ten minutes.",

  /** The brief card (mock 3b), five fields read only. */
  briefLabel: "The brief",
  fieldProduct: "Product",
  fieldMotion: "Motion",
  fieldWho: "Who",
  fieldHowMany: "How many",
  fieldChannels: "Channels",
  over: "over",
  changeSomething: "Change something…",
  changeFromCard: "Change something about this…",

  /** The reason dialog behind "Change something" (§23.1c: it asks a reason). */
  changeTitle: "What should change?",
  changeHint: "Pick a reason. Relay reads around the brief again and writes a new plan.",
  changeReasonWho: "Wrong people",
  changeReasonPain: "Wrong pain",
  changeReasonRegion: "Wrong region",
  changeReasonSize: "Wrong size of firm",
  changeReasonOther: "Something else",
  changeNoteLabel: "Anything to add",
  changeNotePlaceholder: "Optional. Kept word for word.",
  changeSubmit: "Ask for new research",
  changeCancel: "Cancel",

  /** Ask Relay: six chips, no free text (§23.1c, orchestrator §8). */
  askLabel: "Ask Relay",
  askHint: "Six questions, answered from what Relay already knows.",
  askHowGoing: "How is this campaign going?",
  askWaiting: "What is waiting on me?",
  askReplies: "How many have replied, and how?",
  askNextBatch: "When does the next batch go?",
  askCost: "What has this cost?",
  askWhyStopped: "Why is this paused or stopped?",

  /** The six answers, assembled from the campaign's own counts. */
  answerSent: "sent",
  answerReplied: "replied",
  answerDrafted: "drafted",
  answerFound: "found",
  answerNothingYet: "Nothing has gone out yet.",
  answerWaitingConfirm: "You. Confirm the plan and Relay finds your people.",
  answerWaitingWiden: "You. Widen the brief and Relay reads around it again.",
  answerWaitingDrafts: "drafts due today in Inbox.",
  answerWaitingNothing: "Nothing right now.",
  answerRepliesNone: "Nobody has replied yet.",
  answerRepliesLead: "replied.",
  answerRepliesWarm: "warm",
  answerRepliesMeetings: "meetings",
  answerBatchLead: "Next batch goes",
  answerBatchAt: "at",
  answerBatchNone: "Nothing is scheduled until you confirm the plan.",
  answerCostUsed: "credits used,",
  answerCostLeft: "left.",
  answerCostNothing: "Nothing has been spent on this campaign.",
  answerStoppedNone: "Nothing is paused or stopped.",
  answerPaused: "You paused it. Resume puts the queue and the schedule back.",
  answerStopped: "Relay stopped: not enough evidence to write a plan. Widen the brief and it looks again.",

  /** The plan section, which is the research surface (§23.1c). */
  planLabel: "The plan, and the research behind it",
  planShow: "show",
  planHide: "hide",
  cardWho: "Who we found",
  cardHook: "The hook",
  cardPain: "Their pain, in their words",
  cardFirms: "Seed firms and who to target",
  cardUnknowns: "What Relay could not find",
  whyNow: "Why now:",
  sayThis: "Say",
  notThis: "Never",
  fromSources: "sources",
  countGroup: "group",
  countGroups: "groups",
  countFirm: "firm",
  countFirms: "firms",
  countSource: "source",
  countUnknown: "unknown",
  countUnknowns: "unknowns",
  countWhyNow: "reason it is now",
  cardContradictions: "Where sources disagree",
  recipeSize: "Staff, between",
  recipeAnd: "and",
  recipeWhere: "Where",
  recipeIndustry: "Industry",
  recipeTriggers: "What to watch for",
  /**
   * The countries the recipe can name, spelled out.
   *
   * The recipe carries ISO codes because that is the vocabulary lead gen is
   * handed (§3, `recipeSchema`), and "GB" is not a word a rep uses. A code with
   * no spelling here is shown as itself rather than hidden.
   */
  countries: { GB: "United Kingdom", IE: "Ireland", US: "United States" },
  nothingGuessed: "nothing is guessed here",
  shownOf: "shown",
  triedLabel: "Looked for:",
  kindNotFound: "Looked and found nothing",
  kindConfirmedAbsent: "Checked, and it is not there",
  kindUnreadable: "Found it, could not read it",
  kindConflicting: "Sources disagree",
  kindOutOfBudget: "Not looked into: out of time",
  noSource: "No source. Relay inferred this.",
  noSourceFrom: "No source. Relay inferred this from",

  /** The four confidence words a rep sees. Never a number (§23.1c). */
  confidenceStrong: "strong",
  confidenceModerate: "moderate",
  confidenceWeak: "weak",
  confidenceGuess: "a guess",

  /** The plan's own facts, under the cards (mock 3b). */
  planPeople: "People",
  planCredits: "Credits",
  planSending: "Sending",
  planLawful: "Lawful basis",
  peopleFrom: "from",
  peopleCompanies: "companies",
  peoplePerCompany: "3 per company at most",
  creditsReveals: "reveals, about",
  creditsLeft: "of your",
  creditsLeftTail: "left",
  sendingADay: "a day,",
  sendingTo: "to",
  sendingFrom: "from",
  lawfulBasis: "Legitimate interest recorded at confirm: B2B offer, opt out in every email",

  /** Progress: counts only (§23.1c). */
  progressLabel: "Progress",
  progressFound: "found",
  progressDrafted: "drafted",
  progressApproved: "approved",
  progressSent: "sent",
  progressReplied: "replied",

  /** The People card on the rail. */
  peopleLabel: "People",
  peopleChosen: "Chosen",
  peopleOnHold: "On hold",
  peopleLink: "Your people",
  peopleBeforeConfirm:
    "Chosen after you confirm. You pick from the ranked list before any credit is spent.",

  /** The insufficient-evidence stop (§23.1c, mock 3c). */
  stopBanner: "Not enough evidence to write a plan. Nothing has been spent.",
  stopFound: "What it did find",
  stopHelp: "What would help",
  stopChooseOne: "Choose one, and Relay looks again",
  widenRegion: "Widen the region",
  widenSize: "Widen the size",
  widenSector: "Widen the kind of organisation",
  widenRole: "Widen the roles",

  /** Nothing on these pages sends or spends (§23.1c, last line). */
  toastConfirmed: "Nothing was bought or sent. These campaigns are samples while the real ones are built.",
  toastStarted: "Nothing was bought or sent. This is a sample campaign while the real ones are built.",
} as const;

/** Start (§23.1d), as drawn in section 3d of the signed mock. */
export const startCopy = {
  title: "New campaign",
  note: "step 2 of 2",
  question: "Who do you want to reach, and why now?",
  placeholder: "Managed print dealers in the Midlands who resell service contracts",
  edit: "Edit",
  readIt: "Read it",
  understood: "Here is what Relay understood. Fix anything, then start the research.",

  fieldProduct: "Product",
  fieldMotion: "Motion",
  fieldWho: "Who",
  fieldRegion: "Region",
  fieldHowManyHowLong: "How many, over how long",
  fieldChannels: "Channels",

  factsUpdated: "Facts updated",
  factsVersion: "version",
  factsMore: "More products as the knowledge base grows.",
  guessedHint: "Not in your sentence, so these are the suggested defaults.",
  channelsHint:
    "Email is always on. Calls adds one day 3 call to each sequence; turn it off if you will not phone.",

  motionDirect: "Direct",
  motionChannel: "Channel",
  people: "people",
  weeks: "weeks",
  channelEmail: "Email",
  channelLinkedin: "LinkedIn",
  channelCalls: "Calls",

  start: "Start research",
  startNote: "About ten minutes. Nothing is bought or sent until you confirm the plan.",
  connectFirst: "Connect your mailbox first",
  connectLink: "Settings",
} as const;
