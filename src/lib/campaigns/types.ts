import type { Confidence, Item, Phrase, PlanCards } from "../../../agents/research/output.schema";

import type { CampaignState } from "./state";
import type { ResearchContradiction, ResearchGap, SeedFirm, Voice } from "./packSelectors";

/**
 * The shapes the campaign screens are drawn from.
 *
 * Types only, and imported as types: the campaign page and Start are client
 * components, and a value import from here would pull zod and the research
 * contract into the browser. The server builds these (`view.ts`); the
 * components take them as props and know nothing about where they came from.
 */

export type Channel = "email" | "linkedin" | "calls";
export type Motion = "direct" | "channel";
export type SizeUnit = "employees" | "seats" | "sites";
export type Place = { name: string; aliases: string[] };

/**
 * Who exactly: the scope research is held to (research v3.2, note 28).
 *
 * Only what the rep adds is a constraint. An empty list, or a null size, is
 * the rep leaving it to Relay's judgement, and it never reaches `brief.scope`.
 */
export type BriefScope = {
  /** Countries beyond `region` that the rep added. Empty means the region alone. */
  extraCountries: string[];
  places: Place[];
  orgTypes: string[];
  /** Null unless the rep set a size. */
  size: { unit: SizeUnit; min?: number; max?: number } | null;
  rolesInclude: string[];
  rolesExclude: string[];
};

export type BriefFields = {
  product: string;
  motion: Motion;
  /** The rep's own words, kept unchanged. */
  who: string;
  /** The one primary country, as the ISO code research reads. Shown by name. */
  region: string;
  howMany: number;
  weeks: number;
  channels: Channel[];
  scope: BriefScope;
  /** "Do you already have customers like this?" Empty when the rep left it. */
  existingCustomers: string;
};

/** What the campaign page draws from research: the plan-card view, and on a stop the items the stop cites. */
export type CampaignPack = PlanCards & { stopEvidence?: Item[] };

/**
 * The campaign Overview (task 18): research's own findings in the six parts a
 * rep decides on, read from the stored pack by `overview.ts` through the
 * shared selectors in `packSelectors.ts`. Nothing in it is reworded.
 */
export type CampaignOverview = {
  /** The rep summary's five lines, each its own statement, and research's view of whether the market is worth it. */
  inShort: { lines: string[]; verdict: string | null };
  /** The sources the research rests on (m19). */
  sources: number;
  /** The campaign research ranks first (m16, rank 1), with its own dated reason and when it is the wrong call. */
  startWith: { groupName: string; angle: string; whyNow: string; wrongIf: string; channels: string[] } | null;
  /** The kinds of buyer (m03), ranked as research ranks the campaigns. Targets to aim at, not people found. */
  groups: {
    id: string;
    name: string;
    situation: string;
    sizeRange: string;
    roles: { part: "signs" | "champions" | "runs"; title: string }[];
    first: boolean;
  }[];
  /** The rank-1 group's pains (m05, most acute first), its buyers' own words (m06), and anyone else's words kept apart. */
  pain: { groupName: string; pains: Item[]; buyerWords: Phrase[]; otherVoices: Phrase[] } | null;
  /** Research's example firms (m04), each with the group it was found for and its size as research knows it. */
  firms: { groupName: string; firms: SeedFirm[] }[];
  /** The biggest unknown, the three questions to settle first (m18), and the rest research recommends asking. */
  checkFirst: {
    summary: string | null;
    questions: { id: string; question: string; whyItMatters: string }[];
    more: { id: string; question: string; whyItMatters: string }[];
  };
  /** Every gap and everything that argues against the case, whole, for the research view to come. */
  gaps: ResearchGap[];
  contradictions: ResearchContradiction[];
  /** The parts a limit left unwritten, by the pack's own names (shown in a rep's words). */
  partial: string[];
};

/**
 * "What Relay learned" (task 19): the whole of a finished pack, read into the
 * eleven parts a rep reads it in, by `research.ts` through the same shared
 * selectors as the Overview. Nothing in it is reworded. Internal names (a
 * part's own id, a fact id) are the only thing taken out of research's text.
 */
export type ResearchPart = "market" | "who" | "pains" | "say" | "prove" | "competition" | "companies" | "gather" | "contact" | "gaps" | "sources";

/** A pain as another part points at it: the group's place in the ranked list, and the pain's place in its group's list, both from 1. */
export type PainRef = { group: number; pain: number };

/** One moment on the market's timeline: a dated event (m13), or a dated trigger (m01) on a day no event covers. */
export type TimelineEntry =
  | { kind: "event"; key: string; date: string; what: string; why: string; source: string; alsoReported: Item[]; comingUp: boolean | null }
  | { kind: "trigger"; key: string; date: string | null; item: Item; comingUp: boolean | null };

