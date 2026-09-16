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
export function StageSummary({
  facts,
  detail,
  quietWhenAttention = false,
}: {
  facts: CampaignSummaryFacts | undefined;
  /** A page-only addition to the line, such as the recommended play's name on Plan ready. */
  detail?: string | null;
  /** On the campaign page the card beneath carries the reason in full, so the line steps back rather than say it twice. */
  quietWhenAttention?: boolean;
}) {
  if (facts === undefined) return null;
  const warn = facts.attention !== null;
  const base = warn && quietWhenAttention ? null : stageLineOf(facts);
  const line = base === null ? null : detail === undefined || detail === null ? base : `${base}${campaignsCopy.noteJoin}${detail}`;
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
