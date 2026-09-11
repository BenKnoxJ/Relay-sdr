import { Fragment } from "react";

import { Card } from "@/components/Card";
import { inboxCopy } from "@/lib/copy/inbox";
import type { QueueItem } from "@/lib/fixtures/inbox";

import { QueueRow } from "./QueueRow";

/**
 * The queue: one list, three headings, fixed order (master doc §23.1b; mock
 * section 2, `.q`).
 *
 * Replies, then calls due, then drafts due today. The order is the adapter's
 * (`listQueue` sorts) and this only draws a heading where the kind changes,
 * so a kind with nothing waiting has no heading and the list never shows an
 * empty section. No filters, no search, no tabs: there is nothing to add here
 * and nothing that should be.
 *
 * The three headings are the card's only headings and are real `h2`s, for the
 * same reason `Card`'s label is: a list a screen reader hears as one block is
 * a list nobody can skim.
 */

const HEADINGS: Record<QueueItem["kind"], string> = {
  reply: inboxCopy.headingReplies,
  call: inboxCopy.headingCalls,
  draft: inboxCopy.headingDrafts,
};

export function Queue({
  items,
  selectedId,
  onSelect,
}: {
  items: QueueItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <Card className="px-0 py-2">
      <ul aria-label={inboxCopy.queueLabel} className="m-0 list-none p-0">
        {items.map((item, index) => {
          const previous = items[index - 1];
          const heading = previous === undefined || previous.kind !== item.kind;
          return (
            <Fragment key={item.id}>
              {heading ? (
                <li className="mx-row-x mb-1.5 mt-2">
                  <h2 className="type-label text-12">{HEADINGS[item.kind]}</h2>
                </li>
              ) : null}
              <QueueRow item={item} selected={item.id === selectedId} onSelect={onSelect} />
            </Fragment>
          );
        })}
      </ul>
    </Card>
  );
}
