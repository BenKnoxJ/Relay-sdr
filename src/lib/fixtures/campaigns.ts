import {
  researchOutputSchema,
  type ResearchPack,
} from "../../../agents/research/output.schema";
import goodPack from "../../../agents/research/fixtures/output.good.json";

import {
  answersFor,
  chipFor,
  nextFor,
  type AskAnswer,
  type CampaignState,
} from "@/lib/campaigns/state";

/**
 * The Campaigns area's data, until there is a `Campaign` model to read.
 *
 * **This module is the seam.** The three screens (§23.1c list and page, §23.1d
 * Start) call `listCampaigns`, `getCampaign` and `startFromSentence` and know
 * nothing else; every component below them takes what those return as props.
 * When Lane A lands the model and the routers, a tRPC-backed implementation of
 * these three signatures replaces this file and no component changes. That is
 * the whole reason the derived strings (the state chip, the row's "next" line,
 * the six Ask Relay answers) are computed HERE rather than in a component: they
 * are answers about a campaign, and the campaign is what is being swapped.
 *
 * Three things this deliberately does not do. It makes no model call — Start's
 * pre-fill is a keyword mapping, not the orchestrator's pre-fill step. It
 * writes nothing. And it spends nothing: `confirmPlan` and `startResearch` are
 * not here at all, because on fixtures they change a screen and not a campaign.
 *
 * The research pack is the **real** parsed output of the signed research
 * contract (`agents/research/output.schema.ts`), not a shape invented for the
 * page. It is parsed at module load, so a pack the contract would reject fails
 * the build rather than rendering as a page with quiet gaps.
 */

export type BriefFields = {
  product: string;
  motion: "direct" | "channel";
  who: string;
  region: string;
  howMany: number;
  weeks: number;
  channels: ("email" | "linkedin" | "calls")[];
};

export type CampaignSummary = {
  id: string;
  name: string;
  /** The one grey line under the name: motion, product, size, channels. */
  motionLine: string;
  state: CampaignState;
  /** One word of state, for the chip. */
  chip: string;
  contacted: number;
  total: number;
  /** The same sentence the page's action button uses (§23.1c). */
  next: string;
  /** True when the "next" line is the campaign's own action, so it reads in the accent. */
  nextIsAction: boolean;
};

export type Campaign = CampaignSummary & {
  brief: BriefFields;
  /** The research behind the plan. Absent while research is still reading. */
  pack: ResearchPack | null;
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
  progress: { found: number; drafted: number; approved: number; sent: number; replied: number };
  people: { chosen: number; companies: number; onHold: number } | null;
  outcomes: { warm: number; meetings: number };
  draftsDueToday: number;
  nextBatch: { day: string; time: string } | null;
  credits: { used: number; left: number };
  ask: AskAnswer[];
};

/** One product, as §23.1d says v1 has: Insights360, with its facts file's version. */
export type Product = { id: string; name: string; factsVersion: number; factsUpdated: string };

export const PRODUCTS: Product[] = [
  { id: "insights360", name: "Insights360", factsVersion: 3, factsUpdated: "2 Sep" },
];

/** §23.1d: a Region dropdown, defaulting to the United Kingdom. */
export const REGIONS = ["United Kingdom", "Ireland", "United States"] as const;
export const REGION_DEFAULT = REGIONS[0];

/** The two pickers' allowed values, straight from §23.1d. */
export const HOW_MANY = [10, 20, 30, 50] as const;
export const HOW_LONG = [2, 3, 4, 6] as const;

/**
 * The pack every campaign past Researching shows.
 *
 * The signed good fixture, plus three items added to the first group so the
 * page exercises all four confidence words rather than the single word that
 * fixture happens to use throughout. All three are legal under the contract and
 * all three are parsed by it: the primary-sourced item earns `strong`, the one
 * with two sources on two domains earns `moderate`, and the sourceless one is
 * `speculative`, which is the word the screen renders as "a guess". Nothing is
 * edited under `agents/` to do this — the fixture there stays the research
 * agent's, and this is the page's own copy of it.
 */
