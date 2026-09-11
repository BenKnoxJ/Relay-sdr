import { notFound } from "next/navigation";

import { CampaignPage } from "@/components/campaigns/CampaignPage";
import { campaignsCopy } from "@/lib/copy/campaigns";
import { getCampaign } from "@/lib/fixtures/campaigns";

/**
 * One campaign (master doc §23.1c, mock 3b and 3c).
 *
 * The page resolves the campaign and hands it over whole; every state the
 * screen has is a state of that one object. An id that is not a campaign is a
 * 404 rather than an empty page, because a campaign page with no campaign on
 * it is a screen that says nothing true.
 */
export default async function CampaignDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const campaign = getCampaign(id);
  if (campaign === null) notFound();

  // Start sends the rep here and promises nothing was bought or sent (§23.1d).
  // The promise is kept on arrival rather than on the page they left.
  const justStarted = (await searchParams).started === "1";

  return <CampaignPage campaign={campaign} banner={justStarted ? campaignsCopy.toastStarted : null} />;
}
