import Link from "next/link";

import { Card } from "@/components/Card";
import { CampaignRow } from "@/components/campaigns/CampaignRow";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import type { CampaignSummary } from "@/lib/campaigns/types";
import { sortForList, type ListCounts } from "@/lib/campaigns/view";
import { campaignsCopy } from "@/lib/copy/campaigns";
import { emptyCopy } from "@/lib/copy/empty";
import { listCampaigns } from "@/server/campaigns";

type Bucket = CampaignSummary["summary"]["bucket"];

/**
 * The header note: only the buckets with something in them, in the order the
 * rep cares about them. "1 needs you · 2 to decide · 1 working". Never
 * "running" for a campaign that has not finished: research is not running,
 * it is reading, and a queued job is waiting.
 */
function headerNote(counts: ListCounts): string {
  const parts: [number, string][] = [
    [counts.needsYou, campaignsCopy.bucketNeedsYou],
    [counts.decide, campaignsCopy.bucketDecide],
    [counts.working, campaignsCopy.bucketWorking],
    [counts.ready, campaignsCopy.bucketReady],
    [counts.done, campaignsCopy.bucketDone],
  ];
  return parts
    .filter(([n]) => n > 0)
    .map(([n, word]) => `${n} ${word}`)
    .join(campaignsCopy.noteJoin);
}

/** The groups the list is read in. "In progress" is what is the rep's to decide and what Relay is doing, together. */
const GROUPS: { label: string; buckets: Bucket[] }[] = [
  { label: campaignsCopy.groupNeedsYou, buckets: ["needsYou"] },
  { label: campaignsCopy.groupInProgress, buckets: ["decide", "working"] },
  { label: campaignsCopy.groupReady, buckets: ["ready"] },
  { label: campaignsCopy.groupDone, buckets: ["done"] },
];

/**
 * The Campaigns list (master doc §23.1c, mock 3a; product-truth pass).
 *
 * One row per campaign, and nothing else: no search, no folders, no archive,
 * and Done campaigns stay in the list. What needs the rep comes first, then
 * what is theirs to decide and what Relay is doing, then what is ready, then
 * what is done; newest first within each. Empty groups are not drawn. The
 * day-one empty state built in 9b is still here and still the truth when
 * there are no campaigns.
 *
 * The rows are the rep's own campaigns, read through `src/server/campaigns.ts`.
 */
export default async function CampaignsPage() {
  const { campaigns, counts } = await listCampaigns();

  if (campaigns.length === 0) {
    return (
      <>
        <PageHeader title={emptyCopy.campaigns.title} note={emptyCopy.campaigns.note} />
        <Card className="p-0">
          <EmptyState heading={emptyCopy.campaigns.heading} body={emptyCopy.campaigns.body} className="pb-6" />
          {/*
            The one way in for a rep with no campaigns: the nav carries none
            until they have one. The primary pill's classes, as on the nav.
          */}
          <div className="pb-12 text-center">
            <Link
              href="/campaigns/new"
              className="inline-flex items-center justify-center rounded-pill border-control border-transparent bg-action px-4 py-2 text-13 font-semibold text-on-action transition-opacity duration-micro ease-standard hover:opacity-90 focus-visible:outline-none focus-visible:ring-2"
            >
              {campaignsCopy.newCampaign}
            </Link>
          </div>
        </Card>
      </>
    );
  }

  const sorted = sortForList(campaigns);
  const groups = GROUPS.map((group) => ({
    ...group,
    campaigns: sorted.filter((campaign) => group.buckets.includes(campaign.summary.bucket)),
  })).filter((group) => group.campaigns.length > 0);

  return (
    <>
      {/*
        No "New campaign" here: a rep with a campaign has it in the nav pill,
        top right, which is where the signed mock draws it (3a). The empty
        branch above keeps its own way in, which is Home's brief box.
      */}
      <PageHeader title={campaignsCopy.title} note={headerNote(counts)} />

      <Card className="p-0">
        {groups.map((group) => (
          <section key={group.label} aria-label={group.label} className="border-t border-line first:border-t-0">
            {/* A quiet label, not a heading of its own: the page has one h1 and the rows under it are the content. */}
            <p data-testid="campaign-group" className="type-label px-row-x pb-1 pt-row-y text-muted">
              {group.label}
            </p>
            {group.campaigns.map((campaign) => (
              <CampaignRow key={campaign.id} campaign={campaign} />
            ))}
          </section>
        ))}
      </Card>
    </>
  );
}
