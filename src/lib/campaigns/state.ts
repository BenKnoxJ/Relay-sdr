import { campaignsCopy } from "@/lib/copy/campaigns";

import type { AskAnswer, CampaignSpendView, ResearchFailure } from "./types";

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
 * `peopleFound` and `peopleNeedsYou` are Finding people with a result, and
 * with a reason for the rep (lead gen v2.1 §11). None adds a step to the
 * line; each marks one.
 */
export type CampaignState = CampaignStep | "stopped" | "failed" | "paused" | "peopleFound" | "peopleNeedsYou" | "revealing" | "peopleReady";

/** The chip's one word. Total over the states, so a new one cannot fall through. */
export function chipFor(state: CampaignState): string {
  const words: Record<CampaignState, string> = {
    brief: campaignsCopy.chipResearching,
    researching: campaignsCopy.chipResearching,
    stopped: campaignsCopy.chipStopped,
    failed: campaignsCopy.chipNeedsYou,
    planReady: campaignsCopy.chipPlanReady,
    findingPeople: campaignsCopy.chipFindingPeople,
    peopleFound: campaignsCopy.chipPeopleFound,
    peopleNeedsYou: campaignsCopy.chipNeedsYou,
    revealing: campaignsCopy.chipRevealing,
    peopleReady: campaignsCopy.chipPeopleReady,
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
  if (state === "peopleFound" || state === "peopleNeedsYou" || state === "revealing" || state === "peopleReady") return CAMPAIGN_STEPS.indexOf("findingPeople");
  return CAMPAIGN_STEPS.indexOf(state);
}

export type CampaignAction = {
  kind: "confirm" | "pause" | "resume" | "widen" | "retry" | "reveal" | "retryPeople" | "retryReveal" | "outreach";
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
export function actionFor(
  state: CampaignState,
  live = false,
  retryable = false,
  people: { confirm?: boolean; retryPeople?: boolean; reveal?: boolean; revealBlocked?: string; retryReveal?: boolean } = {},
): CampaignAction | null {
  if (live) {
    if (state === "planReady") {
      // Pressable only where finding people is set up; never a sample standing in for it.
      return people.confirm === true
        ? { kind: "confirm", label: campaignsCopy.actionConfirm, next: "findingPeople", note: campaignsCopy.confirmNote }
        : { kind: "confirm", label: campaignsCopy.actionConfirm, next: "findingPeople", disabled: true, note: campaignsCopy.confirmLater };
    }
    if (state === "failed" && retryable) return { kind: "retry", label: campaignsCopy.actionTryAgain, next: "researching" };
    // The second spend approval: it opens the figures to confirm, and only once somebody kept has an email to reveal or reuse.
    if (state === "peopleFound") {
      return people.reveal === true
        ? { kind: "reveal", label: campaignsCopy.actionReveal, next: "revealing", note: campaignsCopy.revealNote }
        : { kind: "reveal", label: campaignsCopy.actionReveal, next: "revealing", disabled: true, note: people.revealBlocked ?? campaignsCopy.revealKeepFirst };
    }
    // A reveal that failed before any request left Relay: the same job back on the queue.
    if (state === "revealing" && people.retryReveal === true) return { kind: "retryReveal", label: campaignsCopy.actionTryAgain, next: "revealing" };
    // Outreach is next and not built: drawn, never pressable.
    if (state === "peopleReady") return { kind: "outreach", label: campaignsCopy.actionWriteEmails, next: "peopleReady", disabled: true, note: campaignsCopy.outreachLater };
    if (state === "peopleNeedsYou" && people.retryPeople === true) return { kind: "retryPeople", label: campaignsCopy.actionTryAgain, next: "findingPeople" };
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
  /** Why finding people needs the rep, in words (lead gen v2.1 §11). */
  peopleReason?: string;
  /** What the campaign has cost, every brief version, each kind apart. */
  spend?: CampaignSpendView;
  /** Set when revealing emails stopped and needs the rep: why, in words. */
  revealStopped?: string;
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
    case "no_play":
      return campaignsCopy.failedNoPlay;
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
      return { next: live ? campaignsCopy.nextFindingPeopleLive : campaignsCopy.nextFindingPeople, nextIsAction: false };
    case "peopleFound":
      return { next: campaignsCopy.nextPeopleFound, nextIsAction: false };
    case "peopleNeedsYou":
      return { next: campaignsCopy.nextPeopleNeedsYou, nextIsAction: true };
    case "revealing":
      return { next: campaignsCopy.nextRevealing, nextIsAction: false };
    case "peopleReady":
      return { next: campaignsCopy.nextPeopleReady, nextIsAction: false };
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
    counts.revealStopped !== undefined
      ? c.answerWaitingRevealStopped
      : state === "peopleNeedsYou"
      ? c.answerWaitingPeopleNeedsYou
      : state === "revealing"
        ? c.answerWaitingRevealing
        : state === "peopleReady"
          ? c.answerWaitingPeopleReady
          : state === "peopleFound"
        ? c.answerWaitingPeopleFound
        : state === "findingPeople" && live
          ? c.answerWaitingFinding
          : state === "failed"
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
    counts.spend !== undefined
      ? costLine(counts.spend)
      : counts.credits === null
      ? c.answerCostNoCredits
      : counts.credits.used === 0
        ? c.answerCostNothing
        : `${counts.credits.used} ${c.answerCostUsed} ${counts.credits.left} ${c.answerCostLeft}`;

  const why =
    counts.revealStopped !== undefined
      ? counts.revealStopped
      : state === "paused"
      ? c.answerPaused
      : state === "stopped"
        ? c.answerStopped
        : state === "failed"
          ? failureLine(counts.failure)
          : state === "peopleNeedsYou"
            ? (counts.peopleReason ?? c.haltFailed)
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

/** Why finding people needs the rep, in words, from the halt reason and the term it names (lead gen v2.1 §11). */
export function haltLine(reason: string, term?: string | null): string {
  const c = campaignsCopy;
  const withTerm = (line: string) => (term === undefined || term === null ? line : `${line} ${term}`);
  switch (reason) {
    case "no_candidates":
      return c.haltNoCandidates;
    case "unmappable":
      return withTerm(c.haltUnmappable);
    case "would_widen":
      return c.haltWouldWiden;
    case "choose_industry":
      return withTerm(c.haltChooseIndustry);
    case "over_cap":
      return c.haltOverCap;
    case "balance_unavailable":
      return c.haltBalance;
    case "provider_busy":
      return c.haltBusy;
    case "took_too_long":
      return c.haltTooLong;
    default:
      return c.haltFailed;
  }
}

/** Why revealing emails stopped, in words, by what Relay knows about its spend (product-truth foundation). */
export function revealStoppedLine(reason: string | undefined | null): string {
  switch (reason) {
    case "reveal_failed":
      return campaignsCopy.revealStoppedRetry;
    case "reveal_spend_unresolved":
      return campaignsCopy.revealStoppedHeld;
    case "reveal_failed_terminal":
      return campaignsCopy.revealStoppedFailed;
    default:
      return campaignsCopy.revealStopped;
  }
}

/**
 * "What has this cost?", for a stored campaign: every brief version it has
 * had, search and reveal credits apart, what is left under this version's
 * search limit, and anything still held. Credits only; research's model cost
 * is in dollars and is never added to them.
 */
export function costLine(spend: CampaignSpendView): string {
  const c = campaignsCopy;
  const all = spend.allVersions;
  const held = all.searchHeld + all.revealHeld;
  if (all.searchCharged + all.revealCharged + held === 0) return spend.search.cap === null ? c.answerCostNoCredits : c.answerCostNothing;
  const used = [`${all.searchCharged} ${c.answerCostSearch}`, ...(all.revealCharged + all.revealHeld > 0 ? [`${all.revealCharged} ${c.answerCostReveal}`] : [])].join(` ${c.answerCostAnd} `);
  const left = spend.search.cap === null ? [] : [`${Math.max(0, spend.search.cap - spend.search.charged - spend.search.held)} ${c.answerCostLeftUnder}`];
  return [`${used}.`, ...left, ...(held > 0 ? [`${held} ${c.answerCostHeld}`] : [])].join(" ");
}
