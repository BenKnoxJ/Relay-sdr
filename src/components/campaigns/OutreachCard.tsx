"use client";

import { useId, useState } from "react";

import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { PillButton } from "@/components/PillButton";
import type { OutreachStartView } from "@/lib/campaigns/types";
import { outreachStartCopy } from "@/lib/copy/outreachStart";
import { dayLabel, isIsoDate, startDayFor } from "@/lib/outreach/sequence";

/**
 * Start outreach, and Pause and Resume (Relay P3). The minimum the campaign
 * page shows: "Not started", or each start day with how many people it
 * started; a Start outreach press that says how many it will start, with the
 * day to start on (the next working day unless the rep picks another); and
 * Pause or Resume, with a clear Paused state. The per-person view is P5 and
 * the calendar is P6.
 */
export function OutreachCard({
  view,
  pending,
  error,
  onStart,
  onPause,
}: {
  view: OutreachStartView;
  pending: boolean;
  error: string | null;
  onStart: (startOn: string) => void;
  onPause: (paused: boolean) => void;
}) {
  const c = outreachStartCopy;
  const dateId = useId();
  const [open, setOpen] = useState(false);
  const [startOn, setStartOn] = useState(view.defaultStartOn);
  const people = (n: number) => `${n} ${n === 1 ? c.person : c.people}`;
  const started = view.batches.length > 0;
  // The day the press really uses, so the button says it: a weekend moves to the Monday after.
  const snapped = isIsoDate(startOn) && startOn >= view.today ? startDayFor(startOn) : null;
  const chosen = snapped !== null && snapped <= view.latestStartOn ? snapped : null;

  return (
    <Card label={c.label} aside={view.paused ? <Chip tone="warn">{c.paused}</Chip> : undefined}>
      <div data-testid="outreach-card">
        {started ? (
          <ul data-testid="outreach-batches" className="type-body">
            {view.batches.map((batch) => (
              <li key={batch.startOn}>
                {c.startedOn} {dayLabel(batch.startOn)} · {people(batch.people)}
              </li>
            ))}
          </ul>
        ) : (
          <p data-testid="outreach-not-started" className="type-body">
            {c.notStarted}
          </p>
        )}
        {view.paused ? (
          <p data-testid="outreach-paused" className="type-small mt-1.5 text-warn">
            {c.pausedNote}
          </p>
        ) : null}
        {started && view.startable > 0 ? (
          <p data-testid="outreach-waiting" className="type-small mt-1.5 text-muted">
            {people(view.startable)} {c.waiting}
          </p>
        ) : null}

        {open && view.startable > 0 ? (
          <div data-testid="outreach-start-form" className="mt-3">
            <div className="flex flex-wrap items-baseline gap-2.5">
              <label className="type-small text-muted" htmlFor={dateId}>
                {c.startOnLabel}
              </label>
              <input
                id={dateId}
                data-testid="outreach-start-on"
                type="date"
                min={view.today}
                max={view.latestStartOn}
                value={startOn}
                onChange={(event) => setStartOn(event.target.value)}
                disabled={pending}
                className="type-body rounded-input border-control border-line bg-ground px-2 py-1 text-ink outline-none focus-visible:ring-2"
              />
            </div>
            <p className="type-small mt-1.5 max-w-measure text-muted">{c.startHint}</p>
          </div>
        ) : null}

        {error === null ? null : (
          <p role="alert" data-testid="outreach-error" className="type-small mt-2 text-warn">
            {error}
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {view.startable === 0 ? null : open ? (
            <>
              <PillButton data-testid="outreach-start-confirm" disabled={pending || chosen === null} onClick={() => chosen !== null && onStart(chosen)}>
                {pending ? c.starting : `${c.startFor} ${people(view.startable)}${chosen === null ? "" : ` ${c.startOnDay} ${dayLabel(chosen)}`}`}
              </PillButton>
              <PillButton data-testid="outreach-start-cancel" variant="outline" disabled={pending} onClick={() => setOpen(false)}>
                {c.cancel}
              </PillButton>
            </>
          ) : (
            <PillButton data-testid="outreach-start" disabled={pending} onClick={() => setOpen(true)}>
              {c.startFor} {people(view.startable)}
            </PillButton>
          )}
          {started ? (
            <PillButton data-testid={view.paused ? "outreach-resume" : "outreach-pause"} variant="outline" disabled={pending} onClick={() => onPause(!view.paused)}>
              {view.paused ? c.resume : c.pause}
            </PillButton>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
