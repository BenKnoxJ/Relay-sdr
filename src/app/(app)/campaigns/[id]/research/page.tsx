import { notFound, redirect } from "next/navigation";

import { ResearchPage } from "@/components/campaigns/ResearchPage";
import { getCampaignResearch } from "@/server/campaigns";

/**
 * What Relay learned (task 19): everything research found for one campaign.
 *
 * Reached from the campaign's Overview. Only a finished plan (complete, or
 * partial with the missing parts named) has research to read; a campaign
 * still researching, stopped or needing the rep is sent back to its page,
 * which says why. An id that is not one of the rep's campaigns is a 404.
 */
export default async function CampaignResearchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await getCampaignResearch(id);
  if (page === null) notFound();
  if (page.research === null) redirect(`/campaigns/${page.id}`);

  return <ResearchPage name={page.name} campaignHref={`/campaigns/${page.id}`} research={page.research} />;
}
