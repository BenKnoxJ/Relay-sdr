import type { Item, PlanCards } from "../../../agents/research/output.schema";

import type { CampaignState } from "./state";

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
};
