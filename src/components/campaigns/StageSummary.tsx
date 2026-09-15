import type { ActivityView, StageSummary as StageSummaryView } from "@/lib/campaigns/types";
import { campaignsCopy } from "@/lib/copy/campaigns";
import { cn } from "@/lib/utils";

/**
 * The one line under a campaign's title that says where it is and what exists
 * (product-truth pass): the same words the list row and Home carry, at the
 * size a rep reads first. A queued job reads as waiting, never as running;
 * a running one says when it started, when the queue recorded that.
 */
export function StageSummary({ summary, activity, when }: { summary: StageSummaryView; activity: ActivityView | null; when?: (iso: string) => string }) {
  const warn = summary.bucket === "needsYou";
  const since = activity?.phase === "running" && activity.since !== null && when !== undefined ? when(activity.since) : null;
  return (
    <div data-testid="stage-summary" className="min-w-0 [overflow-wrap:anywhere]">
      {summary.line === null ? null : (
        <p data-testid="stage-line" className={cn("type-body-large", warn ? "text-warn" : "text-ink")}>
          {summary.line}
        </p>
      )}
      {activity === null ? null : (
        <p data-testid="stage-activity" className="type-small mt-0.5 text-muted">
          {activity.phase === "waiting" ? campaignsCopy.summaryWaiting : `${campaignsCopy.summaryRunning}${since === null ? "" : ` ${campaignsCopy.activitySince} ${since}`}`}
        </p>
      )}
    </div>
  );
}
