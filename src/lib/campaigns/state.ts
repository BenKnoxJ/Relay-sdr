import { campaignsCopy } from "@/lib/copy/campaigns";

/**
 * Where a campaign is, and what that is called on screen (master doc §23.1c,
 * orchestrator §5).
 *
 * Separate from `src/lib/fixtures/campaigns.ts` for one reason, and it is a
 * shipping one rather than a tidiness one: the fixtures module parses the
 * research pack, so it pulls zod and the whole pack fixture in with it. The
 * campaign page and Start are client components, and anything they import at
 * run time is downloaded by a browser. The steps and the chip words are the
 * only part of that module a client component actually needs, so they live
 * here where importing them costs a string table.
 *
 * The states outlive the fixtures. A tRPC-backed adapter replaces the fixtures
 * module and imports this one unchanged.
 *
 * Everything here is derived from a campaign's state and its counts, and
 * nothing here holds any: the chip word, the step, the one action, the "next"
 * line and the six answers are all functions of what the caller already has.
 * That is what lets the campaign page recompute them when its own state moves
 * without asking the adapter for a campaign that has not changed.
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
 * `stopped` is Researching that gave up (§23.1c) and `paused` is any running
 * state held; both mark a step on the line rather than adding one to it.
 */
export type CampaignState = CampaignStep | "stopped" | "paused";

/** The chip's one word. Total over the states, so a new one cannot fall through. */
export function chipFor(state: CampaignState): string {
  const words: Record<CampaignState, string> = {
    brief: campaignsCopy.chipResearching,
    researching: campaignsCopy.chipResearching,
    stopped: campaignsCopy.chipStopped,
    planReady: campaignsCopy.chipPlanReady,
    findingPeople: campaignsCopy.chipFindingPeople,
    drafting: campaignsCopy.chipDrafting,
    running: campaignsCopy.chipRunning,
    paused: campaignsCopy.chipPaused,
    done: campaignsCopy.chipDone,
  };
  return words[state];
}

/** Where on the seven-step line a state sits. `stopped` marks Researching. */
export function stepIndexFor(state: CampaignState): number {
  if (state === "stopped") return CAMPAIGN_STEPS.indexOf("researching");
  if (state === "paused") return CAMPAIGN_STEPS.indexOf("running");
  return CAMPAIGN_STEPS.indexOf(state);
}

/** The one action a state carries, and what it moves to. Null for the rest. */
export function actionFor(state: CampaignState): { label: string; next: CampaignState } | null {
  switch (state) {
    case "planReady":
      return { label: campaignsCopy.actionConfirm, next: "findingPeople" };
    case "running":
      return { label: campaignsCopy.actionPause, next: "paused" };
    case "paused":
      return { label: campaignsCopy.actionResume, next: "running" };
    case "stopped":
      return { label: campaignsCopy.actionWiden, next: "researching" };
    default:
      return null;
  }
}

/**
 * The counts a "next" line and an answer are computed from.
 *
 * A structural type rather than the `Campaign` it is read off, so this module
 * stays free of the fixtures (and of the research contract they parse).
 */
export type CampaignCounts = {
  progress: { found: number; drafted: number; approved: number; sent: number; replied: number };
  outcomes: { warm: number; meetings: number };
  draftsDueToday: number;
  nextBatch: { day: string; time: string } | null;
  credits: { used: number; left: number };
};

/**
 * The row's "next" line, which §23.1c requires to be the same sentence as the
 * page's action. Only the states that carry an action read in the accent; the
 * rest are a statement of where the campaign is.
 */
export function nextFor(
  state: CampaignState,
  counts: CampaignCounts,
): { next: string; nextIsAction: boolean } {
  switch (state) {
    case "brief":
    case "researching":
      return { next: campaignsCopy.nextResearching, nextIsAction: false };
    case "stopped":
      return { next: campaignsCopy.nextStopped, nextIsAction: true };
    case "planReady":
      return { next: campaignsCopy.nextPlanReady, nextIsAction: true };
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
        next: `${counts.outcomes.warm} ${campaignsCopy.doneWarm}${campaignsCopy.noteJoin}${counts.outcomes.meetings} ${campaignsCopy.doneMeetings}`,
        nextIsAction: false,
      };
  }
}

export type AskAnswer = { id: string; question: string; answer: string };

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

  const going =
    p.found === 0
      ? c.answerNothingYet
      : `${p.sent} ${c.answerSent}, ${p.replied} ${c.answerReplied}. ${p.drafted} ${c.answerDrafted} ${c.of} ${p.found} ${c.answerFound}.`;

  const waiting =
    state === "planReady"
      ? c.answerWaitingConfirm
      : state === "stopped"
        ? c.answerWaitingWiden
        : counts.draftsDueToday > 0 && state !== "paused"
          ? `${counts.draftsDueToday} ${c.answerWaitingDrafts}`
          : c.answerWaitingNothing;

  const replies =
    p.replied === 0
      ? c.answerRepliesNone
      : `${p.replied} ${c.answerRepliesLead} ${counts.outcomes.warm} ${c.answerRepliesWarm}${c.noteJoin}${counts.outcomes.meetings} ${c.answerRepliesMeetings}.`;

  const batch =
    counts.nextBatch === null || state === "paused"
      ? c.answerBatchNone
      : `${c.answerBatchLead} ${counts.nextBatch.day} ${c.answerBatchAt} ${counts.nextBatch.time}.`;

  const cost =
    counts.credits.used === 0
      ? c.answerCostNothing
      : `${counts.credits.used} ${c.answerCostUsed} ${counts.credits.left} ${c.answerCostLeft}`;

  const why =
    state === "paused"
      ? c.answerPaused
      : state === "stopped"
        ? c.answerStopped
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
