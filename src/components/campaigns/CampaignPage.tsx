"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Card } from "@/components/Card";
import { PageHeader } from "@/components/PageHeader";
import { PillButton } from "@/components/PillButton";
import type { ChooseIndustrySubmission, RetrySubmission, RevealSubmission, ReviewSubmission, StartResult, WidenSubmission } from "@/lib/campaigns/start";
import { actionFor, answersFor, failureLine, type CampaignState } from "@/lib/campaigns/state";
import type { Campaign } from "@/lib/campaigns/types";
import { campaignsCopy } from "@/lib/copy/campaigns";

import { AskRelay } from "./AskRelay";
import { BriefCard } from "./BriefCard";
import { Overview } from "./Overview";
import { PlanSection } from "./PlanCards";
import { ProgressCounts } from "./ProgressCounts";
import { StateRow } from "./StateRow";
import { WidenCard } from "./WidenCard";
import { ConfirmCard } from "./ConfirmCard";
import { PeopleFound } from "./PeopleFound";
import { PeopleNeedsYou } from "./PeopleNeedsYou";
import { RevealCard } from "./RevealCard";

/**
 * The campaign page (§23.1c, mock 3b and 3c).
 *
 * Top to bottom, and the order is the signed one: header with the steps and
 * ONE action matching the state; the brief; Ask Relay; the plan and the
 * research behind it; progress; people. Two states reorder that, and the signed
 * section says so in as many words: Plan ready leads with the plan, and Running
 * leads with progress and folds the plan away.
 *
 * A real campaign (`live`) is drawn from the database and offers what is
 * built (orchestrator A1, items 4 to 6): a stop's options can be chosen, Edit
 * brief opens Start on the brief, and Try again puts failed research back on
 * the queue. Confirm plan is shown and cannot be pressed until finding people
 * exists. Each change goes to the server and the page comes back drawn from
 * what the server then holds; nothing here moves a real campaign's state on
 * its own. The sample campaigns the component tests use keep the signed
 * actions, which change this component's state and nothing else.
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
}: {
  campaign: Campaign;
  /** A line the route arrived with, such as Start's "research has started". */
  banner?: string | null;
  /** Asks for a stop's chosen option (a server action). */
  onWiden?: (submission: WidenSubmission) => Promise<StartResult>;
  /** Puts failed research back on the queue (a server action). */
  onRetry?: (submission: RetrySubmission) => Promise<StartResult>;
  /** Confirm plan: the first spend gate (a server action; lead gen v2.1 §6). */
  onConfirm?: (submission: RetrySubmission) => Promise<StartResult>;
  /** Try again on finding people (a server action). */
  onRetryPeople?: (submission: RetrySubmission) => Promise<StartResult>;
  /** Search with a chosen industry (a server action). */
  onChooseIndustry?: (submission: ChooseIndustrySubmission) => Promise<StartResult>;
  /** Keep or drop people found, one or a whole account (a server action; lead gen v2.2 §9a). */
  onReview?: (submission: ReviewSubmission) => Promise<StartResult>;
  /** Reveal emails for the kept people, with the figures shown (a server action; lead gen v2.1 §6). */
  onReveal?: (submission: RevealSubmission) => Promise<StartResult>;
}) {
  const router = useRouter();
  const [state, setState] = useState<CampaignState>(campaign.state);
  const [toast, setToast] = useState<string | null>(banner);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Minted once per page: a second press of the same action sends the same
  // id, and the server answers it as the press that already landed.
  const [requestId] = useState(() => crypto.randomUUID());
  const live = campaign.live;
  const target = { campaignId: campaign.id, briefVersion: campaign.briefVersion };
  const editHref = live && campaign.can.edit ? `/campaigns/${campaign.id}/edit` : undefined;

  // Reveal emails opens its figures first; nothing is bought until the confirm inside them is pressed.
  const [revealOpen, setRevealOpen] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  const revealPlan = campaign.peopleFound?.revealPlan ?? null;
  const action = actionFor(state, live, campaign.can.retry, {
    confirm: campaign.can.confirm === true && onConfirm !== undefined,
    retryPeople: campaign.can.retryPeople === true && onRetryPeople !== undefined,
    reveal: campaign.can.reveal === true && onReveal !== undefined,
    revealBlocked: revealPlan !== null && revealPlan.kept > 0 ? campaignsCopy.revealNothingToReveal : campaignsCopy.revealKeepFirst,
  });
  const peopleStates: CampaignState[] = ["peopleFound", "revealing", "peopleReady"];
  /*
    Recomputed from the state the SCREEN is in, not from the state the campaign
    arrived in. Pause moves the page and the six answers together, and an Ask
    Relay that still said "nothing is paused" the moment after the rep paused it
    would be the one thing on this page a rep could catch lying.
  */
  const answers = answersFor(state, { ...campaign, retryable: campaign.can.retry });
  /** Answers by id, never by position: `answersFor` is free to reorder them. */
  const answerTo = (...ids: string[]) =>
    ids
      .map((id) => answers.find((answer) => answer.id === id)?.answer)
      .filter((line) => line !== undefined)
      .join(" ");
  const leadsWithProgress = state === "running" || state === "paused" || state === "done";

  /** A change landed: come back to the campaign as the server now has it. */
  const lookingAgain = (id: string) => {
    router.push(`/campaigns/${id}?again=1`);
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

  /** Confirm lands on the campaign with its own line; the rest are Relay looking again. */
  const confirmed = (id: string) => {
    router.push(`/campaigns/${id}?confirmed=1`);
    router.refresh();
  };

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

  const progress = (
    <Card label={campaignsCopy.progressLabel}>
      {campaign.progress === null ? (
        // Nobody has been found yet: words, not five zeros that read like work done.
        <p data-testid="progress-none" className="type-small text-muted">
          {campaignsCopy.progressNone}
        </p>
      ) : (
        <ProgressCounts
          progress={campaign.progress}
          // A real campaign has no drafting, sending or replies yet: only Found is drawn.
          downstream={!live}
          /*
            The line under the counts is the same two answers Ask Relay gives to
            "what is waiting on me" and "when does the next batch go" — written
            once, in the copy file, and read here rather than restated.
          */
          note={state === "running" ? answerTo("waiting", "next-batch") : undefined}
        />
      )}
    </Card>
  );

  const plan =
    // A real campaign's finished plan is the Overview (task 18); the plan cards stay for the samples.
    campaign.overview !== null && (state === "planReady" || state === "findingPeople" || state === "peopleNeedsYou" || peopleStates.includes(state)) ? (
      <>
        <Overview
          overview={campaign.overview}
          editHref={editHref}
          researchHref={live ? `/campaigns/${campaign.id}/research` : undefined}
          confirmed={state !== "planReady"}
          // Once there are accounts to review, the research folds away; it is one press from open.
          collapsed={peopleStates.includes(state)}
        />
        {state === "planReady" && campaign.confirmPlan ? (
          <div className="mt-grid">
            <ConfirmCard plan={campaign.confirmPlan} />
          </div>
        ) : null}
      </>
    ) : campaign.pack === null ||
    state === "stopped" ||
    state === "researching" ||
    state === "brief" ||
    state === "failed" ? null : (
      <PlanSection
        pack={campaign.pack}
        collapsed={leadsWithProgress}
        // Only while the plan is the thing being decided on: once it is
        // confirmed it is read only (§23.1c).
        editHref={state === "planReady" ? editHref : undefined}
      >
        {campaign.plan === null ? null : (
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 border-t border-line pt-3">
            {(
              [
                [
                  campaignsCopy.planPeople,
                  `${campaign.plan.people} ${campaignsCopy.peopleFrom} ${campaign.plan.companies} ${campaignsCopy.peopleCompanies}${campaignsCopy.noteJoin}${campaignsCopy.peoplePerCompany}`,
                ],
                [
                  campaignsCopy.planCredits,
                  `${campaign.plan.creditsNeeded} ${campaignsCopy.creditsReveals} ${campaign.plan.creditsNeeded} ${campaignsCopy.creditsLeft} ${campaign.plan.creditsLeft} ${campaignsCopy.creditsLeftTail}`,
                ],
                [
                  campaignsCopy.planSending,
                  `${campaign.plan.perDay} ${campaignsCopy.sendingADay} ${campaign.plan.windowStart} ${campaignsCopy.sendingTo} ${campaign.plan.windowEnd}${campaignsCopy.noteJoin}${campaignsCopy.sendingFrom} ${campaign.plan.mailbox}`,
                ],
                [campaignsCopy.planLawful, campaignsCopy.lawfulBasis],
              ] as [string, string][]
            ).map(([label, value]) => (
              <div key={label} data-testid="plan-fact" className="contents">
                <dt className="type-small text-muted">{label}</dt>
                <dd className="type-small">{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </PlanSection>
    );

  const people = (
    <Card label={campaignsCopy.peopleLabel}>
      {campaign.people === null ? (
        <p className="type-small text-muted">
          {state === "findingPeople" || state === "peopleNeedsYou" || peopleStates.includes(state) ? campaignsCopy.peopleAfterConfirm : campaignsCopy.peopleBeforeConfirm}
        </p>
      ) : (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
            <dt className="type-small text-muted">{campaignsCopy.peopleChosen}</dt>
            <dd className="type-mono text-13">
              {campaign.people.chosen} {campaignsCopy.peopleFrom} {campaign.people.companies}{" "}
              {campaignsCopy.peopleCompanies}
            </dd>
            <dt className="type-small text-muted">{campaignsCopy.peopleOnHold}</dt>
            <dd className="type-mono text-13">{campaign.people.onHold}</dd>
          </dl>
          {/* Your people (§23.1e) is lead gen's screen and is not built: no link to it from a real campaign. */}
          {live ? null : (
            <Link
              href={`/campaigns/${campaign.id}/people`}
              className="type-small mt-2.5 inline-block text-action focus-visible:outline-none focus-visible:ring-2"
            >
              {campaignsCopy.peopleLink}
            </Link>
          )}
        </>
      )}
    </Card>
  );

  const brief = (
    <BriefCard brief={campaign.brief} summary={leadsWithProgress ? campaign.motionLine : undefined} editHref={editHref} />
  );

  const ask = <AskRelay questions={answers} />;

  /*
    The order is the state's, not the file's (§23.1c, "By state").

    Plan ready leads with the plan, because the plan section IS the Confirm
    screen and the rep is here to read it. Running leads with progress and
    folds the plan, because the decision is made and the question is how it is
    going. Researching, the stop and a failure have no plan to lead with at all.
  */
  /** Keep or drop: the server holds the decision, and the page is redrawn from it. */
  const review =
    live && campaign.can.review === true && onReview !== undefined
      ? async (personId: string, scope: ReviewSubmission["scope"], decision: ReviewSubmission["decision"]): Promise<string | null> => {
          const result = await onReview({ ...target, personId, scope, decision });
          if ("error" in result) return result.error;
          router.refresh();
          return null;
        }
      : undefined;

  const peopleFound =
    peopleStates.includes(state) && campaign.peopleFound ? (
      <PeopleFound view={campaign.peopleFound} editHref={editHref} spent={campaign.spentAtThisVersion === true} onReview={review} />
    ) : null;

  /** Reveal emails, confirmed: the server checks the figures again and lands the rep on the campaign, revealing. */
  const confirmReveal = async () => {
    if (onReveal === undefined || revealPlan === null || pending) return;
    setPending(true);
    setRevealError(null);
    try {
      const result = await onReveal({
        ...target,
        requestId,
        expected: { toReveal: revealPlan.toReveal, known: revealPlan.known, maxCredits: revealPlan.maxCredits },
      });
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

  const column =
    state === "planReady"
      ? [plan, brief, ask]
      : peopleStates.includes(state)
        ? [peopleFound, brief, ask, plan]
      : leadsWithProgress
        ? [progress, plan, ask]
        : [brief, ask, plan];

  const rail =
    state === "planReady"
      ? [progress, people]
      : leadsWithProgress
        ? [people, brief]
        : [progress, people];

  return (
    <>
      <div className="mb-grid flex flex-wrap items-start justify-between gap-3">
        <div>
          <PageHeader title={campaign.name} className="mb-2" />
          <StateRow state={state} stuck={state === "revealing" && campaign.peopleFound?.revealResult?.stopped === true} />
        </div>
        {action === null ? null : (
          <div className="flex flex-col items-end gap-1.5">
            <PillButton
              variant={state === "running" ? "outline" : "primary"}
              disabled={action.disabled === true || pending}
              aria-disabled={action.disabled === true ? true : undefined}
              // An action that is not built yet (Reveal emails) must not look pressable: quiet
              // outline, muted text, no hover, and the note under it says why.
              className={action.disabled === true ? "cursor-not-allowed border-line bg-transparent text-muted hover:opacity-100 active:opacity-100 disabled:opacity-100" : undefined}
              onClick={() => {
                if (action.disabled === true) return;
                if (action.kind === "retry") {
                  void submit(onRetry);
                  return;
                }
                if (live && action.kind === "confirm") {
                  void submit(onConfirm, confirmed);
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
                setState(action.next);
                setToast(campaignsCopy.toastConfirmed);
              }}
            >
              {pending ? (action.kind === "confirm" ? campaignsCopy.actionConfirming : campaignsCopy.actionTrying) : action.label}
            </PillButton>
            {action.note === undefined ? null : (
              <p data-testid="action-note" className="type-small text-muted">
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

      {toast === null ? null : (
        <p data-testid="campaign-toast" className="type-small mb-grid rounded-input bg-soft px-3 py-2.5 text-action">
          {toast}
        </p>
      )}

      {state === "researching" ? (
        <p data-testid="researching-note" className="type-body mb-grid text-muted">
          {campaignsCopy.researchingNote}
        </p>
      ) : null}

      {state === "peopleFound" && revealOpen && revealPlan !== null && campaign.can.reveal === true ? (
        <div className="mb-grid">
          <RevealCard plan={revealPlan} pending={pending} error={revealError} onConfirm={() => void confirmReveal()} onCancel={() => setRevealOpen(false)} />
        </div>
      ) : null}

      {state === "revealing" ? (
        <p
          data-testid={campaign.peopleFound?.revealResult?.stopped === true ? "reveal-stopped" : "revealing-note"}
          className={campaign.peopleFound?.revealResult?.stopped === true ? "type-small mb-grid rounded-input bg-warn-bg px-3 py-2.5 text-warn" : "type-body mb-grid text-muted"}
        >
          {campaign.peopleFound?.revealResult?.stopped === true ? campaignsCopy.revealStopped : campaignsCopy.revealingNote}
        </p>
      ) : null}

      {state === "findingPeople" && live ? (
        <p data-testid="finding-note" className="type-body mb-grid text-muted">
          {campaignsCopy.findingNote}
        </p>
      ) : null}

      {state === "peopleNeedsYou" && campaign.peopleNeedsYou ? (
        <div className="mb-grid">
          <PeopleNeedsYou
            view={campaign.peopleNeedsYou}
            canRetry={campaign.can.retryPeople === true}
            spent={campaign.spentAtThisVersion === true}
            onChoose={choose}
          />
        </div>
      ) : null}

      {state === "failed" ? (
        <p data-testid="failed-note" className="type-small mb-grid rounded-input bg-warn-bg px-3 py-2.5 text-warn">
          {failureLine(campaign.failure)} {campaignsCopy.failedNothingSpent}{" "}
          {campaign.can.retry ? campaignsCopy.failedNextRetry : campaignsCopy.failedNextEdit}
        </p>
      ) : null}

      {state === "stopped" && campaign.pack?.insufficient !== undefined ? (
        <div className="mb-grid">
          <WidenCard
            reason={campaign.pack.insufficient.reason}
            found={campaign.pack.stopEvidence ?? []}
            choices={campaign.widenings ?? []}
            onWiden={widen}
          />
        </div>
      ) : null}

      <div className="grid gap-grid wide:grid-cols-campaign">
        <div className="grid content-start gap-grid">
          {column.map((section, index) =>
            section === null ? null : <div key={index}>{section}</div>,
          )}
        </div>
        <div className="grid content-start gap-grid">
          {rail.map((section, index) =>
            section === null ? null : <div key={index}>{section}</div>,
          )}
        </div>
      </div>
    </>
  );
}
