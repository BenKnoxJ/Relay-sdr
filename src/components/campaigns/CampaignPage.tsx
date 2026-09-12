"use client";

import { useState } from "react";
import Link from "next/link";

import { Card } from "@/components/Card";
import { PageHeader } from "@/components/PageHeader";
import { PillButton } from "@/components/PillButton";
import { actionFor, answersFor, type CampaignState } from "@/lib/campaigns/state";
import { campaignsCopy } from "@/lib/copy/campaigns";
import type { Campaign } from "@/lib/fixtures/campaigns";

import { AskRelay } from "./AskRelay";
import { BriefCard } from "./BriefCard";
import { PlanSection } from "./PlanCards";
import { ProgressCounts } from "./ProgressCounts";
import { StateRow } from "./StateRow";
import { WidenCard } from "./WidenCard";

/**
 * The campaign page, in its four signed states (§23.1c, mock 3b and 3c).
 *
 * Top to bottom, and the order is the signed one: header with the steps and
 * ONE action matching the state; the brief; Ask Relay; the plan and the
 * research behind it; progress; people. Two states reorder that, and the signed
 * section says so in as many words: Plan ready leads with the plan, and Running
 * leads with progress and folds the plan away.
 *
 * A client component because the page holds state: which plan card is open,
 * which question was asked, and what the one action did. On fixtures the
 * action changes this component's state and says so, and nothing else: nothing
 * on this page sends anything and nothing on it spends (§23.1c, last line).
 * That is why there is no server action here to review — there is no write to
 * make yet, and inventing one would be inventing a `Campaign` model too.
 */

export function CampaignPage({
  campaign,
  banner = null,
}: {
  campaign: Campaign;
  /** A line the route arrived with, such as Start's "nothing was bought or sent". */
  banner?: string | null;
}) {
  const [state, setState] = useState<CampaignState>(campaign.state);
  const [toast, setToast] = useState<string | null>(banner);
  const [about, setAbout] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);

  const action = actionFor(state);
  /*
    Recomputed from the state the SCREEN is in, not from the state the campaign
    arrived in. Pause moves the page and the six answers together, and an Ask
    Relay that still said "nothing is paused" the moment after the rep paused it
    would be the one thing on this page a rep could catch lying.
  */
  const answers = answersFor(state, campaign);
  /** Answers by id, never by position: `answersFor` is free to reorder them. */
  const answerTo = (...ids: string[]) =>
    ids
      .map((id) => answers.find((answer) => answer.id === id)?.answer)
      .filter((line) => line !== undefined)
      .join(" ");
  const leadsWithProgress = state === "running" || state === "paused" || state === "done";
  // Read only after confirm (§23.1c): the plan stops being a Confirm screen the
  // moment it has been confirmed, and "Change something" is the only edit left.
  const planIsConfirmScreen = state === "planReady";

  /*
    The note is kept word for word, as the dialog promises. On fixtures there
    is nowhere to keep it but the screen, so the screen is where it is kept:
    dropping it would make the placeholder under the box a lie.
  */
  const changeSomething = (reason: string, note: string) => {
    const said = note.trim() === "" ? reason : `${reason}${campaignsCopy.noteJoin}${note.trim()}`;
    setState("researching");
    setAbout(null);
    setChanging(false);
    setToast(`${said}${campaignsCopy.noteJoin}${campaignsCopy.toastConfirmed}`);
  };

  const askToChange = (title: string) => {
    setAbout(title);
    setChanging(true);
  };

  const progress = (
    <Card label={campaignsCopy.progressLabel}>
      <ProgressCounts
        progress={campaign.progress}
        /*
          The line under the counts is the same two answers Ask Relay gives to
          "what is waiting on me" and "when does the next batch go" — written
          once, in the copy file, and read here rather than restated.
        */
        note={state === "running" ? answerTo("waiting", "next-batch") : undefined}
      />
    </Card>
  );

  const plan =
    campaign.pack === null || state === "stopped" || state === "researching" || state === "brief" ? null : (
      <PlanSection
        pack={campaign.pack}
        collapsed={leadsWithProgress}
        onChangeAbout={planIsConfirmScreen ? askToChange : undefined}
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
        <p className="type-small text-muted">{campaignsCopy.peopleBeforeConfirm}</p>
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
          <Link
            href={`/campaigns/${campaign.id}/people`}
            className="type-small mt-2.5 inline-block text-action focus-visible:outline-none focus-visible:ring-2"
          >
            {campaignsCopy.peopleLink}
          </Link>
        </>
      )}
    </Card>
  );

  const brief = (
    <BriefCard
      brief={campaign.brief}
      summary={leadsWithProgress ? campaign.motionLine : undefined}
      open={changing}
      about={about}
      onOpenChange={(isOpen) => {
        setChanging(isOpen);
        if (!isOpen) setAbout(null);
      }}
      onChange={changeSomething}
    />
  );

  const ask = <AskRelay questions={answers} />;

  /*
    The order is the state's, not the file's (§23.1c, "By state").

    Plan ready leads with the plan, because the plan section IS the Confirm
    screen and the rep is here to read it. Running leads with progress and
    folds the plan, because the decision is made and the question is how it is
    going. Researching and the stop have no plan to lead with at all: one has
    not been written and the other could not be.
  */
  const column =
    state === "planReady"
      ? [plan, brief, ask]
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
          <StateRow state={state} />
        </div>
        {action === null ? null : (
          <PillButton
            variant={state === "running" ? "outline" : "primary"}
            onClick={() => {
              setState(action.next);
              setToast(campaignsCopy.toastConfirmed);
            }}
          >
            {action.label}
          </PillButton>
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

      {state === "stopped" && campaign.pack?.insufficient !== undefined ? (
        <div className="mb-grid">
          <WidenCard insufficient={campaign.pack.insufficient} found={campaign.pack.stopEvidence ?? []} />
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
