"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Card } from "@/components/Card";
import { PageHeader } from "@/components/PageHeader";
import { PillButton } from "@/components/PillButton";
import type { ChooseIndustrySubmission, RetrySubmission, RevealSubmission, ReviewSubmission, StartResult, WidenSubmission } from "@/lib/campaigns/start";
import { actionFor, answersFor, revealStoppedLine, type CampaignState } from "@/lib/campaigns/state";
import type { Campaign } from "@/lib/campaigns/types";
import { campaignsCopy } from "@/lib/copy/campaigns";

import { BriefCard } from "./BriefCard";
import { PeopleFound } from "./PeopleFound";
import { PeopleNeedsYou } from "./PeopleNeedsYou";
import { PlanDecision } from "./PlanDecision";
import { PlanSection } from "./PlanCards";
import { ProgressCounts } from "./ProgressCounts";
import { RevealCard } from "./RevealCard";
import { FindingCard, ResearchNeedsYouCard, ResearchingCard, RevealNeedsYouCard } from "./StageNotes";
import { StageSummary } from "./StageSummary";
import { StateRow } from "./StateRow";
import { SupportRail } from "./SupportRail";
import { WidenCard } from "./WidenCard";

/**
 * The campaign page (§23.1c), state-led (product-truth pass).
 *
 * Three things are constant: the header (name, the steps, ONE action matching
 * the state), the stage summary under it (the same words as the list row and
 * Home), and the support rail (Research, Spend, Brief, Ask as quiet tabs).
 * The main area is the rep's job in this state and nothing else: what
 * research is producing while it reads; the plays to decide between when a
 * plan is ready; the accounts to keep or drop; the emails once revealed. A
 * stage that has passed does not stay stacked on the page; what it left is
 * in the rail.
 *
 * A real campaign (`live`) offers only what is built; the sample campaigns
 * the component tests use keep the signed actions, which change this
 * component's state and nothing else.
 */

