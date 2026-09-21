"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Card } from "@/components/Card";
import { PageHeader } from "@/components/PageHeader";
import { PillButton } from "@/components/PillButton";
import { PillLink } from "@/components/PillLink";
import { headerActionOf, type HeaderAction } from "@/lib/campaigns/headerAction";
import type { ChooseIndustrySubmission, RetrySubmission, RevealSubmission, ReviewSubmission, StartResult, WidenSubmission } from "@/lib/campaigns/start";
import { actionFor, revealStoppedLine, type CampaignState } from "@/lib/campaigns/state";
import type { Campaign } from "@/lib/campaigns/types";
import { campaignsCopy } from "@/lib/copy/campaigns";
import { findMoreCopy } from "@/lib/copy/findMore";
import { outreachPeopleCopy } from "@/lib/copy/outreachPeople";
import { PERSON_DRAFT_COST_CAP_USD } from "@/lib/outreach/cost";

import { BriefCard } from "./BriefCard";
import { OutreachCard } from "./OutreachCard";
import { PeopleFound } from "./PeopleFound";
import { PeopleNeedsYou } from "./PeopleNeedsYou";
import { PlanDecision } from "./PlanDecision";
import { PlanSection } from "./PlanCards";
import { ProgressCounts } from "./ProgressCounts";
import { RevealCard } from "./RevealCard";
import { FindMoreCard } from "./FindMoreCard";
import { DraftingCard, FindingCard, ResearchNeedsYouCard, ResearchingCard, RevealNeedsYouCard, RevealingCard } from "./StageNotes";
import { StageSummary } from "./StageSummary";
import { StateRow } from "./StateRow";
import { SupportRail } from "./SupportRail";
import { WidenCard } from "./WidenCard";
import { WriteCard } from "./WriteCard";

