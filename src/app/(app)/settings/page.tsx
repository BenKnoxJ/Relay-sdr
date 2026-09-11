import { MailboxCard } from "@/components/MailboxCard";
import { PageHeader } from "@/components/PageHeader";
import { CallsCard } from "@/components/settings/CallsCard";
import { LinkedInCard } from "@/components/settings/LinkedInCard";
import { VoiceCard } from "@/components/settings/VoiceCard";
import { mailboxCopy, settingsCopy } from "@/lib/copy/settings";
import { serverCaller } from "@/server/api/caller";

import { connectMailbox, disconnectMailbox, saveDailyCap } from "./actions";

/**
 * Settings (master doc §23.1f).
 *
 * The four signed cards in one column, no tabs, in the signed order. Mailbox
 * is real as of Task 10b and reads the connection through the router; the
 * other three are real as of Task 9e and read the rep's profile through
 * `src/lib/fixtures/repProfile.ts`, the seam a repository replaces.
 */

/**
 * The line the card shows after a callback, keyed by what the callback put in
 * the query string. An unknown value says nothing rather than guessing.
 */
const BANNERS: Record<string, string> = {
  "connected=mailbox": mailboxCopy.connected,
  "connect=link": mailboxCopy.failedLink,
  "connect=provider": mailboxCopy.failedProvider,
  "connect=setup": mailboxCopy.failedSetup,
};

function bannerFor(params: Record<string, string | string[] | undefined>): string | null {
  // `String(…)` rather than a cast: a repeated parameter arrives as an array,
  // and the key it builds then matches nothing, which is the right answer.
  if (params.connected !== undefined) return BANNERS[`connected=${String(params.connected)}`] ?? null;
  if (params.connect !== undefined) return BANNERS[`connect=${String(params.connect)}`] ?? null;
  return null;
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const caller = await serverCaller();
  const mailbox = await caller.connections.get();

  return (
    <>
      <PageHeader title={settingsCopy.title} note={settingsCopy.note} />
      {/* One column, 720px, as the signed mock draws it (section 5). */}
      <div className="grid max-w-[720px] gap-grid">
        <MailboxCard
          state={mailbox}
          banner={bannerFor(await searchParams)}
          connect={connectMailbox}
          disconnect={disconnectMailbox}
          saveCap={saveDailyCap}
        />
        <LinkedInCard />
        <VoiceCard />
        <CallsCard />
      </div>
    </>
  );
}
