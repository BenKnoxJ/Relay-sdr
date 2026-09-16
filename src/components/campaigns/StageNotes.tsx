import { Card } from "@/components/Card";
import { TextLink } from "@/components/TextButton";
import { failureLine } from "@/lib/campaigns/state";
import { draftsLineOf } from "@/lib/campaigns/stageLine";
import type { CampaignAttention, CampaignSpendView, CampaignStage, CampaignSummaryFacts, FindingView, InFlightWork, ResearchFailure } from "@/lib/campaigns/types";
import { campaignsCopy } from "@/lib/copy/campaigns";
import { researchCopy } from "@/lib/copy/research";
import { timeLabel } from "@/lib/shell";
import { cn } from "@/lib/utils";

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

/**
 * Finding accounts and people (lead gen v2.2; final MVP pass): the search as
 * it was frozen at Confirm, the roles it looks for, the firms it starts from,
 * whether it is waiting its turn or running, and what it has used so far.
 * Everything here is a fact Relay holds; nothing is a bar or a guess at how
 * far along it is. Emails are not bought here.
 */
export function FindingCard({ inFlight, finding, groupName, spend }: { inFlight: InFlightWork | null | undefined; finding: FindingView | null; groupName: string | null; spend: CampaignSpendView["search"] | null }) {
  const c = campaignsCopy;
  const queued = waiting(inFlight);
  const name = finding?.groupName ?? groupName;
  const started = finding?.since === null || finding?.since === undefined ? "" : timeLabel(finding.since);
  const cap = finding?.credits.cap ?? spend?.cap ?? null;
  return (
    <Card label={c.findingLabel}>
      <p data-testid="finding-note" className="type-body max-w-measure">
        {queued ? c.findingWaiting : c.findingRunning}
        {name === null ? "" : ` ${c.peopleFoundFor} ${name}.`}
      </p>
      {queued ? <p className="type-small mt-1 max-w-measure text-muted">{c.findingQueuedNote}</p> : null}
      {finding === null ? null : (
        <dl data-testid="finding-search" className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
          <dt className="type-small text-muted">{c.findingSearchLead}</dt>
          <dd className="type-small max-w-measure [overflow-wrap:anywhere]">{finding.search.replace(`${c.accountFitSearch} `, "")}</dd>
          {finding.buyerRoles.length === 0 ? null : (
            <>
              <dt className="type-small text-muted">{c.findingRolesLead}</dt>
              <dd className="type-small max-w-measure">{finding.buyerRoles.map((role) => `${c.roleParts[role.part]} · ${role.title}`).join(c.noteJoin)}</dd>
            </>
          )}
          {finding.seedFirms === 0 ? null : (
            <>
              <dt className="type-small text-muted">{c.findingSeedsLead}</dt>
              <dd className="type-small">
                {finding.seedFirms} {finding.seedFirms === 1 ? c.findingSeedsOne : c.findingSeedsMany}
              </dd>
            </>
          )}
        </dl>
      )}
      <ol data-testid="finding-steps" className="mt-3 grid list-decimal gap-1 pl-5">
        {c.findingSteps.map((line) => (
          <li key={line} className="type-small max-w-measure">
            {line}
          </li>
        ))}
      </ol>
      <div data-testid="finding-spend" className="mt-3 grid gap-0.5 border-t border-line pt-3">
        <p className="type-small text-muted">
          {c.findingQuality}
          {cap === null ? "" : ` ${c.findingCap}: ${cap} ${c.confirmCredits}.`} {c.findingNothingBought}
        </p>
        {spend !== null && spend.held > 0 ? (
          <p data-testid="finding-held" className="type-mono text-13">
            {c.findingHeldLead} {spend.held} {c.spendCreditsWord}
          </p>
        ) : null}
        {spend !== null && spend.charged > 0 ? (
          <p data-testid="finding-charged" className="type-mono text-13">
            {c.findingChargedLead} {spend.charged} {c.spendCreditsWord}
          </p>
        ) : null}
        {!queued && started !== "" ? (
          <p data-testid="finding-started" className="type-mono text-13 text-muted">
            {c.findingStartedLead} {started}
          </p>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * First emails (outreach v2.1): being drafted, drafted and waiting in the
 * Inbox, or approved and ready to send. The counts are the backend's; the
 * drafts themselves are read and decided in the Inbox, never here. Nothing
 * is sent.
 */
export function DraftingCard({ stage, inFlight, drafts, attention, editHref }: { stage: CampaignStage; inFlight: InFlightWork | null; drafts: NonNullable<CampaignSummaryFacts["drafts"]>; attention: CampaignAttention | null; editHref?: string }) {
  const c = campaignsCopy;
  const line = draftsLineOf(drafts);
  const exhausted = attention?.reason === "drafts_exhausted";
  // Queued reads as waiting only while nothing has been drafted yet.
  const queued = waiting(inFlight) && draftsLineOf({ ...drafts, writing: 0 }) === null;
  return (
    <Card label={c.draftsLabel}>
      <p data-testid="drafts-note" className={cn("type-body max-w-measure", exhausted ? "text-warn" : "")}>
        {exhausted ? c.draftsExhausted : stage === "drafting" ? (queued ? `${c.summaryWaiting}. ${c.findingQueuedNote}` : c.draftingNote) : stage === "ready_to_send" ? c.readyToSendNote : c.draftsReadyNote}
      </p>
      {line === null ? null : (
        <p data-testid="drafts-counts" className="type-small mt-1.5">
          {line}
        </p>
      )}
      <p className="type-small mt-1.5 text-muted">{c.draftsNothingSent}</p>
      <div className="mt-3 flex flex-wrap gap-4">
        {stage === "drafting" && drafts.toReview + drafts.needsYou === 0 ? null : (
          <TextLink href="/inbox" data-testid="drafts-review">
            {c.draftsReviewLink}
          </TextLink>
        )}
        {exhausted && editHref !== undefined ? (
          <TextLink href={editHref} data-testid="drafts-edit">
            {c.editBrief}
          </TextLink>
        ) : null}
      </div>
    </Card>
  );
}

/** Revealing emails, while it runs: waiting its turn or running, and that nothing is sent. */
export function RevealingCard({ inFlight }: { inFlight: InFlightWork | null | undefined }) {
  const c = campaignsCopy;
  return (
    <Card label={c.revealingLabel}>
      <p data-testid="revealing-note" className="type-body max-w-measure">
        {waiting(inFlight) ? `${c.summaryWaiting}. ${c.findingQueuedNote}` : c.revealingNote}
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
      <p data-testid={noPlay ? "incomplete-note" : "failed-note"} className="type-body max-w-measure text-warn">
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
          <TextLink href={editHref} data-testid="incomplete-edit">
            {c.editBrief}
          </TextLink>
        )}
        {noPlay && researchHref !== undefined ? (
          <TextLink href={researchHref} data-testid="incomplete-research">
            {researchCopy.openLink}
          </TextLink>
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
      <p data-testid="reveal-stopped" className="type-body max-w-measure text-warn">
        {line}
      </p>
      <p className="type-small mt-2 text-muted">{retryable ? c.revealNeedsYouRetry : c.revealNeedsYouNoRetry}</p>
      {editHref === undefined ? null : (
        <TextLink href={editHref} data-testid="reveal-edit" className="mt-3">
          {c.editBrief}
        </TextLink>
      )}
    </Card>
  );
}
