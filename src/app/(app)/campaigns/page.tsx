import Link from "next/link";

import { Card } from "@/components/Card";
import { CampaignRow } from "@/components/campaigns/CampaignRow";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { campaignsCopy } from "@/lib/copy/campaigns";
import { emptyCopy } from "@/lib/copy/empty";
import { listCampaigns } from "@/server/campaigns";

/**
 * The Campaigns list (master doc §23.1c, mock 3a).
 *
 * One row per campaign, newest first, and nothing else: no search, no folders,
 * no archive, and Done campaigns stay in the list. The day-one empty state
 * built in 9b is still here and still the truth when there are no campaigns.
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

  return (
    <>
      {/*
        No "New campaign" here: a rep with a campaign has it in the nav pill,
        top right, which is where the signed mock draws it (3a). The empty
        branch above keeps its own way in, which is Home's brief box.
      */}
      <PageHeader
        title={campaignsCopy.title}
        note={`${counts.running} ${campaignsCopy.noteRunning}${campaignsCopy.noteJoin}${counts.done} ${campaignsCopy.noteDone}`}
      />

      <Card className="p-0">
        {campaigns.map((campaign) => (
          <CampaignRow key={campaign.id} campaign={campaign} />
        ))}
      </Card>
    </>
  );
}
