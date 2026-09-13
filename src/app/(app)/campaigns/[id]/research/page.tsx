import { notFound, redirect } from "next/navigation";

import { ResearchPage } from "@/components/campaigns/ResearchPage";
import { ResearchReport } from "@/components/campaigns/ResearchReport";
import { getCampaignResearch } from "@/server/campaigns";

/**
 * What Relay learned (task 19): everything research found for one campaign.
 *
 * Reached from the campaign's Overview. Only a finished plan (complete, or
 * partial with the missing parts named) has research to read; a campaign
 * still researching, stopped or needing the rep is sent back to its page,
 * which says why. An id that is not one of the rep's campaigns is a 404.
 *
 * The printed pack (task 20) is drawn beside the page from the same research,
 * and is what prints: the page is for the screen, the pack is for paper.
 */
export default async function CampaignResearchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await getCampaignResearch(id);
  if (page === null) notFound();
  if (page.research === null) redirect(`/campaigns/${page.id}`);

  return (
    <>
      <ResearchPage name={page.name} campaignHref={`/campaigns/${page.id}`} research={page.research} />
      <ResearchReport page={page} research={page.research} />
    </>
  );
}
