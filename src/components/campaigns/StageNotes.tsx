import Link from "next/link";

import { Card } from "@/components/Card";
import { failureLine } from "@/lib/campaigns/state";
import type { CampaignSummaryFacts, InFlightWork, ResearchFailure } from "@/lib/campaigns/types";
import { campaignsCopy } from "@/lib/copy/campaigns";
import { researchCopy } from "@/lib/copy/research";

/**
 * The campaign page's main area in the states where Relay is working or
 * could not finish (product-truth pass). Each says truthfully what is
 * happening, from the backend's in-flight facts: a queued job is waiting, a
 * running one is running, and what Relay is producing is a plain list rather
 * than a bar that would be a guess.
 */

const waiting = (work: InFlightWork | null | undefined) => work?.status === "queued";

/** Researching: waiting or reading, how long it usually takes, and what comes out of it. */
export function ResearchingCard({ inFlight }: { inFlight: InFlightWork | null | undefined }) {
  const c = campaignsCopy;
  return (
    <Card label={c.stepResearching}>
      <p data-testid="researching-note" className="type-body">
        {waiting(inFlight) ? c.researchingWaiting : c.researchingRunning} {c.researchingUsually}
      </p>
      <p className="type-label mb-1.5 mt-3">{c.researchingProducesLabel}</p>
      <ul data-testid="researching-produces" className="grid gap-1">
        {c.researchingProduces.map((line) => (
          <li key={line} className="type-small text-muted">
            {line}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Finding accounts and people (lead gen v2.2): the search, in order, the play it is for, its limit, and that nothing is bought. */
export function FindingCard({ inFlight, groupName, cap }: { inFlight: InFlightWork | null | undefined; groupName: string | null; cap: number | null }) {
  const c = campaignsCopy;
  return (
    <Card label={c.findingLabel}>
      <p data-testid="finding-note" className="type-body">
        {waiting(inFlight) ? c.findingWaiting : c.findingRunning}
        {groupName === null ? "" : ` ${c.peopleFoundFor} ${groupName}.`}
      </p>
      <ol data-testid="finding-steps" className="mt-3 grid list-decimal gap-1 pl-5">
        {c.findingSteps.map((line) => (
          <li key={line} className="type-small">
            {line}
          </li>
        ))}
      </ol>
      <p className="type-small mt-3 text-muted">
        {c.findingQuality}
        {cap === null ? "" : ` ${c.findingCap}: ${cap} ${c.confirmCredits}.`} {c.findingNothingBought}
      </p>
    </Card>
  );
}

/**
 * Research needs the rep: it did not finish, could not be read, or finished
 * without a play that can be searched. The backend's failure decides the
 * words; what the rep can do is Try again where the server allows it, and
 * Edit brief always. A finished pack with no searchable play is still worth
 * reading, so that keeps its way in.
 */
export function ResearchNeedsYouCard({
  failure,
  facts,
  canRetry,
  editHref,
  researchHref,
}: {
  failure: ResearchFailure | null;
  facts: CampaignSummaryFacts | undefined;
  canRetry: boolean;
  editHref?: string;
  researchHref?: string;
}) {
  const c = campaignsCopy;
  const noPlay = failure === "no_play";
  const research = facts?.research ?? null;
  return (
    <Card label={noPlay ? c.playsIncompleteLabel : c.stepNeedsYou}>
      <p data-testid={noPlay ? "incomplete-note" : "failed-note"} className="type-body text-warn">
        {failureLine(failure)} {c.failedNothingSpent} {noPlay ? "" : canRetry ? c.failedNextRetry : c.failedNextEdit}
      </p>
      {noPlay && research !== null ? (
        <p data-testid="incomplete-parts" className="type-small mt-2 text-muted">
          {research.outcome === "partial" ? `${c.planPartialShort} ` : ""}
          {research.plays} {research.plays === 1 ? c.summaryPlay : c.summaryPlays}
          {c.noteJoin}
          {research.viablePlays} {c.playsSearchable}.
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-4">
        {editHref === undefined ? null : (
          <Link href={editHref} data-testid="incomplete-edit" className="type-small inline-flex min-h-6 items-center font-semibold text-action focus-visible:outline-none focus-visible:ring-2">
            {c.editBrief}
          </Link>
        )}
        {noPlay && researchHref !== undefined ? (
          <Link href={researchHref} data-testid="incomplete-research" className="type-small inline-flex min-h-6 items-center font-semibold text-action focus-visible:outline-none focus-visible:ring-2">
            {researchCopy.openLink}
          </Link>
        ) : null}
      </div>
    </Card>
  );
}

/** Revealing emails stopped and needs the rep: the backend's reason, in words, and what can be done about it. A held or ambiguous charge is never dressed as an ordinary retry. */
export function RevealNeedsYouCard({ line, retryable, editHref }: { line: string; retryable: boolean; editHref?: string }) {
  const c = campaignsCopy;
  return (
    <Card label={c.revealNeedsYouLabel}>
      <p data-testid="reveal-stopped" className="type-body text-warn">
        {line}
      </p>
      <p className="type-small mt-2 text-muted">{retryable ? c.revealNeedsYouRetry : c.revealNeedsYouNoRetry}</p>
      {editHref === undefined ? null : (
        <Link href={editHref} data-testid="reveal-edit" className="type-small mt-3 inline-flex min-h-6 items-center font-semibold text-action focus-visible:outline-none focus-visible:ring-2">
          {c.editBrief}
        </Link>
      )}
    </Card>
  );
}
