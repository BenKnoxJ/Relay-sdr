import { MailboxCard } from "@/components/MailboxCard";
import { Card } from "@/components/Card";
import { PageHeader } from "@/components/PageHeader";
import { mailboxCopy, settingsCopy } from "@/lib/copy/settings";
import { serverCaller } from "@/server/api/caller";

import { connectMailbox, disconnectMailbox, saveDailyCap } from "./actions";

/**
 * Settings (master doc §23.1f).
 *
 * The four signed cards in one column, no tabs, in the signed order. Mailbox is
 * real as of Task 10b; the other three still say they arrive with their own
 * task, into these cards rather than beside them.
 */
const COMING = [settingsCopy.linkedin, settingsCopy.voice, settingsCopy.calls];

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
        {COMING.map((heading) => (
          <Card key={heading} label={heading}>
            <p className="type-body text-muted">{settingsCopy.coming}</p>
          </Card>
        ))}
      </div>
    </>
  );
}
