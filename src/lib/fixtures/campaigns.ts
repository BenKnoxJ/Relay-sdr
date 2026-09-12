import { z } from "zod";

import { itemSchema, planCardsSchema, type PlanCards } from "../../../agents/research/output.schema";
import samplePack from "./research-plan.json";

import { answersFor, chipFor, nextFor, type CampaignState } from "@/lib/campaigns/state";
import { EMPTY_SCOPE } from "@/lib/campaigns/start";
import type { Campaign, CampaignPack, CampaignSummary } from "@/lib/campaigns/types";

export type { BriefFields, Campaign, CampaignPack, CampaignSummary } from "@/lib/campaigns/types";

/**
 * Sample campaigns, for the component tests and nothing else.
 *
 * **No page reads this module.** The Campaigns screens read the database
 * through `src/server/campaigns.ts`. These samples exist because the signed
 * campaign page has states no real campaign can reach yet (Running, Paused,
 * Done need lead gen and outreach), and the components that draw them still
 * need a campaign to be drawn from. Every sample is `live: false`, which is
 * also what keeps the signed actions (Confirm, Pause, Widen, Change something)
 * working on them and off a real campaign.
 *
 * The research each sample shows is the signed contract's own plan-card view
 * (`planCardsSchema`), parsed at module load so a view the contract would
 * reject fails the build rather than rendering with quiet gaps.
 */

/**
 * A plan-card view from a sample pack in the cards' own shape, parsed by the
 * view's contract: the recipe gets lead gen's excluded titles (none here) and
 * the view its completeness fields.
 */
export function toPlanView(raw: unknown): PlanCards {
  const pack = structuredClone(raw) as Record<string, unknown> & { recipe?: Record<string, unknown> };
  return planCardsSchema.parse({
    ...pack,
    ...(pack.recipe === undefined ? {} : { recipe: { excludeTitles: [], ...pack.recipe } }),
    partial: false,
    missingModules: [],
  });
}

/**
 * The pack the later-state samples show: the sample view, plus three items
 * added to the first group so the page exercises all four confidence words.
 * Each earns its word from its own evidence under the contract's ceiling rule.
 */
function planPack(): CampaignPack {
  const raw = structuredClone(samplePack) as Record<string, unknown>;
  const archetypes = raw.archetypes as { pains: unknown[] }[];
  const first = archetypes[0];
  if (first === undefined) throw new Error("the research sample has no groups to render");

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

  return toPlanView(raw);
}

/** The sample stop: the view with a v3.2 insufficient block, and the two items it cites beside it. */
function stoppedPack(): CampaignPack {
  const view = planCardsSchema.parse({
    ...toPlanView(samplePack),
    insufficient: {
      reason: "Too few independent practices of this size in Scotland show any sign of the pain.",
      evidenceIds: ["found-triage", "found-no-press"],
      widenings: [
        { dimension: "region", text: "Look at the whole of the United Kingdom rather than Scotland alone.", scopePatch: { countries: ["GB"], places: null } },
        { dimension: "size", text: "Look at every practice with three or more sites rather than four to six.", scopePatch: { size: { unit: "sites", min: 3 } } },
        { dimension: "sector", text: "Look at practice groups as well as independent practices.", scopePatch: { orgTypes: ["independent veterinary practice", "veterinary practice group"] } },
      ],
      decidedAt: "2026-09-08T10:00:00Z",
    },
  });
  const stopEvidence = z.array(itemSchema).parse([
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
  ]);
  return { ...view, stopEvidence };
}

const PLAN_PACK = planPack();
const STOPPED_PACK = stoppedPack();

type Row = Omit<Campaign, "chip" | "next" | "nextIsAction" | "ask">;

function complete(row: Row): Campaign {
  return {
    ...row,
    chip: chipFor(row.state),
    ...nextFor(row.state, row),
    ask: answersFor(row.state, row),
  };
}

function isRunning(state: CampaignState): boolean {
  return state !== "done" && state !== "stopped";
}

const NO_PROGRESS = { found: 0, drafted: 0, approved: 0, sent: 0, replied: 0 };
const NO_OUTCOMES = { warm: 0, meetings: 0 };
const SAMPLE = { live: false, failure: null } as const;

/**
 * The samples, newest first. `inList` is the signed list's three rows (mock
 * 3a); the Researching and stopped samples are reachable by id only.
 */
const ROWS: (Row & { inList: boolean })[] = [
  {
    ...SAMPLE,
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
      region: "GB",
      howMany: 20,
      weeks: 3,
      channels: ["email", "linkedin"],
      scope: EMPTY_SCOPE,
      existingCustomers: "",
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
      mailbox: "rep@example.test",
    },
    progress: { found: 20, drafted: 11, approved: 9, sent: 6, replied: 2 },
    people: { chosen: 20, companies: 8, onHold: 2 },
    outcomes: { warm: 2, meetings: 0 },
    draftsDueToday: 2,
    nextBatch: { day: "Thursday", time: "09:00" },
    credits: { used: 20, left: 142 },
  },
  {
    ...SAMPLE,
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
      region: "GB",
      howMany: 15,
      weeks: 4,
      channels: ["email"],
      scope: EMPTY_SCOPE,
      existingCustomers: "",
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
      mailbox: "rep@example.test",
    },
    progress: NO_PROGRESS,
    people: null,
    outcomes: NO_OUTCOMES,
    draftsDueToday: 0,
    nextBatch: null,
    credits: { used: 0, left: 162 },
  },
  {
    ...SAMPLE,
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
      region: "GB",
      howMany: 20,
      weeks: 3,
      channels: ["email"],
      scope: EMPTY_SCOPE,
      existingCustomers: "",
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
    ...SAMPLE,
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
      region: "GB",
      howMany: 30,
      weeks: 4,
      channels: ["email"],
      scope: EMPTY_SCOPE,
      existingCustomers: "",
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
      mailbox: "rep@example.test",
    },
    progress: { found: 30, drafted: 30, approved: 30, sent: 30, replied: 7 },
    people: { chosen: 30, companies: 11, onHold: 1 },
    outcomes: { warm: 4, meetings: 2 },
    draftsDueToday: 0,
    nextBatch: null,
    credits: { used: 30, left: 132 },
  },
  {
    ...SAMPLE,
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
      region: "GB",
      howMany: 20,
      weeks: 3,
      channels: ["email", "calls"],
      scope: EMPTY_SCOPE,
      existingCustomers: "",
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

/** The sample list, newest first. */
export function listCampaigns(): CampaignSummary[] {
  return ROWS.filter((row) => row.inList).map(complete);
}

/** How the sample list's header counts itself: "2 running · 1 done". */
export function listCounts(): { running: number; done: number } {
  const rows = ROWS.filter((row) => row.inList);
  return {
    running: rows.filter((row) => isRunning(row.state)).length,
    done: rows.filter((row) => row.state === "done").length,
  };
}

/** One sample, or null when the id is not one. */
export function getCampaign(id: string): Campaign | null {
  const row = ROWS.find((candidate) => candidate.id === id);
  return row === undefined ? null : complete(row);
}
