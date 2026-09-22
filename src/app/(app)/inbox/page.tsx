import { Inbox } from "@/components/inbox/Inbox";
import { ReadyToSend } from "@/components/inbox/ReadyToSend";
import { inboxCopy } from "@/lib/copy/inbox";

import { approveDraft, liveQueue, readyToSend, rejectDraft, sendFromInbox } from "./actions";

/**
 * The Inbox (master doc §23.1b; the signed mock, sections 2a, 2b, 2c).
 *
 * Drafts are real (outreach v2.1): the rep's own first emails waiting on
 * them, from the drafts router, approved or rejected through it. Replies and
 * calls are not built yet, so the queue holds drafts only. The session was
 * already resolved by the layout.
 *
 * Under the queue, "Ready to send" (Relay P7): the approved emails, due
 * first, each sent from the rep's mailbox when they press Send.
 */
export const dynamic = "force-dynamic";

export default async function InboxPage() {
  const [queue, ready] = await Promise.all([liveQueue(), readyToSend()]);
  return (
    <>
      <Inbox initial={queue} actions={{ approve: approveDraft, reject: rejectDraft }} emptyBody={inboxCopy.emptyLive} />
      <ReadyToSend initial={ready} send={sendFromInbox} />
    </>
  );
}
