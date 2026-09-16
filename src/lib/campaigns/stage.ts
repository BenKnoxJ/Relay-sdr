import type { Halt } from "../../../agents/leadgen/output.schema";

import { failureOf } from "./derive";
import { editAllowed, inFlight, leadGenRetryable, researchRetryable, revealRecovery, type JobFacts, type LedgerCounts } from "./retry";
import type { CampaignState } from "./state";
import type { CampaignNextAction, CampaignStage, CampaignStageAttention, InFlightWork, PeopleReason, ResearchActions, ResearchFailure, RevealStopReason } from "./types";

/**
 * Where a campaign is, what the rep can do about it, and what the server will
 * accept: one derivation, read by the campaign page and by the Home and
 * Campaigns summaries (product-truth foundation, 2026-09-15).
 *
 * It reads facts, not rows. The campaign page builds them from the whole
 * record it already loads; a summary builds them from a few small queries
 * (`src/lib/repo/campaignSummary.ts`). Either way the same rules decide.
 *
 * | research result          | confirmed | lead gen            | reveal                   | stage              |
 * |--------------------------|-----------|---------------------|--------------------------|--------------------|
 * | none, job queued/running | –         | –                   | –                        | researching        |
 * | none, no job / ended     | –         | –                   | –                        | research_needs_you |
 * | unreadable               | –         | –                   | –                        | research_needs_you |
 * | insufficient             | –         | –                   | –                        | research_stopped   |
 * | no play can be searched  | –         | –                   | –                        | research_needs_you |
 * | a play can be searched   | no        | –                   | –                        | plan_ready         |
 * |                          | yes       | job queued/running  | –                        | finding_people     |
 * |                          | yes       | halted / ended      | –                        | people_needs_you   |
 * |                          | yes       | picked              | not pressed              | reviewing_people   |
 * |                          | yes       | picked              | job queued/running       | revealing          |
 * |                          | yes       | picked              | ended with no result     | reveal_needs_you   |
 * |                          | yes       | picked              | result                   | people_ready       |
 */

type Job = Pick<JobFacts, "status" | "error"> | null;

export type ResearchResultFacts =
  | { readable: false }
  | { readable: true; outcome: "insufficient"; usableWidenings: number }
  | { readable: true; outcome: "complete" | "partial"; executablePlays: number };

export type LeadGenResult = { kind: "picked" } | { kind: "halted"; reason: Halt["reason"]; choices: number } | { kind: "unreadable" };

export type StageInput = {
  research: { job: Job; result: ResearchResultFacts | null };
  /** A Confirm exists at the current brief version. */
  confirmed: boolean;
  /** The latest search at the current version, once confirmed. */
  leadGen: { job: Job; result: LeadGenResult | null } | null;
  /** The reveal for the latest search, once Reveal emails was pressed. */
  reveal: { job: Job; hasResult: boolean; ledger: LedgerCounts } | null;
  /** What Reveal emails would do for the kept people; null where it is not worked out (a summary). */
  revealPlan: { kept: number; toReveal: number; known: number } | null;
  /** Finding people is set up here, so Confirm and Reveal can be pressed. */
  leadGenAvailable: boolean;
};

export type CampaignActions = Required<ResearchActions>;

export type StageResult = CampaignStageAttention & {
  /** The stage and its attention alone, still paired, for a caller that copies them on. */
  stageAttention: CampaignStageAttention;
  /** The screen vocabulary the campaign page draws (`CampaignState`). A stopped reveal draws as revealing, with its own chip and line. */
  state: CampaignState;
  inFlight: InFlightWork | null;
  nextAction: CampaignNextAction | null;
  failure: ResearchFailure | null;
  /** Finding people's reason for needing the rep, when it does. */
  peopleReason: PeopleReason | null;
  can: CampaignActions;
};

const STATE: Record<CampaignStage, CampaignState> = {
  researching: "researching",
  research_needs_you: "failed",
  research_stopped: "stopped",
  plan_ready: "planReady",
  finding_people: "findingPeople",
  people_needs_you: "peopleNeedsYou",
  reviewing_people: "peopleFound",
  revealing: "revealing",
  reveal_needs_you: "revealing",
  people_ready: "peopleReady",
};

const running = (job: Job): InFlightWork["status"] => (job?.status === "running" ? "running" : "queued");

