import { Inbox } from "@/components/inbox/Inbox";
import { inboxCopy } from "@/lib/copy/inbox";

import { approveDraft, liveQueue, rejectDraft } from "./actions";

/**
 * The Inbox (master doc §23.1b; the signed mock, sections 2a, 2b, 2c).
 *
 * Drafts are real (outreach v2.1): the rep's own first emails waiting on
 * them, from the drafts router, approved or rejected through it. Replies and
 * calls are not built yet, so the queue holds drafts only. The session was
 * already resolved by the layout.
 */
export const dynamic = "force-dynamic";

export default async function InboxPage() {
  const queue = await liveQueue();
  return <Inbox initial={queue} actions={{ approve: approveDraft, reject: rejectDraft }} emptyBody={inboxCopy.emptyLive} />;
}
