import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { emptyCopy } from "@/lib/copy/empty";

/**
 * Inbox before the first campaign (master doc §23.1b; the empty state in the
 * signed mock, section 2c).
 *
 * The signed empty state names the next event — "Next drafts Thursday 09:00" —
 * and there is no next event to name until a campaign exists, so it says the
 * true thing instead: nothing is waiting, and nothing will until then. The
 * queue itself lands with slice 1.
 */
export default function InboxPage() {
  return (
    <>
      <PageHeader title={emptyCopy.inbox.title} note={emptyCopy.inbox.note} />
      <Card className="p-0">
        <EmptyState heading={emptyCopy.inbox.heading} body={emptyCopy.inbox.body} />
      </Card>
    </>
  );
}
