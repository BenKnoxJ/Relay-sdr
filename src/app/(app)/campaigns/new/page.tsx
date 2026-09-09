import { StartForm } from "@/components/campaigns/StartForm";
import { HOW_LONG, HOW_MANY, PRODUCTS, REGIONS, startFromSentence } from "@/lib/fixtures/campaigns";
import { serverCaller } from "@/server/api/caller";

/**
 * Start (master doc §23.1d, mock 3d).
 *
 * The one thing this page resolves on the server is whether the rep's mailbox
 * is connected, because that is the only thing on the screen that is not a
 * fixture: it is read from the connections router built in Task 10b, so the
 * mock connect flow enables "Start research" for real.
 *
 * The sentence arrives in the query string when the rep came from Home's brief
 * box, and is empty when they pressed "New campaign".
 */
export default async function NewCampaignPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const caller = await serverCaller();
  const mailbox = await caller.connections.get();
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
      mailboxConnected={mailbox.connected}
    />
  );
}
