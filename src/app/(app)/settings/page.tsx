import { MailboxCard } from "@/components/MailboxCard";
import { PageHeader } from "@/components/PageHeader";
import { LinkedInCard } from "@/components/settings/LinkedInCard";
import { VoiceCard } from "@/components/settings/VoiceCard";
import { mailboxCopy, settingsCopy } from "@/lib/copy/settings";
import { getProfile, type RepProfile } from "@/lib/fixtures/repProfile";
import { serverCaller } from "@/server/api/caller";

import { connectMailbox, disconnectMailbox, saveDailyCap, saveVoice } from "./actions";

/**
 * Settings (master doc §23.1f).
 *
 * Three of the four signed cards in one column, no tabs, in the signed order.
 * Mailbox is real as of Task 10b and reads the connection through the router;
 * LinkedIn and Your voice read the rep's profile through
 * `src/lib/fixtures/repProfile.ts`, the seam a repository replaces, and that
 * fixture is empty so neither shows anything the rep did not put there.
 *
 * The Calls card is not rendered. Start reads nothing from it yet (Calls
 * start off there, by the rep's own tick), so a toggle here would be a
 * setting that changed nothing. The component stays for the day it does.
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
  // Your voice is saved (outreach v2.1): the first emails are written from it.
  // LinkedIn and Calls still read the profile fixture.
  const voice = await caller.drafts.voice();
  const profile: RepProfile = {
    ...getProfile(),
    voiceSamples: voice.samples.map((sample, index) => ({ id: `voice-${index}`, text: sample.text, addedAt: sample.addedAt })),
    voiceNote: voice.howIWrite,
  };

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
        <VoiceCard initial={profile} onPersist={saveVoice} />
      </div>
    </>
  );
}
