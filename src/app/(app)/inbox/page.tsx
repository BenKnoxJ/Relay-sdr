import { Inbox } from "@/components/inbox/Inbox";

/**
 * The Inbox (master doc §23.1b; the signed mock, sections 2a, 2b, 2c).
 *
 * The page is the client component and nothing else. Everything it shows
 * comes through `src/lib/fixtures/inbox.ts`, which is the seam Lane A's rows
 * replace (§25, slice 1); the session was already resolved by the layout.
 */
export default function InboxPage() {
  return <Inbox />;
}