export type ResearchAngle = { key: string; text: string; channels: string[]; confidence: Confidence | null; lead: boolean };

export type GapGroupKind = "ask" | "conflict" | "careful" | "verify" | "unreadable";
export type ResearchFinding = { kind: "gap"; gap: ResearchGap } | { kind: "contradiction"; contradiction: ResearchContradiction };

export type CampaignResearch = {
  sources: number;
  /** The day research read its sources, `YYYY-MM-DD`. */
  researchedOn: string | null;
  /** The parts a limit left unwritten, pack-wide, by the pack's own names (shown in a rep's words). */
  partial: string[];
  /** For each part of the page, which of the pack's parts it draws on were not written. */
  unwritten: Record<ResearchPart, string[]>;
  market: {
    theCase: string | null;
    timeline: TimelineEntry[];
    alsoExpected: string[];
    segments: { key: string; name: string; fit: "HIGH" | "MEDIUM" | "LOW" | "OUT"; why: string; sizeRange?: string; countEstimate?: string }[];
    size: string[];
    measures: string[];
    bodies: { key: string; name: string; role: string; relevance: string; url?: string }[];
  };
  who: {
    intro: string | null;
    groups: {
      key: string;
      name: string;
      rank: number | null;
      situation: string;
      sizeRange: string;
      dominantPain: Item;
      roles: { part: "signs" | "champions" | "runs"; title: string; seniority: string; needs: string }[];
      whyNow: string | null;
      wrongIf: string | null;
      deal: { seatRange?: string; plan?: string; yearOneValue?: string; salesCycle?: string; budgetLine?: string; confidence: Confidence; note?: string };
    }[];
    idealCompany: string[];
    idealBuyer: string[];
    disqualifiers: { who: string; why: string }[];
    boundaries: { geography: string[]; size: string | null; sectorsIn: string[]; sectorsOut: string[]; firmsOut: string[]; other: string[] } | null;
    /** Boundaries research echoed for one group that are not already a boundary or a don't-claim, by group place. */
    groupBoundaries: { group: number; lines: string[] }[];
  };
  pains: {
    groups: { key: string; name: string; pains: Item[]; buyerWords: Phrase[]; otherVoices: { voice: Voice; phrase: Phrase }[] }[];
  };
  say: {
    intro: string | null;
    groups: { key: string; name: string; angles: ResearchAngle[]; doDont: { use: string; avoid: string; why?: string }[]; verbatim: Item[]; vocabulary: string[] }[];
  };
  prove: {
    groups: {
      key: string;
      name: string;
      answers: { key: string; pain: PainRef | null; capability: string; strength: "direct" | "partial" }[];
      unanswered: { key: string; pain: PainRef | null; status: string; note?: string }[];
      objections: { key: string; objection: string; answer: string | null; notToday: boolean }[];
    }[];
    proof: { key: string; text: string; note?: string }[];
    dontClaim: {
      lead: string[];
      product: string[];
      brand: string[];
      imply: { key: string; pain: PainRef | null; text: string }[];
      proof: { key: string; text: string; note?: string }[];
    };
  };
  competition: {
    view: string | null;
    doNothing: string | null;
    competitors: { key: string; name: string; url?: string; positioning: string; pricing: string | null; pricingGated: boolean; strengths: string[]; weaknesses: string[]; recentMoves: Item[] }[];
    prices: { key: string; name: string; price: string; minimum?: string; commitment?: string }[];
    adjacent: { key: string; name: string; note: string }[];
  };
  companies: {
    groups: {
      key: string;
      name: string;
      firms: SeedFirm[];
      signs: { key: string; text: string; strength: "HOT" | "WARM"; whereToFind: string; url?: string }[];
      recipe: { titles: string[]; excludeTitles: string[]; sizeMin: number; sizeMax: number; countries: string[]; industries: string[]; triggers: string[]; locations: string[] };
      listSources: { key: string; name: string; url: string; note?: string }[];
    }[];
  };
  gather: {
    kinds: {
      kind: "event" | "association" | "publication" | "community" | "review-site" | "press";
      entries: { key: string; name: string; url: string; date: string | null; onTimeline: boolean; audience: string; why: string; groups: string[] }[];
    }[];
    discovery: string[];
  };
  contact: { channels: { channel: string; rules: { key: string; rule: string; region: string; source: string; bars: boolean }[] }[] };
  gaps: { groups: { kind: GapGroupKind; findings: ResearchFinding[] }[] };
  sourceList: { title: string; url: string; accessedAt: string }[];
};