function planPack(): ResearchPack {
  const raw = structuredClone(goodPack) as Record<string, unknown>;
  const archetypes = raw.archetypes as { pains: unknown[] }[];
  const first = archetypes[0];
  if (first === undefined) throw new Error("the research fixture has no groups to render");

  // Three items added to the first group so the page exercises all four
  // confidence words. Each earns its word from its own evidence under the
  // contract's ceiling rule: primary source, two sources on two domains, and
  // none at all.
  first.pains.push(
    {
      id: "pain-regulator",
      text: "The regulator restated in April that firms must be able to evidence the outcomes their customers receive.",
      accessedAt: "2026-09-08",
      publishedAt: "2026-04-14",
      evidence: { urls: ["https://fca.org.uk/publications/finalised-guidance/fair-value"], primary: true, domains: ["fca.org.uk"] },
      confidence: "strong",
    },
    {
      id: "pain-two-sources",
      text: "Two separate write ups this year put the same team behind both the complaints queue and the quality checking.",
      accessedAt: "2026-09-08",
      publishedAt: "2026-05-20",
      evidence: {
        urls: ["https://postonline.co.uk/a/pain-two-sources", "https://insuranceage.co.uk/a/pain-two-sources"],
        primary: false,
        domains: ["postonline.co.uk", "insuranceage.co.uk"],
      },
      confidence: "moderate",
    },
    {
      id: "pain-inferred-appetite",
      text: "These teams would read every call if reading them cost nothing.",
      accessedAt: "2026-09-08",
      evidence: { urls: [], primary: false, domains: [] },
      confidence: "speculative",
      inferredFrom: "the two lines above, and no source that says it directly",
    },
  );

  return researchOutputSchema.parse(raw);
}

/**
 * The pack behind the research stop.
 *
 * Same pack with an `insufficient` block, because the contract keeps a pack
 * whole and puts the stop inside it (§3, `insufficientSchema`): what was found,
 * and exactly three widenings. The stop screen reads only that block.
 */
function stoppedPack(): ResearchPack {
  const raw = structuredClone(goodPack) as Record<string, unknown>;
  raw.insufficient = {
    found: [
      {
        id: "found-triage",
        text: "Three independent practices with four to six sites, all three listing out of hours triage as a service.",
        accessedAt: "2026-09-08",
        publishedAt: "2026-06-02",
        evidence: { urls: ["https://vettimes.co.uk/a/found-triage"], primary: false, domains: ["vettimes.co.uk"] },
        confidence: "weak",
      },
      {
        id: "found-no-press",
        text: "No trade press and no hiring anywhere in the last twelve months for practices of this size.",
        accessedAt: "2026-09-08",
        evidence: { urls: [], primary: false, domains: [] },
        confidence: "speculative",
        inferredFrom: "eleven searches that returned nothing datable",
      },
    ],
    widenings: [
      { kind: "region", text: "Look at the whole of the United Kingdom rather than Scotland alone." },
      { kind: "size", text: "Look at every practice with three or more sites rather than four to six." },
      { kind: "pain", text: "Name the pain yourself and Relay will look for evidence of it." },
    ],
  };
  return researchOutputSchema.parse(raw);
}

const PLAN_PACK = planPack();
const STOPPED_PACK = stoppedPack();

/**
 * Which campaigns count as running for the page-header note.
 *
 * Everything that is neither done nor stopped, which is how the signed mock
 * counts: 3a reads "2 running · 1 done" over rows whose chips say Running,
 * Plan ready and Done. "Running" in that line means "still going", and the
 * chip on the row is where a rep reads the state itself.
 */
function isRunning(state: CampaignState): boolean {
  return state !== "done" && state !== "stopped";
}

type Row = Omit<Campaign, "chip" | "next" | "nextIsAction" | "ask">;

function complete(row: Row): Campaign {
  return {
    ...row,
    chip: chipFor(row.state),
    ...nextFor(row.state, row),
    ask: answersFor(row.state, row),
  };
}

const NO_PROGRESS = { found: 0, drafted: 0, approved: 0, sent: 0, replied: 0 };
const NO_OUTCOMES = { warm: 0, meetings: 0 };

/**
 * The fixtures, newest first.
 *
 * `inList` is the one field that exists only because these are fixtures. The
 * signed list (mock 3a) has exactly three rows, and the signed campaign page
 * (3c) draws two campaigns that are not among them: one Researching and one
 * stopped. Both are reachable by id so the page's four states can be seen and
 * shot; neither is a row. A tRPC-backed adapter lists everything and drops this
 * field.
 */