export function CampaignPage({
  campaign,
  banner = null,
  onWiden,
  onRetry,
  onConfirm,
  onRetryPeople,
  onChooseIndustry,
  onReview,
  onReveal,
  onRetryReveal,
}: {
  campaign: Campaign;
  /** A line the route arrived with, such as Start's "research has started". */
  banner?: string | null;
  onWiden?: (submission: WidenSubmission) => Promise<StartResult>;
  onRetry?: (submission: RetrySubmission) => Promise<StartResult>;
  /** Confirm plan: the first spend gate (lead gen v2.1 §6), naming the play the rep chose (v2.3). */
  onConfirm?: (submission: RetrySubmission & { candidateId?: string }) => Promise<StartResult>;
  onRetryPeople?: (submission: RetrySubmission) => Promise<StartResult>;
  /** Try again on a reveal that stopped before any request left Relay (a server action). */
  onRetryReveal?: (submission: RetrySubmission) => Promise<StartResult>;
  onChooseIndustry?: (submission: ChooseIndustrySubmission) => Promise<StartResult>;
  onReview?: (submission: ReviewSubmission) => Promise<StartResult>;
  onReveal?: (submission: RevealSubmission) => Promise<StartResult>;
}) {
  const router = useRouter();
  const [state, setState] = useState<CampaignState>(campaign.state);
  const [toast, setToast] = useState<string | null>(banner);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [requestId] = useState(() => crypto.randomUUID());
  const live = campaign.live;
  const target = { campaignId: campaign.id, briefVersion: campaign.briefVersion };
  const editHref = live && campaign.can.edit ? `/campaigns/${campaign.id}/edit` : undefined;
  const researchHref = live && campaign.overview !== null ? `/campaigns/${campaign.id}/research` : undefined;

  // The backend's stage is the truth the page composes itself around; `state` is the screen vocabulary it maps to.
  const facts = campaign.facts;
  const stage = facts?.stage ?? null;
  const revealNeedsYou = stage === "reveal_needs_you";
  // The play Confirm names: research's recommended one until the rep picks another that can be searched (lead gen v2.3).
  const plays = campaign.plays ?? [];
  const recommendedId = plays.find((play) => play.recommended)?.id ?? null;
  const [candidateId, setCandidateId] = useState<string | null>(recommendedId);

  const [revealOpen, setRevealOpen] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  const revealPlan = campaign.peopleFound?.revealPlan ?? null;
  const action = actionFor(state, live, campaign.can.retry, {
    confirm: campaign.can.confirm === true && onConfirm !== undefined,
    retryPeople: campaign.can.retryPeople === true && onRetryPeople !== undefined,
    reveal: campaign.can.reveal === true && onReveal !== undefined,
    revealBlocked: revealPlan !== null && revealPlan.kept > 0 ? campaignsCopy.revealNothingToReveal : campaignsCopy.revealKeepFirst,
    retryReveal: campaign.can.retryReveal === true && onRetryReveal !== undefined,
  });
  const peopleStates: CampaignState[] = ["peopleFound", "revealing", "peopleReady"];
  const answers = answersFor(state, { ...campaign, retryable: campaign.can.retry });
  const answerTo = (...ids: string[]) =>
    ids
      .map((id) => answers.find((answer) => answer.id === id)?.answer)
      .filter((line) => line !== undefined)
      .join(" ");
  const leadsWithProgress = state === "running" || state === "paused" || state === "done";

  const lookingAgain = (id: string) => {
    router.push(`/campaigns/${id}?again=1`);
    router.refresh();
  };
  const confirmed = (id: string) => {
    router.push(`/campaigns/${id}?confirmed=1`);
    router.refresh();
  };

  const widen =
    live && campaign.can.widen && onWiden !== undefined
      ? async (optionIndex: number): Promise<string | null> => {
          const result = await onWiden({ ...target, optionIndex, requestId });
          if ("error" in result) return result.error;
          lookingAgain(result.id);
          return null;
        }
      : undefined;

  const submit = async (send: ((submission: RetrySubmission) => Promise<StartResult>) | undefined, landed: (id: string) => void = lookingAgain) => {
    if (send === undefined || pending) return;
    setPending(true);
    setActionError(null);
    try {
      const result = await send({ ...target, requestId });
      if ("id" in result) {
        landed(result.id);
        return;
      }
      setActionError(result.error);
    } catch {
      setActionError(campaignsCopy.cannotChange);
    }
    setPending(false);
  };

  const confirmWithPlay = () => submit((submission) => onConfirm!({ ...submission, ...(candidateId === null ? {} : { candidateId }) }), confirmed);

  const review =
    live && campaign.can.review === true && onReview !== undefined
      ? async (personId: string, scope: ReviewSubmission["scope"], decision: ReviewSubmission["decision"]): Promise<string | null> => {
          const result = await onReview({ ...target, personId, scope, decision });
          if ("error" in result) return result.error;
          router.refresh();
          return null;
        }
      : undefined;

  const confirmReveal = async () => {
    if (onReveal === undefined || revealPlan === null || pending) return;
    setPending(true);
    setRevealError(null);
    try {
      const result = await onReveal({ ...target, requestId, expected: { toReveal: revealPlan.toReveal, known: revealPlan.known, maxCredits: revealPlan.maxCredits } });
      if ("id" in result) {
        router.push(`/campaigns/${result.id}?revealing=1`);
        router.refresh();
        return;
      }
      setRevealError(result.error);
    } catch {
      setRevealError(campaignsCopy.cannotChange);
    }
    setPending(false);
  };

  const choose =
    live && campaign.can.chooseIndustry === true && onChooseIndustry !== undefined && campaign.peopleNeedsYou?.term
      ? async (label: string): Promise<string | null> => {
          const result = await onChooseIndustry({ ...target, requestId, term: campaign.peopleNeedsYou!.term!, label });
          if ("error" in result) return result.error;
          lookingAgain(result.id);
          return null;
        }
      : undefined;

  /* The main area: the rep's job in this state, chosen by the backend's stage where there is one. */
  const main: React.ReactNode[] = [];
  if (state === "researching" || state === "brief") {
    main.push(<ResearchingCard key="researching" inFlight={facts?.inFlight} />);
  } else if (state === "failed") {
    main.push(<ResearchNeedsYouCard key="failed" failure={campaign.failure} facts={facts} canRetry={campaign.can.retry} editHref={editHref} researchHref={live && campaign.failure === "no_play" ? `/campaigns/${campaign.id}/research` : undefined} />);
  } else if (state === "stopped" && campaign.pack?.insufficient !== undefined) {
    main.push(<WidenCard key="widen" reason={campaign.pack.insufficient.reason} found={campaign.pack.stopEvidence ?? []} choices={campaign.widenings ?? []} onWiden={widen} />);
  } else if (state === "planReady" && campaign.overview !== null && live) {
    main.push(<PlanDecision key="plan" plays={plays} overview={campaign.overview} confirmPlan={campaign.confirmPlan ?? null} selectedId={candidateId} onSelect={setCandidateId} />);
  } else if (state === "findingPeople") {
    main.push(<FindingCard key="finding" inFlight={facts?.inFlight} groupName={facts?.confirmed?.groupName ?? campaign.overview?.startWith?.groupName ?? null} cap={campaign.spend?.search.cap ?? null} />);
  } else if (state === "peopleNeedsYou" && campaign.peopleNeedsYou) {
    main.push(<PeopleNeedsYou key="needs-you" view={campaign.peopleNeedsYou} canRetry={campaign.can.retryPeople === true} spent={campaign.spentAtThisVersion === true} onChoose={choose} />);
  } else if (peopleStates.includes(state) && campaign.peopleFound) {
    if (state === "peopleFound" && revealOpen && revealPlan !== null && campaign.can.reveal === true) {
      main.push(<RevealCard key="reveal" plan={revealPlan} pending={pending} error={revealError} onConfirm={() => void confirmReveal()} onCancel={() => setRevealOpen(false)} />);
    }
    if (state === "revealing") {
      // A stopped reveal is never drawn as live work: the backend says it needs the rep, and why.
      if (revealNeedsYou || campaign.peopleFound.revealResult?.stopped === true) {
        main.push(<RevealNeedsYouCard key="reveal-stopped" line={revealStoppedLine(facts?.attention?.reason)} retryable={campaign.can.retryReveal === true} editHref={editHref} />);
      } else {
        main.push(
          <p key="revealing" data-testid="revealing-note" className="type-body text-muted">
            {facts?.inFlight?.status === "queued" ? campaignsCopy.summaryWaiting : campaignsCopy.revealingNote}
          </p>,
        );
      }
    }
    main.push(<PeopleFound key="people" view={campaign.peopleFound} editHref={editHref} spent={campaign.spentAtThisVersion === true} onReview={review} />);
  }
  // The sample campaigns (component tests) keep the signed later states: progress leads and the plan cards fold.
  if (!live && (leadsWithProgress || state === "planReady" || state === "findingPeople") && campaign.pack !== null) {
    if (leadsWithProgress && campaign.progress !== null) {
      main.push(
        <Card key="progress" label={campaignsCopy.progressLabel}>
          <ProgressCounts progress={campaign.progress} note={state === "running" ? answerTo("waiting", "next-batch") : undefined} />
        </Card>,
      );
    }
    main.push(<PlanSection key="plan-cards" pack={campaign.pack} collapsed={leadsWithProgress} />);
  }
  if (!live && (state === "researching" || state === "stopped" || state === "failed") && main.length === 0) {
    main.push(<BriefCard key="brief" brief={campaign.brief} />);
  }

  return (
    <>
      <div
        data-testid="campaign-header"
        className="-mx-6 mb-grid border-b border-line bg-ground px-6 pb-3 pt-1 wide:sticky wide:top-0 wide:z-10"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <PageHeader title={campaign.name} className="mb-1.5" />
            <StateRow state={state} stuck={revealNeedsYou || (state === "revealing" && campaign.peopleFound?.revealResult?.stopped === true)} />
          </div>
          {action === null ? null : (
            <div className="flex flex-col items-end gap-1.5">
              <PillButton
                variant={state === "running" ? "outline" : "primary"}
                disabled={action.disabled === true || pending}
                aria-disabled={action.disabled === true ? true : undefined}
                className={action.disabled === true ? "cursor-not-allowed border-line bg-transparent text-muted hover:opacity-100 active:opacity-100 disabled:opacity-100" : undefined}
                onClick={() => {
                  if (action.disabled === true) return;
                  if (action.kind === "retry") {
                    void submit(onRetry);
                    return;
                  }
                  if (live && action.kind === "confirm") {
                    void confirmWithPlay();
                    return;
                  }
                  if (action.kind === "reveal") {
                    setRevealOpen(true);
                    return;
                  }
                  if (action.kind === "retryPeople") {
                    void submit(onRetryPeople);
                    return;
                  }
                  if (action.kind === "retryReveal") {
                    void submit(onRetryReveal);
                    return;
                  }
                  setState(action.next);
                  setToast(campaignsCopy.toastConfirmed);
                }}
              >
                {pending ? (action.kind === "confirm" ? campaignsCopy.actionConfirming : campaignsCopy.actionTrying) : action.label}
              </PillButton>
              {action.note === undefined ? null : (
                <p data-testid="action-note" className="type-small max-w-measure text-right text-muted">
                  {action.note}
                </p>
              )}
              {actionError === null ? null : (
                <p role="alert" data-testid="action-error" className="type-small text-warn">
                  {actionError}
                </p>
              )}
            </div>
          )}
        </div>
        <div className="mt-2">
          <StageSummary facts={facts} />
        </div>
      </div>

      {toast === null ? null : (
        <p data-testid="campaign-toast" className="type-small mb-grid rounded-input bg-soft px-3 py-2.5 text-action">
          {toast}
        </p>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-grid wide:grid-cols-campaign">
        <div className="grid min-w-0 content-start gap-grid">{main}</div>
        <SupportRail
          overview={campaign.overview}
          researchHref={researchHref}
          spend={campaign.spend ?? null}
          sample={campaign.confirmPlan?.sample === true || campaign.peopleFound?.sample === true}
          brief={campaign.brief}
          editHref={editHref}
          ask={answers}
          confirmed={state !== "planReady"}
          // The rail opens on what the rep is likeliest to want beside the work: the plan once there are people, the brief before.
          initial={peopleStates.includes(state) ? "research" : "brief"}
        />
      </div>
    </>
  );
}