/**
 * The research page's data: the campaign it belongs to, and the research, or
 * null when there is no finished plan to read. The brief and the Overview's
 * opening (In short, Start with) are what the printed pack opens with (task
 * 20): the same values the campaign page shows, not read again.
 */
export type CampaignResearchPage = {
  id: string;
  name: string;
  brief: BriefFields;
  summary: Pick<CampaignOverview, "inShort" | "startWith"> | null;
  research: CampaignResearch | null;
};

/** The scope dimension a widening option widens (research v3.2, note 28). */
export type WidenDimension = "region" | "size" | "sector" | "role";

/** One of a stop's widening options, as the rep chooses between them. */
export type WidenChoice = {
  /** The option's place in research's list: what choosing it names. */
  index: number;
  dimension: WidenDimension;
  /** "Widen the region", numbered when two options widen the same thing. */
  heading: string;
  /** Research's own words for the option, unchanged. */
  text: string;
  /** What the brief would read after it ("Where becomes United Kingdom"); null on a sample, which has no real brief to change. */
  becomes: string | null;
  /** False when the option no longer widens the brief as it stands, so it cannot be chosen. */
  usable: boolean;
};

/** What the rep can ask of research from where the campaign is (orchestrator A1, items 4 to 6). */
export type ResearchActions = {
  widen: boolean;
  edit: boolean;
  retry: boolean;
  /** Confirm plan can be pressed: finding people is set up and the version is not yet confirmed. */
  confirm?: boolean;
  /** Try again on finding people (lead gen v2.1 §11). */
  retryPeople?: boolean;
  /** Choose an industry and search with it (lead gen v2.1 §5). */
  chooseIndustry?: boolean;
  /** Keep or drop the people found (lead gen v2.2 §9a). */
  review?: boolean;
  /** Reveal emails can be pressed: somebody kept has an email to reveal or reuse (lead gen v2.1 §6). */
  reveal?: boolean;
};

/** What pressing Confirm plan does, shown before it is pressed (lead gen v2.1 §6, §12). */
export type ConfirmPlanView = {
  /** False where finding people is not set up: Confirm is drawn and cannot be pressed. */
  available: boolean;
  /** The kind of buyer the search is for: the one research ranks first. */
  groupName: string | null;
  /** The search credit limit Confirm approves; null where finding people is not set up. */
  searchCreditCap: number | null;
  /** True when people and credits are samples, never a live account. */
  sample: boolean;
  /** The lawful-basis words the rep confirms. */
  lawfulBasis: string;
};

/** Who a person is to the purchase (lead gen v2.2 §8a). */
export type RolePartView = "runs" | "champions" | "signs";

/** The rep's decision before Reveal (lead gen v2.2 §9a). Pending is not kept. */
export type ReviewView = "pending" | "kept" | "dropped";

/** What Reveal emails came to for one kept person (lead gen v2.1 §7, §9). */
export type RevealStateView = "revealed" | "known" | "no_email" | "suppressed" | "held" | "failed";

/**
 * One person under an account, as the rep reads them: no provider ids and no
 * taxonomy. An email only once it is revealed or already known, and usable.
 */
export type FoundPersonView = {
  id: string;
  rank: number;
  name: string;
  title: string;
  company: string;
  city: string | null;
  /** Relay already holds a usable email for them: nothing to buy. */
  reused: boolean;
  /** The confirmed group's role they play; null is a Related role, or a search that had no roles. */
  role: RolePartView | null;
  /** One short line on why they are here: the role they matched (v2.2 note 3). The role's needs are shown once, per role. */
  why: string;
  review: ReviewView;
  /** Null until Reveal emails has run for them. */
  reveal: RevealStateView | null;
  /** The usable email: only for revealed and already known people. */
  email: string | null;
  /** Why there is no usable email, in words; null when there is one or nothing was revealed. */
  revealWhy: string | null;
};

/** What Reveal emails would do for the kept people, before it is pressed (the figures the rep approves). */
export type RevealPlanView = {
  kept: number;
  known: number;
  toReveal: number;
  free: number;
  maxCredits: number;
  noEmail: number;
  unavailable: number;
};

/** What Reveal emails came to, once pressed. */
export type RevealResultView = {
  /** Still running, or stopped before it finished. */
  running: boolean;
  stopped: boolean;
  tally: Record<RevealStateView, number>;
  charged: number;
  reserved: number;
  maxCredits: number;
  /** Chosen people the rep did not keep: never revealed. */
  notKept: number;
};

/** One of the confirmed group's roles, shown once above the accounts with what research says it needs. */
export type BuyerRoleView = { part: RolePartView; title: string; needs: string };