const ROWS: (Row & { inList: boolean })[] = [
  {
    id: "uk-logistics-ops",
    name: "UK logistics ops",
    motionLine: "Direct · call handling · 20 people over 3 weeks · email + LinkedIn",
    state: "running",
    contacted: 6,
    total: 20,
    inList: true,
    brief: {
      product: "Insights360",
      motion: "direct",
      who: "Ops directors at UK logistics firms opening depots",
      region: "United Kingdom",
      howMany: 20,
      weeks: 3,
      channels: ["email", "linkedin"],
    },
    pack: PLAN_PACK,
    plan: {
      people: 20,
      companies: 8,
      creditsNeeded: 20,
      creditsLeft: 142,
      perDay: 4,
      windowStart: "09:00",
      windowEnd: "16:30",
      mailbox: "ben@conversant.technology",
    },
    progress: { found: 20, drafted: 11, approved: 9, sent: 6, replied: 2 },
    people: { chosen: 20, companies: 8, onHold: 2 },
    outcomes: { warm: 2, meetings: 0 },
    draftsDueToday: 2,
    nextBatch: { day: "Thursday", time: "09:00" },
    credits: { used: 20, left: 142 },
  },
  {
    id: "managed-print-partners-midlands",
    name: "Managed print partners, Midlands",
    motionLine: "Channel · Insights360 · 15 partners over 4 weeks · email",
    state: "planReady",
    contacted: 0,
    total: 15,
    inList: true,
    brief: {
      product: "Insights360",
      motion: "channel",
      who: "Managed print dealers in the Midlands who resell service contracts. MD or Sales Director.",
      region: "United Kingdom",
      howMany: 15,
      weeks: 4,
      channels: ["email"],
    },
    pack: PLAN_PACK,
    plan: {
      people: 15,
      companies: 6,
      creditsNeeded: 15,
      creditsLeft: 162,
      perDay: 4,
      windowStart: "09:00",
      windowEnd: "16:30",
      mailbox: "ben@conversant.technology",
    },
    progress: NO_PROGRESS,
    people: null,
    outcomes: NO_OUTCOMES,
    draftsDueToday: 0,
    nextBatch: null,
    credits: { used: 0, left: 162 },
  },
  {
    id: "vets-scotland",
    name: "Vets, Scotland",
    motionLine: "Direct · call handling · 20 people over 3 weeks · email",
    state: "stopped",
    contacted: 0,
    total: 20,
    inList: false,
    brief: {
      product: "Insights360",
      motion: "direct",
      who: "Practice owners at independent vets in Scotland",
      region: "United Kingdom",
      howMany: 20,
      weeks: 3,
      channels: ["email"],
    },
    pack: STOPPED_PACK,
    plan: null,
    progress: NO_PROGRESS,
    people: null,
    outcomes: NO_OUTCOMES,
    draftsDueToday: 0,
    nextBatch: null,
    credits: { used: 0, left: 162 },
  },
  {
    id: "care-homes-south-west",
    name: "Care homes, South West",
    motionLine: "Direct · call handling · 30 people over 4 weeks · email",
    state: "done",
    contacted: 30,
    total: 30,
    inList: true,
    brief: {
      product: "Insights360",
      motion: "direct",
      who: "Registered managers at care home groups in the South West",
      region: "United Kingdom",
      howMany: 30,
      weeks: 4,
      channels: ["email"],
    },
    pack: PLAN_PACK,
    plan: {
      people: 30,
      companies: 11,
      creditsNeeded: 30,
      creditsLeft: 132,
      perDay: 4,
      windowStart: "09:00",
      windowEnd: "16:30",
      mailbox: "ben@conversant.technology",
    },
    progress: { found: 30, drafted: 30, approved: 30, sent: 30, replied: 7 },
    people: { chosen: 30, companies: 11, onHold: 1 },
    outcomes: { warm: 4, meetings: 2 },
    draftsDueToday: 0,
    nextBatch: null,
    credits: { used: 30, left: 132 },
  },
  {
    id: "midlands-fleet-operators",
    name: "Midlands fleet operators",
    motionLine: "Direct · call handling · 20 people over 3 weeks · email",
    state: "researching",
    contacted: 0,
    total: 20,
    inList: false,
    brief: {
      product: "Insights360",
      motion: "direct",
      who: "Transport managers at Midlands fleet operators",
      region: "United Kingdom",
      howMany: 20,
      weeks: 3,
      channels: ["email", "calls"],
    },
    pack: null,
    plan: null,
    progress: NO_PROGRESS,
    people: null,
    outcomes: NO_OUTCOMES,
    draftsDueToday: 0,
    nextBatch: null,
    credits: { used: 0, left: 162 },
  },
];

