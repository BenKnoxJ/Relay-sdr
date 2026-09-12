import { notFound, redirect } from "next/navigation";

import { StartForm } from "@/components/campaigns/StartForm";
import { HOW_LONG, HOW_MANY, PRODUCTS, REGIONS } from "@/lib/campaigns/start";
import { getCampaign } from "@/server/campaigns";

import { editBrief } from "../actions";

/**
 * Edit brief (orchestrator A1, item 5; §23.1c "(2) The brief").
 *
 * Start's card, opened on the campaign's current brief: the rep changes the
 * fields themselves, and pressing the button makes the next brief version and
 * asks research to read around it. It replaces "Change something" and its
 * reason picker.
 *
 * Offered from Plan ready, a stop and needs you. A campaign whose research is
 * still reading has no brief to change yet, so the page sends the rep back to
 * it rather than opening a card whose press would be refused.
 */
export default async function EditBriefPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const campaign = await getCampaign(id);
  if (campaign === null) notFound();
  if (!campaign.can.edit) redirect(`/campaigns/${campaign.id}`);

  return (
    <StartForm
      // A new version is a new card: nothing typed against the old one survives.
      key={campaign.briefVersion}
      sentence=""
      prefilled={{ ...campaign.brief, guessed: [] }}
      products={PRODUCTS}
      regions={REGIONS}
      howMany={HOW_MANY}
      howLong={HOW_LONG}
      mailboxConnected
      onStart={editBrief.bind(null, { campaignId: campaign.id, briefVersion: campaign.briefVersion })}
      edit={{ campaignName: campaign.name, cancelHref: `/campaigns/${campaign.id}` }}
    />
  );
}