/** One account in Reviewing people: its people, the roles they cover, and why it is here (v2.2 §9a). */
export type AccountView = {
  /** The first person's id: what Drop account names. Never a provider id or a domain. */
  personId: string;
  company: string;
  domain: string | null;
  people: FoundPersonView[];
  /** The roles its people cover, runs first. */
  parts: RolePartView[];
  /** Evidence about this account in particular, only where Relay has it (a firm research named); null otherwise. */
  evidence: string | null;
};

/** People found, X of N (lead gen v2.1 §4, §11). */
export type PeopleFoundView = {
  groupName: string;
  found: { n: number; ofM: number };
  shortfall: "cap_reached" | "no_more_results" | "fewer_strong_matches" | null;
  /** The plan's search, said once above the accounts: every account matches it (v2.2 note 3). */
  search: string;
  /** The confirmed group's roles and their needs, once each. Empty for a search that had no roles. */
  buyerRoles: BuyerRoleView[];
  /** Accounts first (v2.2 §9a), in the order Relay chose them; people nested, by rank. */
  accounts: AccountView[];
  /** True when the search matched people to research's roles (a v2.2 run). */
  roles: boolean;
  review: { kept: number; dropped: number; pending: number };
  onHold: number;
  spend: { charged: number; reserved: number; cap: number };
  /**
   * Where the list is: the rep reviewing it, Reveal emails running, or the
   * emails ready. After Reveal, only the kept people are listed.
   */
  phase: "review" | "revealing" | "ready";
  /** Reviewing: what revealing the KEPT people's emails would do; pending and dropped count for nothing (v2.2 §9a). Null when it cannot be worked out. */
  revealPlan: RevealPlanView | null;
  /** Revealing or ready: what it came to. */
  revealResult: RevealResultView | null;
  sample: boolean;
};

/** Why finding people needs the rep (lead gen v2.1 §11), in words, with any plain-words choices. */
export type PeopleNeedsYouView = {
  reason: string;
  line: string;
  term: string | null;
  choices: string[];
};

/** Why research did not finish, in the words of orchestrator §7 (amended A1). */
export type ResearchFailure = "took_too_long" | "bad_output" | "failed" | "not_started";

export type AskAnswer = { id: string; question: string; answer: string };

export type CampaignSummary = {
  id: string;
  name: string;
  /** The one grey line under the name: motion, product, size, channels. */
  motionLine: string;
  state: CampaignState;
  /** One word of state, for the chip. */
  chip: string;
  /** People contacted so far, or null while nothing has happened past research. */
  contacted: number | null;
  total: number;
  /** The same sentence the page's action button uses (§23.1c). */
  next: string;
  /** True when the "next" line is the campaign's own action, so it reads in the accent. */
  nextIsAction: boolean;
};

export type Campaign = CampaignSummary & {
  brief: BriefFields;
  /** The research behind the plan. Absent while research is still reading, or when it did not finish. */
  pack: CampaignPack | null;
  /** The Overview of a real campaign's finished plan. Null on a sample, a stop, and while research reads. */
  overview: CampaignOverview | null;
  plan: {
    people: number;
    companies: number;
    creditsNeeded: number;
    creditsLeft: number;
    perDay: number;
    windowStart: string;
    windowEnd: string;
    mailbox: string;
  } | null;
  /** Null until people have been found: there is nothing to count before then. */
  progress: { found: number; drafted: number; approved: number; sent: number; replied: number } | null;
  people: { chosen: number; companies: number; onHold: number } | null;
  outcomes: { warm: number; meetings: number } | null;
  draftsDueToday: number;
  nextBatch: { day: string; time: string } | null;
  /** Null until a credit has been spent. */
  credits: { used: number; left: number } | null;
  ask: AskAnswer[];
  /**
   * True for a campaign read from the database. False for the sample campaigns
   * the component tests draw the later, signed states with (Running, Done):
   * those states need lead gen, which does not exist yet, so no real campaign
   * can be in them and no page shows a sample.
   */
  live: boolean;
  /** Set when research did not finish. */
  failure: ResearchFailure | null;
  /** The brief version the page was drawn from: every change the page asks for names it. */
  briefVersion: number;
  /** What the rep can ask of research from here. All false on a sample: its actions are its own. */
  can: ResearchActions;
  /** Plan ready: what Confirm plan does. Absent on samples. */
  confirmPlan?: ConfirmPlanView | null;
  /** People found: the persisted result. */
  peopleFound?: PeopleFoundView | null;
  /** Finding people needs the rep. */
  peopleNeedsYou?: PeopleNeedsYouView | null;
  /** Credits have been spent at this version, so Edit brief warns before it discards the selection. */
  spentAtThisVersion?: boolean;
  /** On a stop, research's widening options as the rep chooses between them. Null in every other state. */
  widenings: WidenChoice[] | null;
};
