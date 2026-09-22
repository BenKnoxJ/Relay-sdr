"use client";

import { useState } from "react";

import { Card } from "@/components/Card";
import { SendControl } from "@/components/outreach/SendControl";
import { sendCopy } from "@/lib/copy/send";
import { SEND_DAILY_CAP } from "@/lib/outreach/send";
import type { SendNote } from "@/lib/outreach/sendResult";
import { dayLabel } from "@/lib/outreach/sequence";
import type { ReadyItem } from "@/lib/repo/outreachSend";

export type Ready = { items: ReadyItem[]; sentToday: number; mailbox: boolean };
export type SendFromInbox = (input: { personId: string; step: string }) => Promise<({ ready: Ready } & SendNote) | { error: string }>;

const EMAIL_NUMBER: Record<string, number> = { email1: 1, email2: 2, breakup: 3 };

/**
 * The Inbox's "Ready to send" (Relay P7): approved emails not sent yet on the
 * rep's running campaigns, due first, each with the Send button the person
 * drawer shows. The server's list and offers, re-read after every press.
 */
export function ReadyToSend({ initial, send }: { initial: Ready; send: SendFromInbox }) {
  const [ready, setReady] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<SendNote | null>(null);

  async function press(item: ReadyItem) {
    if (busy !== null) return;
    const key = `${item.campaignPersonId}:${item.step}`;
    setBusy(key);
    setNote(null);
    try {
      const result = await send({ personId: item.campaignPersonId, step: item.step });
      if ("error" in result) {
        setNote({ note: result.error, warn: true });
        return;
      }
      setReady(result.ready);
      setNote({ note: result.note, warn: result.warn });
    } catch {
      setNote({ note: sendCopy.failedProvider, warn: true });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section data-testid="ready-to-send" aria-labelledby="ready-to-send-title" className="mt-grid">
      <Card
        label={sendCopy.ready.title}
        aside={
          <span data-testid="ready-sent-today" className="type-small text-muted">
            {ready.sentToday} {sendCopy.ready.of} {SEND_DAILY_CAP} {sendCopy.ready.sentToday}
          </span>
        }
      >
        <h2 id="ready-to-send-title" className="sr-only">
          {sendCopy.ready.title}
        </h2>
        <p className="type-small mb-3 text-muted">{sendCopy.ready.note}</p>
        <p role="status" data-testid="ready-note" className={note === null ? "sr-only" : `type-small mb-3 rounded-input px-3 py-2 ${note.warn ? "bg-warn-bg text-warn" : "bg-soft text-ink"}`}>
          {note?.note}
        </p>
        {ready.items.length === 0 ? (
          <p data-testid="ready-empty" className="type-body text-muted">
            {sendCopy.ready.empty}
          </p>
        ) : (
          <ul className="grid gap-2">
            {ready.items.map((item) => (
              <li key={`${item.campaignPersonId}:${item.step}`} data-testid="ready-item" data-step={item.step} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-input border border-line px-3 py-2.5">
                <div className="grid min-w-0 flex-1 gap-0.5">
                  <p className="text-15 font-semibold text-ink">
                    {item.name}
                    {item.company === "" ? null : <span className="font-normal text-muted"> · {item.company}</span>}
                  </p>
                  <p className="type-small text-muted">
                    {sendCopy.ready.email} {EMAIL_NUMBER[item.step] ?? 1}
                    {item.subject === null ? null : <> · {item.subject}</>} · {item.campaignName} · {sendCopy.ready.due} {dayLabel(item.due)}
                  </p>
                </div>
                <SendControl offer={item.offer} busy={busy === `${item.campaignPersonId}:${item.step}`} onSend={() => void press(item)} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}
