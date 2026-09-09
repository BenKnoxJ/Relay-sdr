import Link from "next/link";

import { Chip } from "@/components/Chip";
import { campaignsCopy } from "@/lib/copy/campaigns";
import type { CampaignSummary } from "@/lib/fixtures/campaigns";
import { cn } from "@/lib/utils";

/**
 * One campaign in the list (§23.1c, mock 3a).
 *
 * Name, the one grey line, the state chip, contacted of total, and the "next"
 * line, which is the same sentence the campaign page's action button uses. The
 * whole row is the link: the mock draws no separate "open" control, and a link
 * around only the name would leave four fifths of the row dead.
 */
export function CampaignRow({ campaign }: { campaign: CampaignSummary }) {
  return (
    <Link
      href={`/campaigns/${campaign.id}`}
      data-testid="campaign-row"
      className={cn(
        "flex flex-wrap items-center gap-3 border-t border-line px-row-x py-row-y-loose first:border-t-0",
        "transition-colors duration-micro ease-standard hover:bg-soft",
        "focus-visible:outline-none focus-visible:ring-2",
      )}
    >
      <span className="min-w-[240px] flex-1">
        <span className="type-name block">{campaign.name}</span>
        <span className="type-small block text-muted">{campaign.motionLine}</span>
      </span>

      <Chip tone={campaign.state === "running" ? "ok" : campaign.state === "stopped" ? "warn" : "default"}>
        {campaign.chip}
      </Chip>

      <span className="type-mono w-[120px] text-right text-13 text-muted">
        {campaign.contacted} {campaignsCopy.of} {campaign.total}
        {campaign.state === "running" ? ` ${campaignsCopy.contacted}` : null}
      </span>

      <span
        data-testid="campaign-next"
        className={cn(
          "type-small w-[200px] text-right",
          campaign.nextIsAction ? "text-action" : "text-muted",
        )}
      >
        {campaignsCopy.nextPrefix} {campaign.next}
      </span>
    </Link>
  );
}
