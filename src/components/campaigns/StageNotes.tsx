import Link from "next/link";

import { Card } from "@/components/Card";
import type { ActivityView, CampaignOverview } from "@/lib/campaigns/types";
import { campaignsCopy } from "@/lib/copy/campaigns";

/**
 * The campaign page's main area in the states where Relay is working or
 * could not finish (product-truth pass). Each says truthfully what is
 * happening: a queued job is waiting, a running one is running, and what
 * Relay is producing is a plain list rather than a bar that would be a guess.
 */

/** Researching: waiting or reading, how long it usually takes, and what comes out of it. */
export function ResearchingCard({ activity }: { activity: ActivityView | null }) {
  const c = campaignsCopy;
  const waiting = activity?.phase === "waiting";
  return (
    <Card label={c.stepResearching}>
      <p data-testid="researching-note" className="type-body">
        {waiting ? c.researchingWaiting : c.researchingRunning} {c.researchingUsually}
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
export function FindingCard({ activity, groupName, cap }: { activity: ActivityView | null; groupName: string | null; cap: number | null }) {
  const c = campaignsCopy;
  const waiting = activity?.phase === "waiting";
  return (
    <Card label={c.findingLabel}>
      <p data-testid="finding-note" className="type-body">
        {waiting ? c.findingWaiting : c.findingRunning}
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
 * Research finished without ranking a play: not Plan ready, and nothing to
 * confirm. What it did write is in the support rail; this says what is
 * missing and the two things the rep can do.
 */
export function PlanIncompleteCard({ overview, editHref }: { overview: CampaignOverview; editHref?: string }) {
  const c = campaignsCopy;
  const total = Object.keys(c.partNames).length;
  const missing = overview.partial;
  return (
    <Card label={c.playsIncompleteLabel}>
      <p data-testid="incomplete-note" className="type-body text-warn">
        {c.playsNoPlay}
      </p>
      {missing.length === 0 ? null : (
        <p data-testid="incomplete-parts" className="type-small mt-2 text-muted">
          {total - missing.length} {c.playsIncompleteWritten} · {missing.length} {c.playsIncompleteMissing}: {missing.map((id) => (c.partNames as Record<string, string>)[id] ?? id).join(", ")}.
        </p>
      )}
      <p className="type-small mt-2">{c.playsIncompleteNext}</p>
      {editHref === undefined ? null : (
        <Link href={editHref} data-testid="incomplete-edit" className="type-small mt-3 inline-flex min-h-6 items-center font-semibold text-action focus-visible:outline-none focus-visible:ring-2">
          {c.editBrief}
        </Link>
      )}
    </Card>
  );
}
