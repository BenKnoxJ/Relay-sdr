import { campaignsCopy } from "@/lib/copy/campaigns";
import {
  CAMPAIGN_STEPS,
  stepIndexFor,
  type CampaignState,
  type CampaignStep,
} from "@/lib/campaigns/state";
import { cn } from "@/lib/utils";

/**
 * The state machine as a quiet row of steps, with the current one marked
 * (§23.1c, mock 3b).
 *
 * Seven steps and no more. `stopped` and `paused` are not steps: a stopped
 * campaign marks Researching in the warn colour and renames it, because the
 * rep's question is "where did this get to", and inventing an eighth box would
 * answer a different one.
 *
 * It is a list, not a row of spans. A screen reader gets "step 3 of 7" out of
 * an ordered list and nothing at all out of styled text.
 */

const LABELS: Record<CampaignStep, string> = {
  brief: campaignsCopy.stepBrief,
  researching: campaignsCopy.stepResearching,
  planReady: campaignsCopy.stepPlanReady,
  findingPeople: campaignsCopy.stepFindingPeople,
  drafting: campaignsCopy.stepDrafting,
  running: campaignsCopy.stepRunning,
  done: campaignsCopy.stepDone,
};

export function StateRow({ state }: { state: CampaignState }) {
  const current = stepIndexFor(state);
  const stopped = state === "stopped";

  return (
    <ol aria-label={campaignsCopy.stepsLabel} className="flex flex-wrap items-center gap-1.5">
      {CAMPAIGN_STEPS.map((step, index) => {
        const now = index === current;
        const label = stopped && step === "researching" ? campaignsCopy.stepStopped : LABELS[step];
        return (
          <li
            key={step}
            data-testid="state-step"
            aria-current={now ? "step" : undefined}
            /*
              Only the current step is a pill. The signed mock draws the rest
              as plain quiet text, and a filled chip on every step would make
              seven things compete for the one glance this row is for.
            */
            className={cn(
              "type-mono rounded-pill px-2 py-0.5 text-11",
              now && stopped
                ? "bg-warn-bg text-warn"
                : now
                  ? "bg-action text-on-action"
                  : "text-muted",
            )}
          >
            {label}
          </li>
        );
      })}
    </ol>
  );
}
