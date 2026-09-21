import { headers } from "next/headers";

import { StartForm } from "@/components/campaigns/StartForm";
import { activeFactsVersion, type ActiveFactsVersion } from "@/lib/campaigns/factsVersion";
import { HOW_LONG, HOW_MANY, PRODUCTS, REGIONS, startFromSentence } from "@/lib/campaigns/start";
import { dateLabel } from "@/lib/shell";
import { serverCaller } from "@/server/api/caller";
import { createContextFromHeaders } from "@/server/api/trpc";

import { startCampaign } from "./actions";

/**
 * Start (master doc §23.1d, mock 3d).
 *
 * The page resolves one thing on the server: whether the rep's mailbox is
 * connected, read from the connections router. Start does not wait on it
 * (Relay P1): research sends nothing, so without a mailbox the card says only
 * that Outlook is needed before sending. Calls start off: there is no saved Calls preference yet, and a
 * default read from a fixture would put a channel in the brief the rep never
 * chose.
 *
 * The sentence arrives in the query string when the rep came from Home's brief
 * box, and is empty when they pressed "New campaign". Pressing Start submits
 * the card to `startCampaign`, which makes the campaign and its research job.
 *
 * The facts version beside the product is read from the org's row
 * (`activeFacts`), so the card names the version that is actually active or
 * says none is; it is never a literal.
 */

/**
 * The facts version the org has activated for the product, or null.
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
export default async function NewCampaignPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const caller = await serverCaller();
  const mailbox = await caller.connections.get();
  const facts = await activeFacts(PRODUCTS[0]?.name ?? "");
  const params = await searchParams;

  // `String(…)` and not a cast: a repeated parameter arrives as an array, and
  // the sentence it would make is the array's own comma-joined spelling.
  const said = typeof params.said === "string" ? params.said : "";

  /*
    `key` is the whole of the Edit button working. Editing the sentence
    navigates back to this page with the new one in the query string, which
    re-runs the pre-fill on the server — but a search-param navigation does not
    remount a client component, so without a key the card would keep the state
    it was first mounted with and the new pre-fill would never appear.
  */
  return (
    <StartForm
      key={said}
      sentence={said}
      prefilled={startFromSentence(said)}
      products={PRODUCTS}
      regions={REGIONS}
      howMany={HOW_MANY}
      howLong={HOW_LONG}
      facts={facts}
      mailboxConnected={mailbox.connected}
      onStart={startCampaign}
    />
  );
}
