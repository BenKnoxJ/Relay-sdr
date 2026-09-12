import { campaignsCopy } from "@/lib/copy/campaigns";

import type { AskAnswer, ResearchFailure } from "./types";

export type { AskAnswer } from "./types";

/**
 * Where a campaign is, and what that is called on screen (master doc §23.1c,
 * orchestrator §5 as amended by A1).
 *
 * Separate from anything that parses the research pack for one reason, and it
 * is a shipping one rather than a tidiness one: the campaign page and Start
 * are client components, and anything they import at run time is downloaded
 * by a browser. The steps and the chip words are the only part a client
 * component actually needs, so they live here where importing them costs a
 * string table.
 *
 * Everything here is derived from a campaign's state and its counts, and
 * nothing here holds any: the chip word, the step, the one action, the "next"
 * line and the six answers are all functions of what the caller already has.
 */

/** The seven signed steps, in order. */
export const CAMPAIGN_STEPS = [
  "brief",
  "researching",
  "planReady",
  "findingPeople",
  "drafting",
  "running",
  "done",
] as const;

export type CampaignStep = (typeof CAMPAIGN_STEPS)[number];

/**
 * `stopped` is Researching that gave up (§23.1c), `failed` is Researching that
 * did not finish and needs the rep, and `paused` is any running state held.
 * None of the three adds a step to the line; each marks one.
 */
export type CampaignState = CampaignStep | "stopped" | "failed" | "paused";

/** The chip's one word. Total over the states, so a new one cannot fall through. */
export function chipFor(state: CampaignState): string {
  const words: Record<CampaignState, string> = {
    brief: campaignsCopy.chipResearching,
    researching: campaignsCopy.chipResearching,
    stopped: campaignsCopy.chipStopped,
    failed: campaignsCopy.chipNeedsYou,
    planReady: campaignsCopy.chipPlanReady,
    findingPeople: campaignsCopy.chipFindingPeople,
    drafting: campaignsCopy.chipDrafting,
    running: campaignsCopy.chipRunning,
    paused: campaignsCopy.chipPaused,
    done: campaignsCopy.chipDone,
  };
  return words[state];
}

/** Where on the seven-step line a state sits. `stopped` and `failed` mark Researching. */
export function stepIndexFor(state: CampaignState): number {
  if (state === "stopped" || state === "failed") return CAMPAIGN_STEPS.indexOf("researching");
  if (state === "paused") return CAMPAIGN_STEPS.indexOf("running");
  return CAMPAIGN_STEPS.indexOf(state);
}

export type CampaignAction = {
  kind: "confirm" | "pause" | "resume" | "widen" | "retry";
  label: string;
  next: CampaignState;
  disabled?: boolean;
  note?: string;
};

/**
 * The header's one action for a state, and what it moves to. Null for the rest.
 *
 * A live campaign offers only what is built. Confirm plan is drawn but cannot
 * be pressed, because what it starts (finding people) does not exist yet. Try
 * again is the header's action when research itself failed (`retryable`); a
 * stop's action is on the option the rep chooses, in the stop's own card, so
 * the header carries none. A sample campaign keeps every signed action,
 * because the component tests that draw the later states need them.
 */
export function actionFor(state: CampaignState, live = false, retryable = false): CampaignAction | null {
  if (live) {
    if (state === "planReady") {
      return { kind: "confirm", label: campaignsCopy.actionConfirm, next: "findingPeople", disabled: true, note: campaignsCopy.confirmLater };
    }
    if (state === "failed" && retryable) return { kind: "retry", label: campaignsCopy.actionTryAgain, next: "researching" };
    return null;
  }
  switch (state) {
    case "planReady":
      return { kind: "confirm", label: campaignsCopy.actionConfirm, next: "findingPeople" };
    case "running":
      return { kind: "pause", label: campaignsCopy.actionPause, next: "paused" };
    case "paused":
      return { kind: "resume", label: campaignsCopy.actionResume, next: "running" };
    case "stopped":
      return { kind: "widen", label: campaignsCopy.actionWiden, next: "researching" };
    default:
      return null;
  }
}

/**
 * The counts a "next" line and an answer are computed from.
 *
 * A structural type rather than the `Campaign` it is read off, so this module
 * stays free of the research contract. A null count is one that does not exist
 * yet (nobody has been found, no credit spent), and is answered in words
 * rather than as a zero that would read like work done.
 */
export type CampaignCounts = {
  progress: { found: number; drafted: number; approved: number; sent: number; replied: number } | null;
  outcomes: { warm: number; meetings: number } | null;
  draftsDueToday: number;
  nextBatch: { day: string; time: string } | null;
  credits: { used: number; left: number } | null;
  live?: boolean;
  failure?: ResearchFailure | null;
  /** Research itself failed, so Try again is offered (orchestrator A1, item 6). */
  retryable?: boolean;
};

/** The line that says why research did not finish (orchestrator §7, amended A1). */
export function failureLine(failure: ResearchFailure | null | undefined): string {
  switch (failure) {
    case "took_too_long":
      return campaignsCopy.failedTookTooLong;
    case "bad_output":
      return campaignsCopy.failedBadOutput;
    case "not_started":
      return campaignsCopy.failedNotStarted;
    default:
      return campaignsCopy.failedOther;
  }
}