/**
 * The campaign page (§23.1c), state-led (product-truth pass).
 *
 * Three things are constant: the header (name, the steps, ONE action, which
 * is the backend's `facts.nextAction` in words), the stage summary under it
 * (the same words as the list row and Home), and the support rail (Research,
 * Spend, Brief, Activity as quiet tabs). While Relay works the page asks the
 * server again every so often, so a queued job becomes a running one and a
 * finished one becomes the next stage without a reload.
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
  onCreatePlays,
  onRetryPeople,
  onChooseIndustry,
  onReview,
  onReveal,
  onRetryReveal,
  onWriteEmails,
  onStartOutreach,
  onPauseOutreach,
  onFindMore,
  people,
}: {
  campaign: Campaign;
  /**
   * The People tab (Relay P5), on a campaign that has started outreach:
   * whether it is the view open (`?tab=people`), and the list and drawer the
   * page built for it. Absent, there are no tabs.
   */
  people?: { active: boolean; content: ReactNode };
  /** A line the route arrived with, such as Start's "research has started". */
  banner?: string | null;
  onWiden?: (submission: WidenSubmission) => Promise<StartResult>;
  onRetry?: (submission: RetrySubmission) => Promise<StartResult>;
  /** Confirm plan: the first spend gate (lead gen v2.1 §6), naming the play the rep chose (v2.3). */
  onConfirm?: (submission: RetrySubmission & { candidateId?: string }) => Promise<StartResult>;
  /** Create campaigns (Relay P1): each ticked play as its own campaign on this research. */
  onCreatePlays?: (submission: RetrySubmission & { playIds: string[] }) => Promise<StartResult>;
  onRetryPeople?: (submission: RetrySubmission) => Promise<StartResult>;
  /** Try again on a reveal that stopped before any request left Relay (a server action). */
  onRetryReveal?: (submission: RetrySubmission) => Promise<StartResult>;
  /** Write emails (outreach v2.1): first emails drafted for review, nothing sent (a server action). */
  onWriteEmails?: (submission: RetrySubmission) => Promise<StartResult>;
  /** Start outreach (Relay P3): the chosen day on everyone with drafts who has not started (a server action). */
  onStartOutreach?: (submission: { campaignId: string; requestId: string; startOn: string }) => Promise<StartResult>;
  /** Pause or Resume the campaign's outreach (Relay P3, a server action). */
  onPauseOutreach?: (submission: { campaignId: string; paused: boolean }) => Promise<StartResult>;
  /** Find more people (P5b): the next batch, for the number the rep chose (a server action). */
  onFindMore?: (submission: RetrySubmission & { howMany: 10 | 20 | 30; newCap: boolean }) => Promise<StartResult>;
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
  // A campaign made for one play (Relay P1) has that play only, and Confirm names it.
  const plays = campaign.plays ?? [];
  const recommendedId = campaign.playId ?? plays.find((play) => play.recommended)?.id ?? null;
  const [candidateId, setCandidateId] = useState<string | null>(recommendedId);
  const [ticked, setTicked] = useState<string[]>([]);
  const [createError, setCreateError] = useState<string | null>(null);

  const [revealOpen, setRevealOpen] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  const revealPlan = campaign.peopleFound?.revealPlan ?? null;
  const revealBlocked = revealPlan !== null && revealPlan.kept > 0 ? campaignsCopy.revealNothingToReveal : campaignsCopy.revealKeepFirst;
  // Ticking plays (Relay P1) is the plan's one action: Confirm waits until the campaigns exist.
  const choosingPlays = live && campaign.canCreatePlays === true && onCreatePlays !== undefined;
  // The header's one control: the backend's next action for a stored campaign; a sample keeps its signed screen actions.
  const nextAction: HeaderAction | ReturnType<typeof actionFor> =
    facts !== undefined
      ? headerActionOf(
          facts,
          campaign.can,
          {
            confirm: onConfirm !== undefined,
            retry: onRetry !== undefined && campaign.can.retry,
            retryPeople: onRetryPeople !== undefined && campaign.can.retryPeople === true,
            retryReveal: onRetryReveal !== undefined && campaign.can.retryReveal === true,
            reveal: onReveal !== undefined,
            write: onWriteEmails !== undefined,
          },
          { ...(editHref === undefined ? {} : { editHref }), revealBlocked },
        )
      : actionFor(state, live, campaign.can.retry, {
          confirm: campaign.can.confirm === true && onConfirm !== undefined,
          retryPeople: campaign.can.retryPeople === true && onRetryPeople !== undefined,
          reveal: campaign.can.reveal === true && onReveal !== undefined,
          revealBlocked,
          retryReveal: campaign.can.retryReveal === true && onRetryReveal !== undefined,
        });
  const action = choosingPlays && nextAction?.kind === "confirm" ? null : nextAction;
  const peopleStates: CampaignState[] = ["peopleFound", "revealing", "peopleReady", "drafting"];
  const [writeOpen, setWriteOpen] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const writeEmails = () => {
    if (onWriteEmails === undefined || pending) return;
    setPending(true);
    setWriteError(null);
    void onWriteEmails({ ...target, requestId })
      .then((result) => {
        if ("id" in result) {
          router.push(`/campaigns/${result.id}?writing=1`);
          router.refresh();
          return;
        }
        setWriteError(result.error);
        setPending(false);
      })
      .catch(() => {
        setWriteError(campaignsCopy.cannotChange);
        setPending(false);
      });
  };
  // Start outreach mints its own request id and a fresh one after each start: a later batch on the same page is a new press.
  const [outreachRequestId, setOutreachRequestId] = useState(() => crypto.randomUUID());
  const [outreachError, setOutreachError] = useState<string | null>(null);
  const outreachChange = (change: () => Promise<StartResult>, after?: () => void) => {
    if (pending) return;
    setPending(true);
    setOutreachError(null);
    void change()
      .then((result) => {
        if ("id" in result) {
          after?.();
          router.refresh();
        } else {
          setOutreachError(result.error);
        }
      })
      .catch(() => setOutreachError(campaignsCopy.cannotChange))
      .finally(() => setPending(false));
  };
  const startOutreach = (startOn: string) => {
    if (onStartOutreach === undefined) return;
    outreachChange(
      () => onStartOutreach({ campaignId: campaign.id, requestId: outreachRequestId, startOn }),
      () => setOutreachRequestId(crypto.randomUUID()),
    );
  };
  const pauseOutreach = (paused: boolean) => {
    if (onPauseOutreach === undefined) return;
    outreachChange(() => onPauseOutreach({ campaignId: campaign.id, paused }));
  };
  const [findMoreError, setFindMoreError] = useState<string | null>(null);
  // Find more repeats (batch 2, then 3), so each press that lands is a new request; a double click on one is not.
  const [findMoreRequestId, setFindMoreRequestId] = useState(() => crypto.randomUUID());
  // A press that landed keeps the buttons down until the page offers a different batch, so a quick second press never reads as refused.
  const offeredBatch = campaign.findMore?.batch ?? null;
  const [seenBatch, setSeenBatch] = useState(offeredBatch);
  if (offeredBatch !== seenBatch) {
    setSeenBatch(offeredBatch);
    setPending(false);
  }
  const findMore = (howMany: 10 | 20 | 30, newCap: boolean) => {
    if (onFindMore === undefined || pending) return;
    setPending(true);
    setFindMoreError(null);
    void onFindMore({ ...target, requestId: findMoreRequestId, howMany, newCap })
      .then((result) => {
        if ("id" in result) {
          setFindMoreRequestId(crypto.randomUUID());
          router.push(`/campaigns/${result.id}?more=1`);
          router.refresh();
          return;
        }
        setFindMoreError(result.error);
        setPending(false);
      })
      .catch(() => {
        setFindMoreError(campaignsCopy.cannotChange);
        setPending(false);
      });
  };
  // Start outreach, Pause and Resume (Relay P3), once drafts are asked for. A start or a new day in London is a fresh card: the picker closes and takes the new default.
  const outreachCard =
    live && campaign.outreach != null && onStartOutreach !== undefined && onPauseOutreach !== undefined ? (
      <OutreachCard
        key={`outreach:${campaign.outreach.today}:${campaign.outreach.batches.map((batch) => `${batch.startOn}=${batch.people}`).join(",")}`}
        view={campaign.outreach}
        pending={pending}
        error={outreachError}
        onStart={startOutreach}
        onPause={pauseOutreach}
      />
    ) : null;
  const findMoreCard =
    live && campaign.findMore != null && onFindMore !== undefined ? <FindMoreCard key="find-more" view={campaign.findMore} pending={pending} error={findMoreError} onFind={findMore} /> : null;
  // While a later batch is under way (P5b), one line says where it is: "Batch 2: 18 found, review them".
  const batch = campaign.batch ?? 1;
  const batchLine = live && batch > 1 ? batchLineOf(batch, state, campaign.peopleFound?.found.n ?? null) : null;
  const leadsWithProgress = state === "running" || state === "paused" || state === "done";

  // While Relay works, ask the server again every little while: a queued job becomes running, a finished one the next stage.
  const working = facts?.inFlight !== null && facts?.inFlight !== undefined;
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => router.refresh(), 15_000);
    return () => clearInterval(timer);
  }, [working, router]);

  // The sticky header's height, for what sits under it (the rail) to stick below rather than behind it.
  const header = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = header.current;
    const root = page.current;
    if (element === null || root === null || typeof ResizeObserver === "undefined") return;
    const set = () => root.style.setProperty("--relay-header-h", `${element.offsetHeight}px`);
    set();
    const observer = new ResizeObserver(set);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

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

  const createPlays = () => {
    if (onCreatePlays === undefined || pending || ticked.length === 0) return;
    setPending(true);
    setCreateError(null);
    void onCreatePlays({ ...target, requestId, playIds: ticked })
      .then((result) => {
        if ("id" in result) {
          router.push("/campaigns");
          router.refresh();
          return;
        }
        setCreateError(result.error);
        setPending(false);
      })
      .catch(() => {
        setCreateError(campaignsCopy.cannotChange);
        setPending(false);
      });
  };
  const pick =
    choosingPlays
      ? {
          ticked,
          onTick: (id: string) => setTicked((now) => (now.includes(id) ? now.filter((each) => each !== id) : [...now, id])),
          onCreate: createPlays,
          pending,
          error: createError,
        }
      : null;

  const confirmWithPlay = () => submit((submission) => onConfirm!({ ...submission, ...(candidateId === null ? {} : { candidateId }) }), confirmed);

  const review =
    live && campaign.can.review === true && onReview !== undefined
      ? async (personId: string, scope: ReviewSubmission["scope"], decision: ReviewSubmission["decision"], personIds?: string[]): Promise<string | null> => {
          const result = await onReview({ ...target, personId, scope, decision, ...(personIds === undefined ? {} : { personIds }) });
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
  if (batchLine !== null) {
    main.push(
      <p key="batch-line" data-testid="batch-line" className="type-body rounded-input border border-line bg-soft px-4 py-3 text-ink">
        {batchLine}
      </p>,
    );
  }
  if (state === "researching" || state === "brief") {
    main.push(<ResearchingCard key="researching" inFlight={facts?.inFlight} />);
  } else if (state === "failed") {
    main.push(<ResearchNeedsYouCard key="failed" failure={campaign.failure} facts={facts} canRetry={campaign.can.retry} editHref={editHref} researchHref={live && campaign.failure === "no_play" ? `/campaigns/${campaign.id}/research` : undefined} />);
  } else if (state === "stopped" && campaign.pack?.insufficient !== undefined) {
    main.push(<WidenCard key="widen" reason={campaign.pack.insufficient.reason} found={campaign.pack.stopEvidence ?? []} choices={campaign.widenings ?? []} onWiden={widen} />);
  } else if (state === "planReady" && campaign.overview !== null && live) {
    main.push(<PlanDecision key="plan" plays={plays} overview={campaign.overview} confirmPlan={pick === null ? (campaign.confirmPlan ?? null) : null} selectedId={candidateId} onSelect={setCandidateId} pick={pick} />);
  } else if (state === "findingPeople") {
    main.push(<FindingCard key="finding" inFlight={facts?.inFlight} finding={campaign.finding ?? null} groupName={facts?.confirmed?.groupName ?? campaign.overview?.startWith?.groupName ?? null} spend={facts?.spend.search ?? campaign.spend?.search ?? null} />);
  } else if (state === "peopleNeedsYou" && campaign.peopleNeedsYou) {
    main.push(<PeopleNeedsYou key="needs-you" view={campaign.peopleNeedsYou} canRetry={campaign.can.retryPeople === true} spent={campaign.spentAtThisVersion === true} editHref={editHref} onChoose={choose} />);
    // A later batch that found nobody new: ask again (P5b).
    if (findMoreCard !== null) main.push(findMoreCard);
  } else if (peopleStates.includes(state) && campaign.peopleFound) {
    if (state === "peopleFound" && revealOpen && revealPlan !== null && campaign.can.reveal === true) {
      main.push(<RevealCard key="reveal" plan={revealPlan} pending={pending} error={revealError} onConfirm={() => void confirmReveal()} onCancel={() => setRevealOpen(false)} />);
    }
    // Write emails: the card says what it does, and one press asks for the drafts (outreach v2.1).
    if (state === "peopleReady" && writeOpen && campaign.can.write === true) {
      main.push(<WriteCard key="write" people={campaign.peopleFound.writable ?? 0} costCeilingUsd={PERSON_DRAFT_COST_CAP_USD} pending={pending} error={writeError} onConfirm={writeEmails} onCancel={() => setWriteOpen(false)} />);
    }
    // Drafting, drafts to review, ready to send: the counts and the way into the Inbox, above the people.
    if (state === "drafting" && facts !== undefined && facts.drafts !== null) {
      main.push(<DraftingCard key="drafting" stage={facts.stage} inFlight={facts.inFlight} drafts={facts.drafts} attention={facts.attention} editHref={editHref} />);
    }
    if (state === "drafting" && outreachCard !== null) main.push(outreachCard);
    // Find more people (P5b), once this batch is finished with: started, or nobody in it to write for.
    if ((state === "drafting" || state === "peopleReady") && findMoreCard !== null) main.push(findMoreCard);
    if (state === "revealing") {
      // A stopped reveal is never drawn as live work: the backend says it needs the rep, and why.
      if (revealNeedsYou || campaign.peopleFound.revealResult?.stopped === true) {
        main.push(<RevealNeedsYouCard key="reveal-stopped" line={revealStoppedLine(facts?.stage === "reveal_needs_you" ? facts.attention.reason : null)} retryable={campaign.can.retryReveal === true} editHref={editHref} />);
      } else {
        main.push(<RevealingCard key="revealing" inFlight={facts?.inFlight} />);
      }
    }
    main.push(<PeopleFound key="people" view={campaign.peopleFound} editHref={editHref} spent={campaign.spentAtThisVersion === true} onReview={review} />);
  }
  // The sample campaigns (component tests) keep the signed later states: progress leads and the plan cards fold.
  if (!live && (leadsWithProgress || state === "planReady" || state === "findingPeople") && campaign.pack !== null) {
    if (leadsWithProgress && campaign.progress !== null) {
      main.push(
        <Card key="progress" label={campaignsCopy.progressLabel}>
          <ProgressCounts progress={campaign.progress} />
        </Card>,
      );
    }
    main.push(<PlanSection key="plan-cards" pack={campaign.pack} collapsed={leadsWithProgress} />);
  }
  // While a later batch is under way, an earlier batch stays in reach: Start outreach for anyone drafted and waiting, and its days and Pause (P5b).
  if (state !== "drafting" && batch > 1 && outreachCard !== null && ((campaign.outreach?.startable ?? 0) > 0 || (campaign.outreach?.batches.length ?? 0) > 0)) main.push(outreachCard);
  if (!live && (state === "researching" || state === "stopped" || state === "failed") && main.length === 0) {
    main.push(<BriefCard key="brief" brief={campaign.brief} />);
  }

  return (
    <div ref={page}>
      <div
        ref={header}
        data-testid="campaign-header"
        className="-mx-6 mb-grid border-b border-line bg-panel px-6 pb-3 pt-1 wide:sticky wide:top-0 wide:z-10"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <PageHeader title={campaign.name} className="mb-1.5" />
            <StateRow state={state} stage={facts?.stage ?? null} stuck={revealNeedsYou || (state === "revealing" && campaign.peopleFound?.revealResult?.stopped === true)} />
          </div>
          {action === null ? null : (
            <div className="flex flex-col items-end gap-1.5">
              {action.kind === "editBrief" || action.kind === "reviewDrafts" ? (
                <PillLink href={action.href} data-testid={action.kind === "editBrief" ? "header-edit-brief" : "header-review-drafts"}>
                  {action.label}
                </PillLink>
              ) : (
                <PillButton
                  variant={state === "running" ? "outline" : "primary"}
                  disabled={("disabled" in action && action.disabled === true) || pending}
                  aria-disabled={"disabled" in action && action.disabled === true ? true : undefined}
                  className={"disabled" in action && action.disabled === true ? "cursor-not-allowed border-line bg-transparent text-muted hover:opacity-100 active:opacity-100 disabled:opacity-100" : undefined}
                  onClick={() => {
                    if ("disabled" in action && action.disabled === true) return;
                    if (action.kind === "write") {
                      setWriteOpen(true);
                      return;
                    }
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
                    if ("next" in action) {
                      setState(action.next);
                      setToast(campaignsCopy.toastConfirmed);
                    }
                  }}
                >
                  {pending ? (action.kind === "confirm" ? campaignsCopy.actionConfirming : campaignsCopy.actionTrying) : action.label}
                </PillButton>
              )}
              {"note" in action && action.note !== undefined ? (
                <p data-testid="action-note" className="type-small max-w-measure text-right text-muted">
                  {action.note}
                </p>
              ) : null}
              {actionError === null ? null : (
                <p role="alert" data-testid="action-error" className="type-small text-warn">
                  {actionError}
                </p>
              )}
            </div>
          )}
        </div>
        <div className="mt-2">
          <StageSummary
            facts={facts}
            quietWhenAttention
            detail={state === "planReady" && recommendedId !== null ? `${campaignsCopy.summaryStartWith} ${plays.find((play) => play.id === (candidateId ?? recommendedId))?.group.name ?? ""}` : null}
          />
        </div>
      </div>

      {toast === null ? null : (
        <p data-testid="campaign-toast" className="type-small mb-grid rounded-input bg-soft px-3 py-2.5 text-action">
          {toast}
        </p>
      )}

      {people === undefined ? null : (
        <nav aria-label={outreachPeopleCopy.tabsLabel} data-testid="campaign-tabs" className="mb-grid flex gap-1 border-b border-line">
          {[
            { id: "overview", label: outreachPeopleCopy.tabOverview, href: `/campaigns/${campaign.id}`, current: !people.active },
            { id: "people", label: outreachPeopleCopy.tabPeople, href: `/campaigns/${campaign.id}?tab=people`, current: people.active },
          ].map((tab) => (
            <Link
              key={tab.id}
              href={tab.href}
              scroll={false}
              data-testid={`campaign-tab-${tab.id}`}
              aria-current={tab.current ? "page" : undefined}
              className={`-mb-px rounded-t-input border-b-2 px-3 py-2 text-14 font-medium outline-none focus-visible:ring-2 ${tab.current ? "border-action text-ink" : "border-transparent text-muted hover:text-ink"}`}
            >
              {tab.label}
            </Link>
          ))}
        </nav>
      )}

      {people?.active === true ? (
        people.content
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-grid wide:grid-cols-campaign">
          <div className="grid min-w-0 content-start gap-grid">{main}</div>
          <SupportRail
            overview={campaign.overview}
            researchHref={researchHref}
            spend={campaign.spend ?? null}
            sample={campaign.confirmPlan?.sample === true || campaign.peopleFound?.sample === true}
            brief={campaign.brief}
            editHref={editHref}
            {...(campaign.activity === undefined ? {} : { activity: campaign.activity })}
            confirmed={state !== "planReady"}
            // The rail opens on what the rep is likeliest to want beside the work: the plan once there are people, the brief before.
            initial={peopleStates.includes(state) ? "research" : "brief"}
          />
        </div>
      )}
    </div>
  );
}

/** Where a later batch is (P5b), in one line. Null once its outreach is being written and there is nothing more to say. */
function batchLineOf(batch: number, state: CampaignState, found: number | null): string | null {
  const c = findMoreCopy;
  const lead = `${c.batch} ${batch}:`;
  switch (state) {
    case "findingPeople":
      return `${lead} ${c.lineFinding}`;
    case "peopleNeedsYou":
      return `${lead} ${c.lineStopped}`;
    case "peopleFound":
      return `${lead} ${found ?? 0} ${c.lineFound}`;
    case "revealing":
      return `${lead} ${c.lineRevealing}`;
    case "peopleReady":
      return `${lead} ${c.lineReady}`;
    default:
      return null;
  }
}
