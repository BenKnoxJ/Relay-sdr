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
  /** Research finished, but no play it ranked has a search Relay can run: there is nothing to confirm. */
  failedNoPlay: "Relay's research finished, but none of the campaigns it ranked says who to search for. Edit the brief and Relay looks again.",
  failedNothingSpent: "Nothing was bought or sent.",
  /** What the rep can do about it: Try again when the research itself failed, and Edit brief always. */
  failedNextRetry: "Try again, or edit the brief.",
  failedNextEdit: "Edit the brief, and Relay looks again.",

  /**
   * Confirm plan is drawn and cannot be pressed until finding people exists.
   * Lead gen v2.1 §6: confirming allows a capped search, which is spend; emails are a second approval.
   */
  confirmLater:
    "Finding people comes next. Confirming will start a search that uses credits, up to a limit you approve. Emails are only bought when you reveal them.",

  /**
   * Confirm plan and finding people (lead gen v2.1 §6, §11, §12). Confirm is
   * the first spend gate: a search capped at the limit shown. Reveal emails is
   * the second, drawn and not yet pressable.
   */
  confirmNote: "Confirming starts a search that uses credits, up to the limit below. Emails are only bought when you reveal them.",
  actionConfirming: "Confirming",
  confirmLabel: "Confirming the plan",
  confirmFor: "Finds people in",
  confirmSearch: "Search up to",
  confirmCredits: "credits",
  confirmSample: "Sample people and sample credits: this environment has no live people provider.",
  confirmLawful: "Lawful basis you confirm",
  confirmNotAvailable: "Finding people isn't switched on here yet.",
  confirmNoGroup: "Research didn't rank a kind of buyer to start with. Edit the brief and Relay looks again.",
  confirmNoRecipe: "Research didn't say who to search for in the kind of buyer it ranks first. Edit the brief and Relay looks again.",
  /** The play the rep chose is not one this plan ranks any more (lead gen v2.3). */
  confirmUnknownPlay: "That campaign is no longer in this plan. Reload the page and choose again.",
  confirmOverCap: "The search limit is more than the credits available.",
  /** Confirm could not read the credit balance, so nothing was started (lead gen v2.1 §6). */
  confirmBalanceUnavailable: "Relay couldn't read the credit balance, so nothing has started. Try again in a minute.",
  findingNote: "Relay is finding people now. Nothing is revealed or sent.",
  chipPeopleFound: "Reviewing people",
  nextFindingPeopleLive: "finding people now",
  nextPeopleFound: "review the accounts found",
  nextPeopleNeedsYou: "finding people needs you",
  stepFindingNeedsYou: "Finding people · needs you",
  actionReveal: "Reveal emails",
  revealLater: "Revealing emails comes next. Nothing has been bought yet.",
  peopleFoundLabel: "Reviewing people",
  peopleFoundOf: "of",
  peopleFoundFor: "For",
  shortfallCapReached: "The search reached the credit limit you approved before it found everyone.",
  shortfallNoMore: "The search ran out of people who fit the plan.",
  peopleReusedChip: "Already known",
  peopleHeldBack: "held back by your rules.",
  spendUsed: "Search used",
  spendOf: "of",
  spendCredits: "credits.",
  spendHeld: "more are held until the charge is confirmed.",
  spendSample: "Sample credits, not a live balance.",
  revealAbout: "Revealing their emails would use about",
  revealCredits: "credits.",
  revealReused: "already known cost nothing.",
  editWarning: "Changing the brief discards this selection. Credits already spent stay on the record, and another search may spend more.",
  /** Lead gen v2.2 §9a: Reviewing people, accounts first, keep or drop before Reveal. */
  stepReviewingPeople: "Reviewing people",
  shortfallFewerStrong: "Relay stopped at the accounts and roles that fit well, rather than add weaker matches.",
  accountsPeopleAt: "people at",
  accountsWord: "accounts",
  accountsMultiRole: "with more than one role",
  accountPeople: "people",
  accountPerson: "person",
  accountFitSearch: "Matches the plan's search:",
  accountFitSeed: "Research named this firm for the plan.",
  /** v2.2 note 3: one short line per person; the role's needs are shown once, per role. */
  whyRole: {
    runs: "Matches the Runs it role in the campaign plan.",
    champions: "Matches the Champions it role in the campaign plan.",
    signs: "Matches the Signs it off role in the campaign plan.",
  },
  whyRelated: "Title is close to the plan's search, but is not one of its buyer roles.",
  buyerRolesLabel: "Buyer roles in this plan",
  buyerRolesNeeds: "What each role needs",
  accountEmployees: "employees",
  accountOrMore: "or more",
  accountSizeTo: "to",
  relatedRole: "Related role",
  reviewKeep: "Keep",
  reviewDrop: "Drop",
  reviewDropAccount: "Drop account",
  reviewKept: "Kept",
  reviewDropped: "Dropped",
  reviewPending: "To review",
  reviewCountKept: "kept",
  reviewCountDropped: "dropped",
  reviewCountPending: "to review",
  revealKeptAbout: "Revealing the emails of the people you keep would use up to",
  revealNoneKept: "Nobody is kept yet. Emails are only revealed for the people you keep.",
  overviewFolded: "The plan and the research behind these accounts.",
  overviewShowPlan: "Show the plan",
  haltNoCandidates: "Relay found nobody who fits the plan within the credit limit.",
  haltUnmappable: "Relay couldn't search for this without widening the plan:",
  haltWouldWiden: "Relay couldn't search the size range without widening it.",
  haltChooseIndustry: "Relay couldn't match this kind of organisation exactly:",
  haltChooseHint: "Choose the closest, and Relay searches with it. Nothing else changes.",
  haltOverCap: "One search would cost more than the credit limit allows.",
  haltBalance: "Relay couldn't read the credit balance.",
  haltBusy: "The people search service was busy.",
  haltTooLong: "The search took longer than it should.",
  haltFailed: "Finding people didn't finish.",
  haltNextRetry: "Try again, or edit the brief.",
  haltNextEdit: "Edit the brief, and Relay looks again.",
  actionSearchWith: "Search with this",
  actionSearching: "Searching",
  answerWaitingPeopleNeedsYou: "You. The reason is at the top of the page.",
  answerWaitingPeopleFound: "Nothing yet. Revealing emails comes next.",
  answerWaitingFinding: "Nothing. Relay is finding people.",
  /** Where Confirm plan lands the rep. */
  toastFinding: "Plan confirmed. Relay is finding people now. Nothing is revealed or sent.",

  /**
   * Reveal emails, the second spend approval (lead gen v2.1 §6, §11; v2.2
   * §9a): the people the rep kept, emails only, one explicit confirmation.
   */
  revealNote: "Only the people you keep. Nothing is bought until you confirm.",
  revealKeepFirst: "Keep the people you want to email first. Emails are only revealed for the people you keep.",
  revealNothingToReveal: "None of the people you kept has an email Relay can reveal. Keep someone else first.",
  revealCardLabel: "Reveal emails",
  revealRowKept: "People you kept",
  revealRowKnown: "Already known to Relay",
  revealRowToReveal: "To reveal",
  revealRowNoEmail: "No email to reveal",
  revealRowUnavailable: "Can't be contacted or revealed",
  revealNoCredits: "no credits",
  revealUpTo: "up to",
  revealCreditOne: "credit",
  revealCreditMany: "credits",
  revealFreeTail: "of these were revealed before and should cost nothing.",
  revealEmailsOnly: "Emails only. Phone numbers are never bought, and people you didn't keep are never revealed.",
  revealButtonReveal: "Reveal",
  revealButtonEmailOne: "email,",
  revealButtonEmailMany: "emails,",
  revealButtonAdd: "Add",
  revealButtonKnownOne: "known email,",
  revealButtonKnownMany: "known emails,",
  revealCancel: "Not now",
  actionRevealing: "Revealing",
  revealChanged: "The people you kept or the figures changed since this page opened. Check them again before revealing.",
  revealNothing: "There's nothing to reveal. Keep at least one person with an email first.",
  revealOverBalance: "Your organisation doesn't have enough credits left for this reveal.",
  revealNotAvailable: "Revealing emails isn't switched on here yet.",
  toastRevealing: "Reveal confirmed. Relay is revealing emails for the people you kept. Nothing is sent.",
  chipRevealing: "Revealing emails",
  chipPeopleReady: "People ready",
  stepRevealing: "Revealing emails",
  stepPeopleReady: "People ready",
  nextRevealing: "revealing emails now",
  nextPeopleReady: "emails ready, outreach comes next",
  revealingNote: "Relay is revealing emails for the people you kept. Nothing is sent.",
  revealStopped: "Revealing emails stopped before it finished. Nothing more will be bought for it.",
  /** A stopped reveal, by what Relay knows about its spend (product-truth foundation). */
  nextRevealNeedsYou: "revealing emails needs you",
  revealStoppedRetry: "Revealing emails stopped before any request reached the provider, so nothing was bought. Try again, or edit the brief.",
  revealStoppedHeld: "Revealing emails stopped after a request may have reached the provider. Its credits are held, and Relay won't buy these emails again on its own. Edit the brief to start again.",
  revealStoppedFailed: "Revealing emails stopped and can't be tried again as it is. Nothing more will be bought for it. Edit the brief to start again.",
  answerWaitingRevealStopped: "You. Revealing emails stopped; the reason is at the top of the page.",
  answerWaitingRevealing: "Nothing. Relay is revealing emails.",
  answerWaitingPeopleReady: "Nothing yet. Writing to these people comes next.",
  revealingLabel: "Revealing emails",
  peopleReadyLabel: "People ready",
  readyEmails: "with an email ready",
  readyWithout: "without a usable email",
  readyFailed: "couldn't be revealed",
  readyWithoutSummary: "Accounts with no usable email",
  revealUsed: "Revealing used",
  revealUsedOf: "of up to",
  notKept: "you didn't keep were not revealed.",
  revealChip: {
    revealed: "Revealed",
    known: "Already known",
    no_email: "No email found",
    suppressed: "Do not contact",
    held: "Not used",
    failed: "Couldn't reveal",
  },
  /** Why a kept person has no usable email, in the rep's words (lead gen v2.1 §7). */
  revealWhy: {
    no_email: "No email was found for this person.",
    opted_out: "Asked not to be contacted.",
    dnc: "On your do-not-contact list.",
    customer: "Already a customer in your CRM.",
    not_work_email: "Only a personal email was found, so Relay won't use it.",
    grade: "The email found is low confidence, so Relay won't use it.",
    duplicate_in_campaign: "Already in this campaign through another record.",
    wrong_person: "The details returned didn't match this person, so the email wasn't used.",
    invalid_id: "This person's record is no longer available.",
    provider_unusable: "This person's email can't be revealed.",
  },
  revealFailedWhy: "Relay couldn't confirm this reveal. It won't be bought again automatically.",
  actionWriteEmails: "Write emails",
  outreachLater: "Writing emails comes next. Nothing has been sent.",
  outreachNextLabel: "Next: outreach",
  outreachNextLine: "These people have emails ready. Writing to them comes next, and nothing is sent until you approve it.",
  reviewKeepAccount: "Keep account",

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
  /** The cost answer across every brief version, search and reveal apart (product-truth foundation). */
  answerCostSearch: "search credits used",
  answerCostReveal: "reveal credits used",
  answerCostAnd: "and",
  answerCostLeftUnder: "left under this search's limit.",
  answerCostHeld: "more held while Relay checks what was charged.",
  answerStoppedNone: "Nothing is paused or stopped.",
  answerPaused: "You paused it. Resume puts the queue and the schedule back.",
  answerStopped: "Relay stopped: not enough evidence to write a plan. Widen the brief and it looks again.",

  /** The plan section, which is the research surface (§23.1c). */
  planLabel: "The plan, and the research behind it",

  /**
   * The campaign Overview (task 18): research's findings in six parts, each a
   * lookup into the pack. Groups are kinds of buyer to aim at, and the firms
   * are research's examples: nobody has been found before the rep confirms.
   */
  inShortLabel: "In short",
  /** A scan label for each rep summary line, by place: who to reach, why now, what to open with, the biggest unknown, the size of it. */
  inShortLines: ["Who", "Why now", "Opening", "Biggest unknown", "Opportunity"],
  /** The Overview's disclosures open more of the same part in place. */
  overviewShow: "Show",
  overviewHide: "Hide",
  allPainsAndLanguage: "all pains and language",
  allQuestions: "all questions Relay recommends asking",
  inShortView: "Relay's view:",
  basedOn: "Based on",
  startWithLabel: "Start with",
  startAngle: "Lead with",
  startWhyNow: "Why now",
  startWrongIf: "Not the right call if",
  startChannels: "Suits",
  groupsLabel: "Buyer groups",
  groupsNote: "The kinds of organisation and role to aim at. Nobody has been found yet.",
  /** Once the plan is confirmed, the search may have found people: the note no longer says it has not. */
  groupsNoteConfirmed: "The kinds of organisation and role to aim at.",
  startHere: "Start here",
  groupSize: "Size:",
  groupSituation: "their situation",
  roleParts: { runs: "Runs it", champions: "Champions it", signs: "Signs it off" },
  painLabel: "Pains and buyer language",
  buyerWordsLabel: "In buyers' own words",
  otherVoicesLabel: "How the regulator and suppliers put it, not buyers",
  noBuyerWords: "Research found none of this group's own words.",
  firmsLabel: "Example firms",
  firmsNote: "Firms research found that fit each group. Examples, not your people: Relay finds those after you confirm.",
  firmsNoteConfirmed: "Firms research found that fit each group. Examples, not your people.",
  firmsWhy: "why they fit",
  sizeConfirmed: "confirmed",
  sizeEstimated: "estimated",
  sizeUnknown: "Size not known. Check before contacting.",
  checkFirstLabel: "Check first",
  checkFirstAsk: "Ask on the first call",
  allGapsLabel: "everything Relay couldn't settle",
  againstLabel: "What argues against it",
  whyItMatters: "Why it matters:",
  askOnCall: "Ask:",
  meaningLabel: "What it means:",
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
  /**
   * The lawful-basis text a rep confirms, shown on the Confirm card. Confirm
   * stores this exact text, with the rep, the time and the brief version, in
   * the `campaign.confirmed` Event (lead gen v2.1 §12). Not an LIA.
   */
  lawfulBasis: "Legitimate interest: B2B offer, opt out in every email",
  /** Lead gen v2.1 §12: the label for that stored record, never an LIA. No screen shows the record yet. */
  lawfulBasisConfirmed: "Lawful basis confirmed",
  /** The campaign's activity, newest first, from its Events: the pieces each line is built from. */
  activityCreated: "Campaign started",
  activityBriefEdited: "Brief edited, now version",
  activityBriefWidened: "Brief widened, now version",
  activityResearchRetried: "Research tried again",
  activityResearchComplete: "Research finished",
  activityResearchPartial: "Research finished with some parts unwritten",
  activityResearchStopped: "Research stopped: not enough evidence",
  activityConfirmed: "Plan confirmed for",
  activityConfirmedChosen: "Plan confirmed with a play you chose, for",
  activityFound: "Found",
  activityPeople: "people",
  activityPerson: "person",
  activityPeopleStopped: "Finding people stopped and needs you",
  activityPeopleRetried: "Finding people tried again",
  activitySearchChoice: "Searching again with",
  activityKept: "Kept",
  activityDropped: "Dropped",
  activityAtAccount: "at one account",
  activityRevealApproved: "Reveal approved for",
  activityEmails: "emails",
  activityUpTo: "up to",
  activityCredits: "credits",
  activityRevealed: "Emails revealed:",
  activityReady: "ready",
  activityCreditsUsed: "credits used",
  activityRevealRetried: "Revealing emails tried again",

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
  /** Lead gen v2.1 §6: the search after Confirm uses credits; emails are bought only on Reveal emails. */
  peopleBeforeConfirm:
    "Found after you confirm, by a search that uses credits up to the limit you approve. Emails are only bought when you reveal them.",
  /** After Confirm, before anyone is chosen: the search has been approved, so not "after you confirm". */
  peopleAfterConfirm: "Nobody is chosen yet. Emails are only bought when you reveal them.",
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

  /**
   * Hard limits (research v3.2 scope): boundaries research must not cross,
   * each only when the rep adds it. Research works out the rest itself.
   */
  limitsTitle: "Add hard limits (optional)",
  limitsHint:
    "Only use these for boundaries Relay must not cross. Research will work out the kinds of organisation, company sizes and roles worth targeting.",
  limitsNone: "No hard limits. Research can explore within your brief.",
  /** The closed section's summary: "Limits: Orkney · veterinary practice · 50 to 250 people employed". */
  limitsLead: "Limits:",
  limitsNever: "never",
  limitsShow: "Show",
  limitsHide: "Hide",
  fieldAlsoInclude: "Also search in",
  fieldPlaces: "Only these places",
  aliasesLabel: "Also called",
  aliasesPlaceholder: "Other names, separated by commas",
  fieldOrgTypes: "Only these kinds of organisation",
  fieldSize: "Only this size",
  sizeUnitLabel: "Counted in",
  sizeFrom: "From",
  sizeTo: "To",
  sizeBackwards: "The first size is bigger than the second.",
  fieldRolesInclude: "Only these roles",
  fieldRolesExclude: "Never these roles",
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
