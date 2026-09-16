import type { ChipTone } from "@/components/Chip";
import { campaignsCopy } from "@/lib/copy/campaigns";

import { failureLine, haltLine, revealStoppedLine } from "./state";
import type { CampaignSummary, CampaignSummaryFacts } from "./types";

/**
 * How Home, the Campaigns list and the campaign page read the backend's
 * summary facts (product-truth foundation). Words only: every decision about
 * where a campaign is, what needs the rep and what can be done next is the
 * backend's (`facts.stage`, `facts.attention`, `facts.nextAction`), and this
 * module turns those facts into the line under a name and the group a row
 * sits in. It holds no rule of its own about state.
 *
 * Client-safe: copy and words, no schema.
 */

/** Which group a campaign is read in. Attention first, then what is the rep's to decide, then what is ready, then what Relay is doing; done last. */
export type Bucket = "needsYou" | "decide" | "ready" | "working" | "done";

export function bucketOf(facts: CampaignSummaryFacts): Bucket {
  if (facts.attention !== null) return "needsYou";
  switch (facts.stage) {
    case "plan_ready":
    case "reviewing_people":
      return "decide";
    case "people_ready":
      return "ready";
    default:
      return "working";
  }
}

/** A queued job is waiting its turn: said as waiting, never as running. */
export function isWaiting(facts: CampaignSummaryFacts): boolean {
  return facts.inFlight?.status === "queued";
}

