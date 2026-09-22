"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Card } from "@/components/Card";
import { Chip, type ChipTone } from "@/components/Chip";
import { EmptyState } from "@/components/EmptyState";
import { findMoreCopy } from "@/lib/copy/findMore";
import { outreachPeopleCopy as c } from "@/lib/copy/outreachPeople";
import { PERSON_STATUSES, dueTone, filterPeople, peopleHref, sortByUrgency, type PeopleFilter } from "@/lib/outreach/peopleList";
import { dayLabel, type IsoDate, type StepId } from "@/lib/outreach/sequence";
import type { PersonStatus } from "@/lib/outreach/track";
import type { TrackingRow } from "@/lib/repo/outreachTracking";

import { PersonDrawer, type PeopleActions, type PersonView } from "./PersonDrawer";

/**
 * The People tab on a running campaign (Relay P5; the model is Night City's
 * outbound lead list, the ideas and not the files).
 *
 * One row per person: name and company, title, a status chip, progress, the
 * next step and its day (overdue in the warn chip, within two working days in
 * warn text), a LinkedIn link, and the day their outreach started. The
 * filters and the open person live in the URL, so a view can be linked and
 * the back button works. Most urgent first.
 *
 * A row is a link: Enter or a click opens the person's drawer (`?person=`),
 * which the page reads on the server.
 */
