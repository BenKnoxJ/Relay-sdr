import Link from "next/link";

import { Chip } from "@/components/Chip";
import { bucketOfRow, stageLineOf } from "@/lib/campaigns/stageLine";
import type { CampaignSummary } from "@/lib/campaigns/types";
import { campaignsCopy } from "@/lib/copy/campaigns";
import { cn } from "@/lib/utils";

/**
 * One campaign in the list (§23.1c, mock 3a; product-truth pass).
 *
 * Left to right: the name with, under it, the one line of what Relay has
 * ("9 people at 9 accounts · 5 to review", "Waiting to start"); the state
 * chip; and the "next" line, which is the same sentence the campaign page's
 * action button uses. The whole row is the link: the mock draws no separate
 * "open" control.
 *
 * The line falls back to the brief's own line (motion, product, size,
 * channels) only when the summary has nothing yet. A contacted count is drawn
 * only once someone has been contacted: "0 of 20" reads as progress, and
 * there has been none. There is no "nothing sent yet" column, because a row
 * that says what is happening does not need to also say what is not.
 */
export function CampaignRow({ campaign }: { campaign: CampaignSummary }) {
  const facts = campaign.facts;
  const bucket = bucketOfRow(campaign);
  const line = (facts === undefined ? null : stageLineOf(facts)) ?? campaign.motionLine;
  const contacted =
    campaign.contacted !== null && campaign.contacted > 0
      ? `${campaign.contacted} ${campaignsCopy.of} ${campaign.total} ${campaignsCopy.contacted}`
      : null;

  return (
    <Link
      href={`/campaigns/${campaign.id}`}
      data-testid="campaign-row"
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-row-x py-row-y",
        "transition-colors duration-micro ease-standard hover:bg-soft",
        "focus-visible:outline-none focus-visible:ring-2",
      )}
    >
      <span className="min-w-[240px] flex-1">
        <span className="type-name block">{campaign.name}</span>
        <span className="type-small block text-muted">
          {line}
          {contacted === null ? null : `${campaignsCopy.noteJoin}${contacted}`}
        </span>
      </span>

      <Chip tone={bucket === "needsYou" ? "warn" : bucket === "ready" ? "ok" : "default"}>{campaign.chip}</Chip>

      <span
        data-testid="campaign-next"
        className={cn("type-small sm:w-[200px] sm:text-right", campaign.nextIsAction ? "text-action" : "text-muted")}
      >
        {campaignsCopy.nextPrefix} {campaign.next}
      </span>
    </Link>
  );
}