/** The chip's tone for a row, the same on Home and the Campaigns list: needs you warns, ready and live work are ok, a waiting job and the rest are plain. */
export function chipToneOf(bucket: Bucket, waiting: boolean): ChipTone {
  switch (bucket) {
    case "needsYou":
      return "warn";
    case "ready":
      return "ok";
    case "working":
      return waiting ? "default" : "ok";
    case "decide":
    case "done":
      return "default";
  }
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Why the campaign needs the rep, in words, from the backend's reason. Null when it does not. */
export function reasonLineOf(facts: CampaignSummaryFacts): string | null {
  switch (facts.stage) {
    case "research_needs_you":
      return failureLine(facts.attention.reason);
    case "research_stopped":
      return campaignsCopy.stopBanner;
    case "people_needs_you":
      return haltLine(facts.attention.reason);
    case "reveal_needs_you":
      return revealStoppedLine(facts.attention.reason);
    default:
      return null;
  }
}

/** The one line of what Relay has for this campaign, from the facts. Null when there is nothing to say yet. */
export function stageLineOf(facts: CampaignSummaryFacts): string | null {
  const c = campaignsCopy;
  const reason = reasonLineOf(facts);
  if (reason !== null) return reason;
  const waiting = isWaiting(facts);
  switch (facts.stage) {
    case "researching":
      return waiting ? c.summaryWaiting : c.summaryResearching;
    case "plan_ready": {
      const research = facts.research;
      if (research === null) return null;
      const plays = research.viablePlays > 0 ? plural(research.viablePlays, c.summaryPlay, c.summaryPlays) : null;
      return [plays].filter((part) => part !== null).join(c.noteJoin) || null;
    }
    case "finding_people":
      return waiting ? c.summaryWaiting : c.summaryFinding;
    case "reviewing_people": {
      const p = facts.people;
      if (p === null) return null;
      return [
        `${plural(p.chosen, c.summaryPerson, c.summaryPeople)} ${c.summaryAt} ${plural(p.accounts, c.summaryAccount, c.summaryAccounts)}`,
        `${p.kept} ${c.summaryKept}`,
        `${p.pending} ${c.summaryToReview}`,
      ].join(c.noteJoin);
    }
    case "revealing":
      return waiting ? c.summaryWaiting : c.summaryRevealing;
    case "people_ready": {
      const r = facts.reveal;
      if (r === null) return null;
      const without = r.noEmail + r.suppressed + r.held + r.failed;
      const notKept = facts.people === null ? 0 : facts.people.chosen - facts.people.kept;
      return [`${r.emailsReady} ${c.summaryEmailsReady}`, `${without} ${c.summaryNoEmail}`, ...(notKept > 0 ? [`${notKept} ${c.summaryNotKept}`] : [])].join(c.noteJoin);
    }
    default:
      return null;
  }
}

/** The stage in a rep's words, for a chip beside a working row. */
export function stageWordOf(facts: CampaignSummaryFacts, chip: string): string {
  return isWaiting(facts) ? campaignsCopy.summaryWaiting : chip;
}

/** Dollars as a rep reads them: "$16.03". */
export function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/**
 * A row's group. The backend's facts decide for every stored campaign. A row
 * with none is a sample (the component tests' signed later states), and its
 * screen state stands in: running is Relay's work, done is done, the rest is
 * the rep's to decide.
 */
export function bucketOfRow(campaign: Pick<CampaignSummary, "facts" | "state">): Bucket {
  if (campaign.facts !== undefined) return bucketOf(campaign.facts);
  if (campaign.state === "running" || campaign.state === "paused" || campaign.state === "drafting") return "working";
  if (campaign.state === "done") return "done";
  return "decide";
}

export type BucketCounts = Record<Bucket, number>;

/** The list header's counts, by group. */
export function countBuckets(campaigns: readonly Pick<CampaignSummary, "facts" | "state">[]): BucketCounts {
  const counts: BucketCounts = { needsYou: 0, decide: 0, ready: 0, working: 0, done: 0 };
  for (const campaign of campaigns) counts[bucketOfRow(campaign)] += 1;
  return counts;
}

const ORDER: Record<Bucket, number> = { needsYou: 0, decide: 1, ready: 2, working: 3, done: 4 };

/** The groups Home and the Campaigns list read in, in order, with the one word each is called by. */
export const BUCKETS: readonly Bucket[] = ["needsYou", "decide", "ready", "working", "done"];

export function groupLabelOf(bucket: Bucket): string {
  const c = campaignsCopy;
  return { needsYou: c.groupNeedsYou, decide: c.groupDecide, ready: c.groupReady, working: c.groupWorking, done: c.groupDone }[bucket];
}

/** The header's count words, by group: "1 needs you · 2 to decide · 1 working". Only the groups with something in them. */
export function countsLineOf(counts: BucketCounts): string {
  const c = campaignsCopy;
  const words: Record<Bucket, string> = { needsYou: c.bucketNeedsYou, decide: c.bucketDecide, ready: c.bucketReady, working: c.bucketWorking, done: c.bucketDone };
  return BUCKETS.filter((bucket) => counts[bucket] > 0)
    .map((bucket) => `${counts[bucket]} ${words[bucket]}`)
    .join(c.noteJoin);
}

/**
 * What every campaign in the list has cost so far, each kind in its own unit
 * and never added together: "Spent so far: 21 search credits · 5 reveal
 * credits · $16.03 research". Null while nothing has been spent, so the
 * header never carries a zero.
 */
export function listSpendLineOf(campaigns: readonly Pick<CampaignSummary, "facts">[]): string | null {
  const c = campaignsCopy;
  let search = 0;
  let reveal = 0;
  let research = 0;
  for (const campaign of campaigns) {
    const spend = campaign.facts?.spend;
    if (spend === undefined) continue;
    search += spend.allVersions.searchCharged;
    reveal += spend.allVersions.revealCharged;
    research += spend.research.usd ?? 0;
  }
  const parts = [
    ...(search > 0 ? [`${search} ${c.listSpendSearch}`] : []),
    ...(reveal > 0 ? [`${reveal} ${c.listSpendReveal}`] : []),
    ...(research > 0 ? [`${usd(research)} ${c.listSpendResearch}`] : []),
  ];
  return parts.length === 0 ? null : `${c.listSpendLead} ${parts.join(c.noteJoin)}`;
}

/** The list's order: what needs the rep first, then what is theirs to decide, then what is ready, then what Relay is doing, then done; newest first within each. */
export function sortForList<T extends Pick<CampaignSummary, "facts" | "state">>(campaigns: readonly T[]): T[] {
  const when = (campaign: T) => campaign.facts?.createdAt ?? "";
  return [...campaigns].sort((a, b) => ORDER[bucketOfRow(a)] - ORDER[bucketOfRow(b)] || when(b).localeCompare(when(a)));
}