export function PeopleTab({
  campaignId,
  today,
  paused,
  rows,
  filter,
  person,
  personMissing = false,
  actions,
}: {
  campaignId: string;
  today: IsoDate;
  paused: boolean;
  rows: readonly TrackingRow[];
  filter: PeopleFilter;
  /** The person open in the drawer, read on the server from `?person=`. */
  person: PersonView | null;
  /** `?person=` named someone who is not on this campaign (or not the rep's). */
  personMissing?: boolean;
  actions: PeopleActions;
}) {
  const router = useRouter();
  const statusId = useId();
  const batchId = useId();
  const searchId = useId();
  // Batches (P5b): shown and filterable once a campaign has more than one.
  const batches = [...new Set(rows.map((row) => row.batch))].sort((a, b) => a - b);
  const batched = batches.length > 1;
  const [q, setQ] = useState(filter.q);
  const shown = sortByUrgency(filterPeople(rows, filter, today));
  const filtered = filter.status !== null || filter.due || filter.q !== "" || (filter.batch ?? null) !== null;
  const go = (next: PeopleFilter) => router.replace(peopleHref(campaignId, next), { scroll: false });

  // The search writes itself into the URL a moment after the rep stops typing.
  useEffect(() => {
    if (q.trim() === filter.q) return;
    const timer = setTimeout(() => go({ ...filter, q: q.trim() }), 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `go` and `filter` are this render's; the timer only follows the box.
  }, [q]);

  return (
    <div data-testid="people-tab">
      {paused ? (
        <p role="note" data-testid="people-paused" className="type-body mb-grid rounded-input border border-warn bg-warn-bg px-4 py-3 text-warn">
          {c.paused}
        </p>
      ) : null}

      <Card label={c.listLabel} aside={<span className="type-small text-muted" data-testid="people-count">{`${shown.length} ${c.of} ${rows.length} ${c.shown}`}</span>}>
        <div data-testid="people-filters" className="mb-3 flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor={statusId} className="type-label">
              {c.filterStatus}
            </label>
            <select
              id={statusId}
              data-testid="people-filter-status"
              value={filter.status ?? ""}
              onChange={(event) => go({ ...filter, status: event.currentTarget.value === "" ? null : (event.currentTarget.value as PersonStatus) })}
              className="type-body rounded-input border-control border-line bg-ground px-2 py-1.5 text-ink outline-none focus-visible:ring-2"
            >
              <option value="">{c.filterAll}</option>
              {PERSON_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {c.status[status]}
                </option>
              ))}
            </select>
          </div>
          {batched ? (
            <div className="flex flex-col gap-1">
              <label htmlFor={batchId} className="type-label">
                {findMoreCopy.filterBatch}
              </label>
              <select
                id={batchId}
                data-testid="people-filter-batch"
                value={filter.batch ?? ""}
                onChange={(event) => go({ ...filter, batch: event.currentTarget.value === "" ? null : Number(event.currentTarget.value) })}
                className="type-body rounded-input border-control border-line bg-ground px-2 py-1.5 text-ink outline-none focus-visible:ring-2"
              >
                <option value="">{findMoreCopy.filterAllBatches}</option>
                {batches.map((batch) => (
                  <option key={batch} value={batch}>
                    {findMoreCopy.batch} {batch}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <label className="type-body flex items-center gap-2 py-1.5 text-ink">
            <input type="checkbox" data-testid="people-filter-due" checked={filter.due} onChange={(event) => go({ ...filter, due: event.currentTarget.checked })} className="h-4 w-4 accent-action" />
            {c.filterDue}
          </label>
          <div className="flex min-w-0 flex-1 basis-60 flex-col gap-1">
            <label htmlFor={searchId} className="type-label">
              {c.search}
            </label>
            <input
              id={searchId}
              type="search"
              data-testid="people-search"
              value={q}
              placeholder={c.searchPlaceholder}
              onChange={(event) => setQ(event.currentTarget.value)}
              className="type-body w-full min-w-0 rounded-input border-control border-line bg-ground px-2.5 py-1.5 text-ink outline-none focus-visible:ring-2"
            />
          </div>
        </div>

        {shown.length === 0 ? (
          <div data-testid="people-empty">
            <EmptyState heading={c.nobody} body="" />
            {filtered ? (
              <p className="mt-2 text-center">
                <Link href={peopleHref(campaignId, { status: null, due: false, q: "", batch: null })} scroll={false} onClick={() => setQ("")} className="type-small text-action underline">
                  {c.clearFilters}
                </Link>
              </p>
            ) : null}
          </div>
        ) : (
          <ul data-testid="people-list" className="-mx-card divide-y divide-line border-t border-line">
            {shown.map((row) => (
              <PersonRow key={row.campaignPersonId} row={row} batched={batched} today={today} href={peopleHref(campaignId, filter, row.campaignPersonId)} open={person?.campaignPersonId === row.campaignPersonId} />
            ))}
          </ul>
        )}
      </Card>

      {person !== null || personMissing ? (
        <PersonDrawer
          person={person}
          closeHref={peopleHref(campaignId, filter)}
          actions={actions}
          onChanged={() => router.refresh()}
        />
      ) : null}
    </div>
  );
}

const STATUS_TONE: Record<PersonStatus, ChipTone> = { not_started: "default", in_sequence: "default", replied: "ok", meeting: "ok", closed: "default" };

function PersonRow({ row, batched, today, href, open }: { row: TrackingRow; batched: boolean; today: IsoDate; href: string; open: boolean }) {
  const tone = dueTone(row.nextDue?.due ?? null, today);
  const who = [row.company, row.title].filter((part) => part !== "").join(" · ");
  return (
    <li data-testid="people-row" data-person={row.campaignPersonId} className={open ? "bg-soft" : undefined}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-card py-3">
        <Link
          href={href}
          scroll={false}
          data-person-row={row.campaignPersonId}
          aria-current={open ? "true" : undefined}
          className="min-w-0 flex-1 basis-56 rounded-input outline-none focus-visible:ring-2"
        >
          <span className="block truncate text-15 font-semibold text-ink">{row.name}</span>
          {who === "" ? null : <span className="type-small block truncate text-muted">{who}</span>}
        </Link>
        <Chip tone={STATUS_TONE[row.status]}>{c.status[row.status]}</Chip>
        <span className="type-small font-mono text-muted" data-testid="people-progress" aria-label={`${row.progress.done} ${c.of} ${row.progress.total} ${c.progress}`}>
          {row.progress.done}/{row.progress.total}
        </span>
        <span data-testid="people-next" className="type-small min-w-40">
          {row.nextDue === null ? (
            <span className="text-muted">{c.nothingDue}</span>
          ) : (
            <>
              <span className="text-muted">{c.next} </span>
              <span className="text-ink">{c.step[row.nextDue.step as StepId]}</span>{" "}
              {tone === "overdue" ? (
                <Chip tone="warn" className="ml-1">{`${c.overdue} ${dayLabel(row.nextDue.due)}`}</Chip>
              ) : (
                <span data-tone={tone ?? "none"} className={tone === "soon" ? "font-semibold text-warn" : "text-muted"}>
                  {dayLabel(row.nextDue.due)}
                </span>
              )}
            </>
          )}
        </span>
        {row.linkedinUrl === null ? null : (
          <a href={row.linkedinUrl} target="_blank" rel="noopener noreferrer" data-testid="people-linkedin" className="type-small rounded-input text-action underline outline-none focus-visible:ring-2">
            {c.linkedin} <span aria-hidden="true">↗</span>
            <span className="sr-only"> {c.opensNewTab}</span>
          </a>
        )}
        {batched ? (
          // "Batch 2 · started Tue 29 Sep" once there is more than one batch (P5b).
          <span className="type-small text-muted" data-testid="people-batch">
            {findMoreCopy.batch} {row.batch} · {row.startOn === null ? findMoreCopy.notStarted : `${findMoreCopy.started} ${dayLabel(row.startOn)}`}
          </span>
        ) : row.startOn === null ? null : (
          <span className="type-small text-muted" data-testid="people-started">
            {c.started} {dayLabel(row.startOn)}
          </span>
        )}
      </div>
    </li>
  );
}
