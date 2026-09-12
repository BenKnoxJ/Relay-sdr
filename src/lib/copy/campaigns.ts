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
  /** A real plan, before Confirm can be pressed. */
  nextPlanReadyLive: "read the plan",
  nextFailed: "research needs you",
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
  chipNeedsYou: "Needs you",
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
  stepNeedsYou: "Researching · needs you",
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
  /** Research that failed runs again, on the same brief (orchestrator A1, item 6). */
  actionTryAgain: "Try again",
  actionTrying: "Trying again",

  /** Researching: a line, and no spinner (§23.1c; research v3 runs 20 to 45 minutes). */
  researchingNote: "Reading around the brief now. This usually takes 20 to 45 minutes.",

  /**
   * Research that did not finish (orchestrator §7, amended A1). One line of
   * reason, never the error itself, and never "needs you" on its own.
   */
  failedTookTooLong: "Relay's research took longer than it should and stopped before it finished.",
  failedBadOutput: "Relay's research came back in a shape it could not use.",
  failedOther: "Relay's research did not finish.",
  failedNotStarted: "Relay's research has not started.",
  failedNothingSpent: "Nothing was bought or sent.",
  /** What the rep can do about it: Try again when the research itself failed, and Edit brief always. */
  failedNextRetry: "Try again, or edit the brief.",
  failedNextEdit: "Edit the brief, and Relay looks again.",

  /** Confirm plan is drawn and cannot be pressed until finding people exists. */
  confirmLater: "Finding people comes next. Nothing will be bought or sent yet.",

  /** The brief card (mock 3b), five fields read only. */
  briefLabel: "The brief",
  fieldProduct: "Product",
  fieldMotion: "Motion",
  fieldWho: "Who",
  fieldHowMany: "How many",
  fieldChannels: "Channels",
  /** Who exactly, on the brief card: each row only when the rep set it. */
  fieldWhere: "Where",
  fieldOrgTypes: "Kinds of organisation",
  fieldSize: "Size",
  fieldRolesInclude: "Roles to reach",
  fieldRolesExclude: "Roles to leave out",
  fieldCustomers: "Customers like this",
  alsoCalled: "also",
  sizeAtLeast: "at least",
  sizeAtMost: "at most",
  sizeTo: "to",
  sizeUnits: { employees: "people employed", seats: "seats", sites: "sites" },
  over: "over",
  /** Opens Start on the current brief (orchestrator A1, item 5: Edit brief replaces the reason picker). */
  editBrief: "Edit brief",

  /** Why a change to a campaign was refused. Each is a line a rep can act on. */
  changedSince: "This campaign changed after the page was opened. Reload it to see where it is now.",
  cannotChange: "Relay could not make that change. Reload the page and try again.",
  briefUnchanged: "Nothing in the brief has changed.",

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
  answerNothingFound: "No people have been found yet, and nothing has been sent.",
  answerWaitingConfirm: "You. Confirm the plan and Relay finds your people.",
  answerWaitingWiden: "You. Widen the brief and Relay reads around it again.",
  answerWaitingPlanLive: "Nothing yet. Read the plan first. Finding people comes next.",
  answerWaitingFailed: "You. Try again, or edit the brief. The reason is at the top of the page.",
  answerWaitingFailedEdit: "You. Edit the brief, and Relay looks again. The reason is at the top of the page.",
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
  answerCostNoCredits: "No credits have been spent on this campaign.",
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

  /** The hook and the targeting are for one kind of buyer; this says which. */
  forGroup: "For:",

  /**
   * A partial plan (research outcome `partial`): a limit ended the run, and
   * the page says which parts are missing rather than drawing them empty.
   */
  planPartial: "Relay ran out of time before it finished. What is shown was found; these parts are missing:",
  /**
   * The parts of the research, in a rep's words, for the partial line. Keyed
   * by the pack's own part names, which never reach a screen.
   */
  partNames: {
    m00: "the brief Relay understood",
    repSummary: "the short summary",
    execSummary: "the full summary",
    m01: "the market and firms",
    m02: "competitors",
    m03: "the kinds of buyer",
    m04: "who to target first",
    m05: "their pains",
    m06: "their own words",
    m07: "how the product helps",
    m08: "good fit and poor fit",
    m09: "what to say",
    m10: "where they gather",
    m11: "objections and answers",
    m12: "contacting rules",
    m13: "dates and deadlines",
    m14: "what changed",
    m15: "proof you can use",
    m16: "campaign ideas",
    m17: "where sources disagree",
    m18: "what Relay couldn't find",
    m19: "the sources",
  },

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
  /** Progress before anyone has been found: words, not five zeros that read like work done. */
  progressNone: "No people have been found yet. Nothing has been sent.",
  /** The list row's count before anyone has been contacted. */
  nothingSentYet: "Nothing sent yet",

  /** The insufficient-evidence stop (§23.1c, mock 3c). */
  stopBanner: "Not enough evidence to write a plan. Nothing has been spent.",
  stopFound: "What it did find",
  stopHelp: "What would help",
  stopChooseOne: "Choose one, and Relay looks again",
  widenRegion: "Widen the region",
  widenSize: "Widen the size",
  widenSector: "Widen the kind of organisation",
  widenRole: "Widen the roles",
  /** Two options that widen the same thing: "Widen the region · option 2". Research's own text is never changed. */
  widenOption: "option",
  /** What the brief would read after an option: "Where becomes United Kingdom". */
  widenBecomes: "becomes",
  /**
   * A constraint an option takes off, or one the rep never set. An absent
   * constraint is exactly that: Relay puts nothing in its place.
   */
  sizeLimitRemoved: "Size limit removed",
  sizeLimitNone: "No size limit set",
  orgTypesLimitRemoved: "Kinds of organisation limit removed",
  orgTypesLimitNone: "No kinds of organisation set",
  rolesIncludeLimitRemoved: "Roles to reach limit removed",
  rolesIncludeLimitNone: "No roles to reach set",
  rolesExcludeLimitRemoved: "Roles to leave out limit removed",
  rolesExcludeLimitNone: "No roles to leave out set",
  widenUnusable: "This option no longer fits the brief, so it cannot be chosen.",
  widenSubmit: "Look again with this",
  widenSubmitting: "Asking",

  /** Nothing on these pages sends or spends (§23.1c, last line). */
  toastConfirmed: "Nothing was bought or sent. These campaigns are samples while the real ones are built.",
  toastStarted: "Research has started. Nothing was bought or sent.",
  /** After a widening, an edit or Try again. */
  toastLookingAgain: "Relay is looking again. Nothing was bought or sent.",
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

  /** Who exactly (research v3.2 scope): each only when the rep adds it. */
  fieldWhoExactly: "Who exactly",
  whoExactlyHint: "Only what you add here limits the research. Leave the rest to Relay.",
  fieldAlsoInclude: "Also include",
  fieldPlaces: "Places",
  placePlaceholder: "Orkney",
  aliasesLabel: "Also called",
  aliasesPlaceholder: "Other names, separated by commas",
  fieldOrgTypes: "Kinds of organisation",
  orgTypePlaceholder: "veterinary practice",
  fieldSize: "Size",
  sizeUnitLabel: "Counted in",
  sizeFrom: "From",
  sizeTo: "To",
  sizeBackwards: "The first size is bigger than the second.",
  fieldRolesInclude: "Roles to reach",
  fieldRolesExclude: "Roles to leave out",
  rolePlaceholder: "practice manager",
  add: "Add",
  remove: "Remove",
  /** The mark on a chip's remove button; the button's name is `remove` and the term. */
  removeMark: "×",
  fieldCustomers: "Do you already have customers like this? Who, and what did they buy it for?",
  customersHint: "Optional. Relay looks for more like them and never names them.",

  start: "Start research",
  starting: "Starting",
  startNote: "Usually 20 to 45 minutes. Nothing is bought or sent until you confirm the plan.",
  cannotStart: "Relay could not start this campaign. Check the brief and try again.",

  /** Edit brief: the same card, on the brief research last read (orchestrator A1, item 5). */
  editTitle: "Edit brief",
  editIntro: "This is the brief Relay last read around. Change what you need, then look again.",
  editSubmit: "Look again with this brief",
  editSubmitting: "Asking",
  editNote: "Usually 20 to 45 minutes. Nothing is bought or sent.",
  editCancel: "Cancel",
  connectFirst: "Connect your mailbox first",
  connectLink: "Settings",
} as const;