/** Where "Start research" lands: the campaign in Researching (§23.1d). */
export const RESEARCHING_CAMPAIGN_ID = "midlands-fleet-operators";

/** The list, newest first (§23.1c). The array's order is that order. */
export function listCampaigns(): CampaignSummary[] {
  return ROWS.filter((row) => row.inList).map(complete);
}

/** How the page header counts itself: "2 running · 1 done". */
export function listCounts(): { running: number; done: number } {
  const rows = ROWS.filter((row) => row.inList);
  return {
    running: rows.filter((row) => isRunning(row.state)).length,
    done: rows.filter((row) => row.state === "done").length,
  };
}

/** One campaign, or null when the id is not one. */
export function getCampaign(id: string): Campaign | null {
  const row = ROWS.find((candidate) => candidate.id === id);
  return row === undefined ? null : complete(row);
}

/** What Start pre-filled, and what it had to guess (§23.1d: dashed means guessed). */
export type BriefDraft = BriefFields & { guessed: (keyof BriefFields)[]; landsOn: string };

/**
 * Start's pre-fill, as a keyword mapping.
 *
 * §23.1d has the orchestrator pre-fill this card from the sentence, which is
 * one model call. There is no orchestrator yet and this task makes no model
 * call, so the mapping is mechanical and the honesty rule is kept the other
 * way round: a field the sentence does not support is left at its default and
 * named in `guessed`, which is what draws it dashed.
 */
export function startFromSentence(sentence: string): BriefDraft {
  const text = sentence.toLowerCase();
  const guessed: (keyof BriefFields)[] = [];

  const channel = /partner|dealer|reseller|channel/.test(text);
  if (!/direct|partner|dealer|reseller|channel/.test(text)) guessed.push("motion");

  const region = REGIONS.find((name) => text.includes(name.toLowerCase()));
  if (region === undefined) guessed.push("region");

  // Both number pickers are anchored to a unit, so "vets with 10 or more
  // sites" does not silently become a size of ten and, worse, render solid as
  // though the rep had said it.
  const howManyMatch =
    /\b(10|20|30|50)\s+(people|partners|contacts|prospects|firms|companies|dealers|leads)\b/.exec(
      text,
    );
  if (howManyMatch === null) guessed.push("howMany");

  const weeksMatch = /\b(2|3|4|6)\s*weeks?\b/.exec(text);
  if (weeksMatch === null) guessed.push("weeks");

  // One pattern decides whether calls are on, and the same one decides whether
  // the rep said so: two patterns is how "email only, no cold calls" ends up
  // with calls on and no dashed frame to show it was a guess.
  const saidLinkedin = /linkedin/.test(text);
  const saidNoCalls = /\b(no|without)\s+(cold\s+)?calls?\b|email only|no phone/.test(text);
  const saidCalls = /\bcalls?\b|\bphone\b/.test(text);
  if (!saidLinkedin && !saidCalls && !saidNoCalls) guessed.push("channels");

  const channels: BriefFields["channels"] = ["email"];
  if (saidLinkedin) channels.push("linkedin");
  // Calls are on by default (§23.1d) and off only when the rep said so.
  if (!saidNoCalls) channels.push("calls");

  return {
    // §23.1d: never invent a product. v1 has one, so it is the one.
    product: PRODUCTS[0]?.name ?? "",
    motion: channel ? "channel" : "direct",
    // The rep's own words, kept (orchestrator §2, "`who` keeps the rep's words").
    who: sentence.trim(),
    region: region ?? REGION_DEFAULT,
    howMany: howManyMatch === null ? 20 : Number(howManyMatch[1]),
    weeks: weeksMatch === null ? 3 : Number(weeksMatch[1]),
    channels,
    guessed,
    landsOn: RESEARCHING_CAMPAIGN_ID,
  };
}
