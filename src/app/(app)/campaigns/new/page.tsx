import { StartForm } from "@/components/campaigns/StartForm";
import { HOW_LONG, HOW_MANY, PRODUCTS, REGIONS, startFromSentence } from "@/lib/campaigns/start";
import { getProfile } from "@/lib/fixtures/repProfile";
import { serverCaller } from "@/server/api/caller";

import { startCampaign } from "./actions";

/**
 * Start (master doc §23.1d, mock 3d).
 *
 * Two things this page resolves on the server. Whether the rep's mailbox is
 * connected, read from the connections router, so "Start research" is enabled
 * for real. And the rep's Calls default (Settings §23.1f, card 4), read once
 * from the profile adapter and folded into the pre-fill.
 *
 * The sentence arrives in the query string when the rep came from Home's brief
 * box, and is empty when they pressed "New campaign". Pressing Start submits
 * the card to `startCampaign`, which makes the campaign and its research job.
 */
export default async function NewCampaignPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const caller = await serverCaller();
  const mailbox = await caller.connections.get();
  const { callByDefault } = getProfile();
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
      prefilled={startFromSentence(said, { callByDefault })}
      products={PRODUCTS}
      regions={REGIONS}
      howMany={HOW_MANY}
      howLong={HOW_LONG}
      mailboxConnected={mailbox.connected}
      onStart={startCampaign}
    />
  );
}
