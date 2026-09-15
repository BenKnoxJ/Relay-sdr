import { isWaiting, stageLineOf } from "@/lib/campaigns/stageLine";
import type { CampaignSummaryFacts } from "@/lib/campaigns/types";
import { campaignsCopy } from "@/lib/copy/campaigns";
import { cn } from "@/lib/utils";

/**
 * The one line under a campaign's title that says where it is and what exists
 * (product-truth pass): the same words the list row and Home carry, read from
 * the backend's summary facts, at the size a rep reads first. A queued job
 * reads as waiting, never as running.
 */
export function StageSummary({ facts }: { facts: CampaignSummaryFacts | undefined }) {
  if (facts === undefined) return null;
  const line = stageLineOf(facts);
  const warn = facts.attention !== null;
  const running = facts.inFlight !== null && !isWaiting(facts);
  return (
    <div data-testid="stage-summary" className="min-w-0 [overflow-wrap:anywhere]">
      {line === null ? null : (
        <p data-testid="stage-line" className={cn("type-body-large", warn ? "text-warn" : "text-ink")}>
          {line}
        </p>
      )}
      {running ? (
        <p data-testid="stage-activity" className="type-small mt-0.5 text-muted">
          {campaignsCopy.summaryRunning}
        </p>
      ) : null}
    </div>
  );
}