export function deriveStage(input: StageInput): StageResult {
  const { job: researchJob, result: researchResult } = input.research;
  const retry = researchRetryable(researchJob, researchResult !== null);
  let stage: CampaignStage;
  let failure: ResearchFailure | null = null;
  let flight: InFlightWork | null = null;
  let usableWidenings = 0;

  if (researchResult === null) {
    if (researchJob === null) {
      stage = "research_needs_you";
      failure = "not_started";
    } else if (inFlight(researchJob)) {
      stage = "researching";
      flight = { kind: "research", status: running(researchJob) };
    } else {
      stage = "research_needs_you";
      // Done with no result is a handler that returned without recording a pack.
      failure = researchJob.status === "done" ? "bad_output" : failureOf(researchJob.error);
    }
  } else if (!researchResult.readable) {
    stage = "research_needs_you";
    failure = "bad_output";
  } else if (researchResult.outcome === "insufficient") {
    stage = "research_stopped";
    usableWidenings = researchResult.usableWidenings;
  } else if (researchResult.executablePlays === 0) {
    stage = "research_needs_you";
    failure = "no_play";
  } else {
    stage = "plan_ready";
  }

  let peopleReason: PeopleReason | null = null;
  let peopleRetry = false;
  let choosable = false;
  let revealRetry = false;
  let revealReason: RevealStopReason | null = null;

  const leadGen = stage === "plan_ready" && input.confirmed ? input.leadGen : null;
  if (leadGen !== null) {
    const result = leadGen.result;
    if (result?.kind === "picked") {
      stage = "reviewing_people";
      const reveal = input.reveal;
      if (reveal !== null) {
        if (reveal.hasResult) {
          stage = "people_ready";
        } else if (inFlight(reveal.job)) {
          stage = "revealing";
          flight = { kind: "reveal", status: running(reveal.job) };
        } else {
          const recovery = revealRecovery(reveal.job, reveal.ledger);
          stage = "reveal_needs_you";
          revealRetry = recovery.retryable;
          revealReason = `reveal_${recovery.reason}`;
        }
      }
    } else if (result?.kind === "halted") {
      stage = "people_needs_you";
      peopleReason = result.reason;
      peopleRetry = leadGenRetryable(leadGen.job, result);
      choosable = result.reason === "choose_industry" && result.choices > 0;
    } else if (result?.kind === "unreadable") {
      stage = "people_needs_you";
      peopleReason = "failed";
    } else if (leadGen.job !== null && inFlight(leadGen.job)) {
      stage = "finding_people";
      flight = { kind: "lead_gen", status: running(leadGen.job) };
    } else {
      stage = "people_needs_you";
      peopleReason = leadGen.job !== null && leadGen.job.status !== "done" && failureOf(leadGen.job.error) === "took_too_long" ? "took_too_long" : "failed";
      peopleRetry = leadGenRetryable(leadGen.job, null);
    }
  }

  const plan = input.revealPlan;
  const can: CampaignActions = {
    widen: stage === "research_stopped" && usableWidenings > 0,
    edit: editAllowed({ researchInFlight: stage === "researching", leadGenInFlight: stage === "finding_people", revealInFlight: stage === "revealing" }),
    retry: stage === "research_needs_you" && retry,
    confirm: stage === "plan_ready" && input.leadGenAvailable,
    retryPeople: stage === "people_needs_you" && peopleRetry,
    chooseIndustry: stage === "people_needs_you" && choosable,
    review: stage === "reviewing_people",
    reveal: stage === "reviewing_people" && input.leadGenAvailable && plan !== null && plan.kept > 0 && plan.toReveal + plan.known > 0,
    retryReveal: stage === "reveal_needs_you" && revealRetry,
  };

  const stageAttention = attentionOf(stage, { failure, peopleReason, revealReason }, can);
  return { ...stageAttention, stageAttention, state: STATE[stage], inFlight: flight, nextAction: nextActionOf(stage, can), failure, peopleReason, can };
}

/** The stage with what it needs from the rep, if anything: each stage carries only its own reasons. */
function attentionOf(
  stage: CampaignStage,
  reasons: { failure: ResearchFailure | null; peopleReason: PeopleReason | null; revealReason: RevealStopReason | null },
  can: CampaignActions,
): CampaignStageAttention {
  switch (stage) {
    case "research_needs_you":
      return { stage, attention: { kind: "needs_you", reason: reasons.failure ?? "failed", retryable: can.retry } };
    case "research_stopped":
      return { stage, attention: { kind: "stopped", reason: "insufficient", retryable: false } };
    case "people_needs_you":
      return { stage, attention: { kind: "needs_you", reason: reasons.peopleReason ?? "failed", retryable: can.retryPeople } };
    case "reveal_needs_you":
      return { stage, attention: { kind: "needs_you", reason: reasons.revealReason ?? "reveal_stopped", retryable: can.retryReveal } };
    default:
      return { stage, attention: null };
  }
}

function nextActionOf(stage: CampaignStage, can: CampaignActions): CampaignNextAction | null {
  switch (stage) {
    case "research_needs_you":
      return can.retry ? "retry_research" : can.edit ? "edit_brief" : null;
    case "research_stopped":
      return can.widen ? "widen" : can.edit ? "edit_brief" : null;
    case "plan_ready":
      return can.confirm ? "confirm" : null;
    case "people_needs_you":
      return can.retryPeople ? "retry_people" : can.chooseIndustry ? "choose_industry" : can.edit ? "edit_brief" : null;
    case "reviewing_people":
      return "review_people";
    case "reveal_needs_you":
      return can.retryReveal ? "retry_reveal" : can.edit ? "edit_brief" : null;
    case "researching":
    case "finding_people":
    case "revealing":
    case "people_ready":
      return null;
  }
}

/** Campaigns the rep needs to act on, and campaigns Relay is still working on or waiting to be told to go on. */
export function isAttention(stage: CampaignStage): boolean {
  return stage === "research_needs_you" || stage === "research_stopped" || stage === "people_needs_you" || stage === "reveal_needs_you";
}
