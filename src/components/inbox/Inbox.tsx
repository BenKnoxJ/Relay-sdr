"use client";

import { useEffect, useRef, useState } from "react";

import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import {
  inboxCopy,
  type CallOutcome,
  type RejectReason,
  type ReplyLabel,
} from "@/lib/copy/inbox";
import {
  approve,
  label,
  listQueue,
  logCall,
  reject,
  type InboxActions,
  type Queue,
  type QueueItem,
} from "@/lib/fixtures/inbox";

import { CallCard } from "./CallCard";
import { DraftCard } from "./DraftCard";
import { Queue as QueueList } from "./Queue";
import { ReplyCard } from "./ReplyCard";

/**
 * The Inbox (master doc §23.1b; mock sections 2a, 2b, 2c).
 *
 * One queue on the left, the selected item's card on the right. Click a row,
 * work the card, the row leaves and the next is selected. The rules the page
 * keeps, and where each one lives:
 *
 *   * The order is the adapter's. This never sorts; it renders what
 *     `listQueue` hands back and picks the first row when nothing is picked.
 *   * Working a card hands the id to the adapter and takes the queue it
 *     returns. Nothing here decides what Approve does — on fixtures the row
 *     leaves, in slice 1 the send is scheduled, and the page is the same.
 *   * The next row after a worked one is the row that took its place: the
 *     one below it, or the last if it was the last. That is the reading order
 *     and it is what "the next is selected" means.
 *   * Keyboard: J and K move, Enter approves, nothing else (§23.1b). Enter
 *     only approves a draft — a reply has no approve — and only the selected
 *     one: Enter on a queue row the rep tabbed to selects that row instead.
 *     No key does anything while the rep is typing in a box, or J would land
 *     in the edited email.
 *
 * The status line under the header is a live region that is always mounted,
 * so what just happened ("Wrong angle. Relay redrafts on another pain.") is
 * announced rather than appearing silently; a `role="status"` mounted at the
 * same moment as its text is often not read at all.
 *
 * `initial` and `actions` are the page's: the rep's real drafts and the
 * server's approve and reject (outreach v2.1). Left out, the fixture adapter
 * is used, which is what the component tests and the samples draw.
 */
