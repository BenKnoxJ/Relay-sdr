import { notFound } from "next/navigation";

import { CampaignPage } from "@/components/campaigns/CampaignPage";
import { campaignsCopy } from "@/lib/copy/campaigns";
import { getCampaign } from "@/server/campaigns";

/**
 * One campaign (master doc §23.1c, mock 3b and 3c).
 *
 * The page resolves the campaign and hands it over whole; every state the
 * screen has is a state of that one object, derived on the server from the
 * campaign and its research. An id that is not one of the rep's campaigns is a
 * 404 rather than an empty page.
 */
export default async function CampaignDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const campaign = await getCampaign(id);
  if (campaign === null) notFound();

  // Start sends the rep here and says research has started and nothing was
  // bought or sent (§23.1d). The line is shown on arrival.
  const justStarted = (await searchParams).started === "1";

  return <CampaignPage campaign={campaign} banner={justStarted ? campaignsCopy.toastStarted : null} />;
}
