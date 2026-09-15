import { campaignsCopy } from "@/lib/copy/campaigns";

import { chipFor, failureLine, type CampaignState } from "./state";
import type { ActivityView, PeopleFoundView, ResearchFailure, StageSummary } from "./types";

/**
 * Where a campaign is, in one line the list, Home and the campaign page all
 * read (product-truth pass).
 *
 * Built from the same derived state and counts as everything else, so the
 * three screens say the same thing. Every line is what Relay actually has:
 * a queued job says "waiting to start", never "reading"; a plan says how many
 * plays research wrote; people say how many are kept and how many still need
 * a decision. Nothing downstream of what exists is drawn as a number.
 *
 * Client-safe: copy and words only, no schema.
 */

export type SummaryInput = {
  state: CampaignState;
  live: boolean;
  activity: ActivityView | null;
  /** How many plays research wrote, and the name of the one it ranks first. */
  plays: number;
  startWith: string | null;
  peopleFound: Pick<PeopleFoundView, "found" | "accounts" | "review" | "revealPlan" | "revealResult" | "spare"> | null;
  failure: ResearchFailure | null;
  peopleReason: string | null;
  widenings: number;
};

const NEEDS_YOU: CampaignState[] = ["failed", "stopped", "planIncomplete", "peopleNeedsYou"];
const WORKING: CampaignState[] = ["brief", "researching", "findingPeople", "revealing", "drafting", "running", "paused"];

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function stageSummaryFor(input: SummaryInput): StageSummary {
  const c = campaignsCopy;
  const waiting = input.activity?.phase === "waiting";
  const bucket: StageSummary["bucket"] = NEEDS_YOU.includes(input.state)
    ? "needsYou"
    : WORKING.includes(input.state)
      ? "working"
      : input.state === "planReady" || input.state === "peopleFound"
        ? "decide"
        : input.state === "peopleReady"
          ? "ready"
          : "done";

  const base: StageSummary = { stage: chipFor(input.state), line: null, bucket, reason: null, waiting };
  const p = input.peopleFound;

  switch (input.state) {
    case "brief":
    case "researching":
      return { ...base, line: waiting ? c.summaryWaiting : c.summaryResearching };
    case "failed":
      return { ...base, line: failureLine(input.failure), reason: failureLine(input.failure) };
    case "stopped":
      return {
        ...base,
        line: input.widenings > 0 ? `${c.stopBanner} ${input.widenings} ${input.widenings === 1 ? c.summaryWidenOne : c.summaryWidenMany}` : c.stopBanner,
        reason: c.stopBanner,
      };
    case "planIncomplete":
      return { ...base, stage: c.chipPlanIncomplete, line: c.playsNoPlay, reason: c.playsNoPlay };
    case "planReady": {
      const plays = input.plays > 0 ? plural(input.plays, c.summaryPlay, c.summaryPlays) : null;
      const start = input.startWith === null ? null : `${c.summaryStartWith} ${input.startWith}`;
      return { ...base, line: [plays, start].filter((part) => part !== null).join(c.noteJoin) || null };
    }
    case "findingPeople":
      return { ...base, line: waiting ? c.summaryWaiting : c.summaryFinding };
    case "peopleNeedsYou":
      return { ...base, line: input.peopleReason, reason: input.peopleReason };
    case "peopleFound": {
      if (p === null) return base;
      const parts = [
        `${plural(p.found.n, c.summaryPerson, c.summaryPeople)} ${c.summaryAt} ${plural(p.accounts.length, c.summaryAccount, c.summaryAccounts)}`,
        `${p.review.kept} ${c.summaryKept}`,
        `${p.review.pending} ${c.summaryToReview}`,
        ...(p.revealPlan !== null && p.revealPlan.kept > 0 ? [`${c.summaryRevealUpTo} ${p.revealPlan.maxCredits} ${c.summaryCredits}`] : []),
      ];
      return { ...base, line: parts.join(c.noteJoin) };
    }
    case "revealing":
      return { ...base, line: waiting ? c.summaryWaiting : c.summaryRevealing };
    case "peopleReady": {
      const result = p?.revealResult ?? null;
      if (result === null) return base;
      const ready = result.tally.revealed + result.tally.known;
      const without = result.tally.no_email + result.tally.suppressed + result.tally.held + result.tally.failed;
      const parts = [`${ready} ${c.summaryEmailsReady}`, `${without} ${c.summaryNoEmail}`, ...(result.notKept > 0 ? [`${result.notKept} ${c.summaryNotKept}`] : [])];
      return { ...base, line: parts.join(c.noteJoin) };
    }
    case "drafting":
    case "running":
    case "paused":
    case "done":
      return base;
  }
}
