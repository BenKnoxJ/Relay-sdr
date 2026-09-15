import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { StartForm } from "@/components/campaigns/StartForm";
import { activeFactsVersion, type ActiveFactsVersion } from "@/lib/campaigns/factsVersion";
import { HOW_LONG, HOW_MANY, PRODUCTS, REGIONS } from "@/lib/campaigns/start";
import { dateLabel } from "@/lib/shell";
import { createContextFromHeaders } from "@/server/api/trpc";
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

/**
 * The facts version the org has activated for the product, or null. The same
 * read as Start's page makes: see `src/app/(app)/campaigns/new/page.tsx`.
 *
 * The org is the session's, resolved the way every procedure resolves it
 * (`ctx.actor()`), and the read is `activeFactsVersion` on the context's own
 * client. No router exposes the org id to a page, and adding a procedure for
 * one read-only row would be more machinery than the row; this is the same
 * context `serverCaller()` builds, one call further in.
 */
async function activeFacts(product: string): Promise<ActiveFactsVersion | null> {
  const ctx = await createContextFromHeaders(await headers());
  if (ctx.session === null) return null;
  const { orgId } = await ctx.actor();
  return activeFactsVersion(ctx.prisma, orgId, product, dateLabel);
}
export default async function EditBriefPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const campaign = await getCampaign(id);
  if (campaign === null) notFound();
  if (!campaign.can.edit) redirect(`/campaigns/${campaign.id}`);
  const facts = await activeFacts(campaign.brief.product);

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
      facts={facts}
      mailboxConnected
      onStart={editBrief.bind(null, { campaignId: campaign.id, briefVersion: campaign.briefVersion })}
      edit={{ campaignName: campaign.name, cancelHref: `/campaigns/${campaign.id}` }}
    />
  );
}