export function Inbox({ initial, actions, emptyBody }: { initial?: Queue; actions?: InboxActions; emptyBody?: string }) {
  const [queue, setQueue] = useState<Queue>(() => initial ?? listQueue());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  // A decision that did not go through asserts; what just worked is read politely.
  const [alert, setAlert] = useState<string | null>(null);
  // The decisions on their way, per draft: that card holds still, and the rep can work the others.
  const [deciding, setDeciding] = useState<Record<string, Decision>>({});
  // The same, readable before the next render, so a second press in the same tick is the same press.
  const pending = useRef(new Set<string>());
  // Drafts the server has already decided in this visit: an answer that left before a later decision still lists it.
  const decided = useRef(new Set<string>());

  const items = queue.items;
  const selectedIndex = Math.max(
    0,
    items.findIndex((item) => item.id === selectedId),
  );
  const selected: QueueItem | undefined = items[selectedIndex];

  /**
   * Take the queue the adapter hands back and select the row that took the worked one's place,
   * unless the rep has since moved to another row that is still there.
   */
  function worked(answer: Queue, line: string, workedId?: string) {
    if (workedId !== undefined) decided.current.add(workedId);
    const next = withoutDecided(answer, decided.current);
    const index = workedId === undefined ? selectedIndex : Math.max(0, items.findIndex((item) => item.id === workedId));
    const replacement = next.items[Math.min(index, next.items.length - 1)];
    setQueue(next);
    setSelectedId((current) => (workedId !== undefined && current !== null && current !== workedId && next.items.some((item) => item.id === current) ? current : (replacement?.id ?? null)));
    setStatus(line);
    setAlert(null);
  }

  /** Send one decision to the server, once per draft, with the card busy until it answers. */
  function decide(id: string, decision: Decision, send: () => Answer, line: string) {
    if (pending.current.has(id)) return;
    pending.current.add(id);
    setDeciding((now) => ({ ...now, [id]: decision }));
    const refused = (message: string) => {
      setStatus(null);
      setAlert(message);
    };
    void send()
      .then((next) => ("error" in next ? refused(next.error) : worked(next, line, id)))
      .catch(() => refused(inboxCopy.cannotDecide))
      .finally(() => {
        // eslint-disable-next-line no-restricted-syntax -- an in-memory Set of pending ids, not a row.
        pending.current.delete(id);
        setDeciding((now) => Object.fromEntries(Object.entries(now).filter(([key]) => key !== id)));
      });
  }

  function onApprove(id: string, body?: string) {
    const item = items.find((candidate) => candidate.id === id);
    if (item?.kind === "draft" && item.written === false) return;
    const line =
      item?.kind === "draft" && item.sends === null
        ? inboxCopy.approvedReady
        : `${inboxCopy.approved}${item?.kind === "draft" && item.sends !== null ? ` ${inboxCopy.sends} ${item.sends.day} ${item.sends.time}.` : ""}`;
    if (actions === undefined) {
      worked(approve(id, body), line);
      return;
    }
    decide(id, "approve", () => actions.approve(id, body), line);
  }

  function onReject(id: string, reason: RejectReason) {
    const line = `${inboxCopy.rejectReason[reason]}. ${inboxCopy.rejectConsequence[reason]}`;
    if (actions === undefined) {
      worked(reject(id, reason), line);
      return;
    }
    decide(id, "reject", () => actions.reject(id, reason), line);
  }

  function onLabel(id: string, replyLabel: ReplyLabel) {
    worked(label(id, replyLabel), `${inboxCopy.labelled} ${inboxCopy.replyLabel[replyLabel].toLowerCase()}.`);
  }

  function onLog(id: string, outcome: CallOutcome, notes?: string) {
    worked(
      logCall(id, outcome, notes),
      `${inboxCopy.logged} ${inboxCopy.callOutcome[outcome].toLowerCase()}.`,
    );
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (isTyping(event.target)) return;
      if (items.length === 0) return;

      if (event.key === "j" || event.key === "J") {
        event.preventDefault();
        const next = items[Math.min(selectedIndex + 1, items.length - 1)];
        if (next !== undefined) setSelectedId(next.id);
      } else if (event.key === "k" || event.key === "K") {
        event.preventDefault();
        const previous = items[Math.max(selectedIndex - 1, 0)];
        if (previous !== undefined) setSelectedId(previous.id);
      } else if (event.key === "Enter") {
        // Enter approves a draft and nothing else. A reply or a call has no
        // approve. Enter on a focused button is that button's own click, so
        // Approve, Edit and the rest are left to themselves. A queue row is
        // the exception, and it has two cases: the row the rep clicked is
        // the selected one, and Enter there means approve, not
        // select-it-again; a row the rep tabbed to is not, and Enter there
        // means select it, which is the button's own click — never approve
        // whatever is open behind it.
        if (event.target instanceof HTMLButtonElement) {
          const rowId = event.target.dataset.queueRow;
          if (rowId === undefined) return;
          if (selected === undefined || rowId !== selected.id) {
            event.preventDefault();
            setSelectedId(rowId);
            return;
          }
        }
        if (selected?.kind !== "draft") return;
        event.preventDefault();
        onApprove(selected.id);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });

  return (
    <>
      <PageHeader
        title={inboxCopy.title}
        note={items.length === 0 ? inboxCopy.nothingWaiting : actions === undefined ? inboxCopy.exampleNote : `${items.length} ${items.length === 1 ? inboxCopy.countDraftOne : inboxCopy.countDraftMany}`}
      />

      {/* The fixture queue says so, whatever the rep does below it; the rep's real drafts carry no banner. */}
      {actions === undefined ? (
        <p role="note" data-testid="inbox-demo-banner" className="type-body mb-grid rounded-input border border-warn bg-warn-bg px-4 py-3 text-warn">
          {inboxCopy.demoBanner}
        </p>
      ) : null}

      <p role="status" className={status === null ? "sr-only" : "type-small mb-3 text-muted"}>
        {status}
      </p>
      <p role="alert" data-testid="inbox-alert" className={alert === null ? "sr-only" : "type-small mb-3 text-warn"}>
        {alert}
      </p>

      {selected === undefined ? (
        <Card className="p-0">
          <EmptyState
            heading={inboxCopy.emptyHeading}
            body={emptyBody ?? inboxCopy.repliesLand}
          />
        </Card>
      ) : (
        <div data-testid="inbox-grid" className="grid grid-cols-[minmax(0,1fr)] items-start gap-grid wide:grid-cols-inbox">
          <QueueList items={items} selectedId={selected.id} onSelect={setSelectedId} />
          {/*
            Keyed by id, so a card's own state (an edit in progress, the reject
            menu open) belongs to the item it was opened on and does not follow
            the rep to the next row.
          */}
          {selected.kind === "draft" ? (
            <DraftCard key={selected.id} item={selected} deciding={deciding[selected.id] ?? null} onApprove={onApprove} onReject={onReject} />
          ) : selected.kind === "reply" ? (
            <ReplyCard key={selected.id} item={selected} onLabel={onLabel} />
          ) : (
            <CallCard key={selected.id} item={selected} onLog={onLog} />
          )}
        </div>
      )}
    </>
  );
}

type Decision = "approve" | "reject";

/** The queue without drafts already decided here, and its draft count to match. */
function withoutDecided(queue: Queue, decided: ReadonlySet<string>): Queue {
  const items = queue.items.filter((item) => !(item.kind === "draft" && decided.has(item.id)));
  const dropped = queue.items.length - items.length;
  return dropped === 0 ? queue : { items, counts: { ...queue.counts, drafts: Math.max(0, queue.counts.drafts - dropped) } };
}
type Answer = ReturnType<InboxActions["approve"]>;

/** True when the key was pressed in something a rep types into. */
function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLInputElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}