/**
 * The row's "next" line, which §23.1c requires to be the same sentence as the
 * page's action. Only the states that carry an action read in the accent; the
 * rest are a statement of where the campaign is.
 */
export function nextFor(
  state: CampaignState,
  counts: CampaignCounts,
): { next: string; nextIsAction: boolean } {
  const live = counts.live === true;
  switch (state) {
    case "brief":
    case "researching":
      return { next: campaignsCopy.nextResearching, nextIsAction: false };
    case "failed":
      return { next: campaignsCopy.nextFailed, nextIsAction: true };
    case "stopped":
      return { next: campaignsCopy.nextStopped, nextIsAction: true };
    case "planReady":
      return live
        ? { next: campaignsCopy.nextPlanReadyLive, nextIsAction: false }
        : { next: campaignsCopy.nextPlanReady, nextIsAction: true };
    case "findingPeople":
      // Not in the accent, and deliberately: the action that answers this line
      // is on Your people (§23.1e), which is its own task. A row that read as a
      // call to action would be one the campaign page cannot honour.
      return { next: campaignsCopy.nextFindingPeople, nextIsAction: false };
    case "drafting":
      return { next: campaignsCopy.nextDrafting, nextIsAction: false };
    case "paused":
      return { next: campaignsCopy.nextPaused, nextIsAction: true };
    case "running":
      return counts.draftsDueToday > 0
        ? { next: `${counts.draftsDueToday} ${campaignsCopy.nextRunningDrafts}`, nextIsAction: false }
        : { next: campaignsCopy.nextRunningQuiet, nextIsAction: false };
    case "done":
      return {
        next: `${counts.outcomes?.warm ?? 0} ${campaignsCopy.doneWarm}${campaignsCopy.noteJoin}${counts.outcomes?.meetings ?? 0} ${campaignsCopy.doneMeetings}`,
        nextIsAction: false,
      };
  }
}

/**
 * The six fixed questions (orchestrator §8), answered from counts and state.
 *
 * Every answer is assembled from the caller's numbers and the copy file's
 * fragments, so nothing a rep reads here is written anywhere but
 * `src/lib/copy/campaigns.ts`. The model's job later is to phrase these; §8
 * says it never computes them, which is why computing them without one is
 * honest rather than a stand-in.
 *
 * It takes the state as an argument rather than reading it off the campaign,
 * because the campaign page moves between states without the campaign
 * changing, and an answer that lagged the screen would be worse than none.
 */
export function answersFor(state: CampaignState, counts: CampaignCounts): AskAnswer[] {
  const c = campaignsCopy;
  const p = counts.progress;
  const live = counts.live === true;

  const going =
    p === null
      ? c.answerNothingFound
      : p.found === 0
        ? c.answerNothingYet
        : `${p.sent} ${c.answerSent}, ${p.replied} ${c.answerReplied}. ${p.drafted} ${c.answerDrafted} ${c.of} ${p.found} ${c.answerFound}.`;

  const waiting =
    state === "failed"
      ? counts.retryable === true
        ? c.answerWaitingFailed
        : c.answerWaitingFailedEdit
      : state === "planReady"
        ? live
          ? c.answerWaitingPlanLive
          : c.answerWaitingConfirm
        : state === "stopped"
          ? c.answerWaitingWiden
          : counts.draftsDueToday > 0 && state !== "paused"
            ? `${counts.draftsDueToday} ${c.answerWaitingDrafts}`
            : c.answerWaitingNothing;

  const replies =
    p === null || p.replied === 0
      ? c.answerRepliesNone
      : `${p.replied} ${c.answerRepliesLead} ${counts.outcomes?.warm ?? 0} ${c.answerRepliesWarm}${c.noteJoin}${counts.outcomes?.meetings ?? 0} ${c.answerRepliesMeetings}.`;

  const batch =
    counts.nextBatch === null || state === "paused"
      ? c.answerBatchNone
      : `${c.answerBatchLead} ${counts.nextBatch.day} ${c.answerBatchAt} ${counts.nextBatch.time}.`;

  const cost =
    counts.credits === null
      ? c.answerCostNoCredits
      : counts.credits.used === 0
        ? c.answerCostNothing
        : `${counts.credits.used} ${c.answerCostUsed} ${counts.credits.left} ${c.answerCostLeft}`;

  const why =
    state === "paused"
      ? c.answerPaused
      : state === "stopped"
        ? c.answerStopped
        : state === "failed"
          ? failureLine(counts.failure)
          : c.answerStoppedNone;

  return [
    { id: "how-going", question: c.askHowGoing, answer: going },
    { id: "waiting", question: c.askWaiting, answer: waiting },
    { id: "replies", question: c.askReplies, answer: replies },
    { id: "next-batch", question: c.askNextBatch, answer: batch },
    { id: "cost", question: c.askCost, answer: cost },
    { id: "why-stopped", question: c.askWhyStopped, answer: why },
  ];
}
