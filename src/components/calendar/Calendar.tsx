import Link from "next/link";

import { Chip } from "@/components/Chip";
import { PageHeader } from "@/components/PageHeader";
import { calendarCopy as c } from "@/lib/copy/calendar";
import { outreachPeopleCopy } from "@/lib/copy/outreachPeople";
import {
  CALENDAR_CHANNELS,
  EMAIL_DAY_CAP,
  buildWeek,
  calendarChannelOf,
  calendarHref,
  shiftWeek,
  weekStartOf,
  type CalendarDay,
  type CalendarItem,
  type CalendarQuery,
  type ChannelCounts,
} from "@/lib/outreach/calendar";
import { peopleHref } from "@/lib/outreach/peopleList";
import { dayLabel, type IsoDate } from "@/lib/outreach/sequence";
import { cn } from "@/lib/utils";

import { CalendarFilters } from "./CalendarFilters";

/**
 * The outreach calendar (Relay P6): Overdue, then Monday to Friday of one
 * week, across every running campaign.
 *
 * Read-only, and pure: the items arrive folded by the server (P3's dates, P4's
 * fold) and `buildWeek` puts them in columns. Each column is a section with
 * its own heading, and each item is a link to that person's drawer on their
 * campaign's People tab. The week and the filters live in the URL. Below
 * `xl` the columns stack, one under the other, and nothing scrolls sideways.
 */

const NO_FILTER = { status: null, due: false, q: "" } as const;

export function Calendar({
  today,
  query,
  items,
  campaigns,
  pausedCampaigns,
}: {
  today: IsoDate;
  query: CalendarQuery;
  items: readonly CalendarItem[];
  campaigns: ReadonlyArray<{ id: string; name: string }>;
  pausedCampaigns: number;
}) {
  const week = buildWeek(items, { today, week: query.week, filter: query.filter });
  const thisWeek = weekStartOf(today);

  return (
    <>
      <PageHeader title={c.title} note={`${c.weekOf} ${dayLabel(query.week)}`} />

      <div className="mb-grid flex flex-wrap items-end justify-between gap-3">
        <nav aria-label={c.weekNav} data-testid="calendar-week-nav" className="flex flex-wrap items-center gap-2">
          <WeekLink href={calendarHref({ ...query, week: shiftWeek(query.week, -1) })} testId="calendar-prev">
            <span aria-hidden>{c.previousGlyph}</span> {c.previousWeek}
          </WeekLink>
          <WeekLink href={calendarHref({ ...query, week: thisWeek })} testId="calendar-this-week" current={query.week === thisWeek}>
            {c.thisWeek}
          </WeekLink>
          <WeekLink href={calendarHref({ ...query, week: shiftWeek(query.week, 1) })} testId="calendar-next">
            {c.nextWeek} <span aria-hidden>{c.nextGlyph}</span>
          </WeekLink>
        </nav>
        <CalendarFilters query={query} campaigns={campaigns} />
      </div>

      {pausedCampaigns === 0 ? null : (
        <p role="note" data-testid="calendar-paused" className="type-small mb-grid text-muted">
          {`${pausedCampaigns} ${pausedCampaigns === 1 ? c.campaignPaused : c.campaignsPaused}`}
        </p>
      )}

      {/* Nothing due this week is said even when Overdue still has something in it. */}
      {week.weekEmpty ? (
        <p data-testid="calendar-empty" className="type-body mb-grid rounded-card border border-line bg-panel p-card text-muted shadow-card">
          {c.empty}
        </p>
      ) : null}
      {week.empty ? null : (
        <div data-testid="calendar-grid" className="grid grid-cols-[minmax(0,1fr)] gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Column id="calendar-overdue" heading={c.overdue} tone="overdue" items={week.overdue} emptyLine={c.nothingOverdue} />
          {week.days.map((day) => (
            <Column key={day.day} id={`calendar-day-${day.day}`} heading={dayLabel(day.day)} day={day} items={day.items} emptyLine={c.nothingThisDay} />
          ))}
        </div>
      )}
    </>
  );
}

function WeekLink({ href, testId, current = false, children }: { href: string; testId: string; current?: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      data-testid={testId}
      aria-current={current ? "page" : undefined}
      className={cn(
        "type-small inline-flex items-center gap-1 rounded-pill border-control px-3 py-1.5 outline-none focus-visible:ring-2",
        current ? "border-transparent bg-soft text-action" : "border-line bg-panel text-ink hover:bg-soft",
      )}
    >
      {children}
    </Link>
  );
}

function Column({
  id,
  heading,
  items,
  emptyLine,
  day,
  tone,
}: {
  id: string;
  heading: string;
  items: readonly CalendarItem[];
  emptyLine: string;
  day?: CalendarDay;
  tone?: "overdue";
}) {
  const headingId = `${id}-heading`;
  return (
    <section
      aria-labelledby={headingId}
      data-testid={id}
      data-today={day?.isToday ? "true" : undefined}
      className={cn("min-w-0 rounded-card border bg-panel p-3 shadow-card", day?.isToday ? "border-action" : "border-line")}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 id={headingId} className={cn("type-label", tone === "overdue" && items.length > 0 ? "text-warn" : undefined)}>
          {heading}
          {day?.isToday ? <span className="sr-only">{`, ${c.today}`}</span> : null}
        </h2>
        {day?.isToday ? (
          <Chip tone="ok" className="text-11">
            <span aria-hidden>{c.today}</span>
          </Chip>
        ) : null}
        {tone === "overdue" && items.length > 0 ? <span className="type-mono text-12 text-warn">{items.length}</span> : null}
      </div>

      {day === undefined ? null : <DayCounts day={day} />}

      {items.length === 0 ? (
        <p className="type-small text-muted">{emptyLine}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li key={`${item.campaignPersonId}:${item.step}`}>
              <ItemCard item={item} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function countLine(counts: ChannelCounts) {
  return CALENDAR_CHANNELS.filter((channel) => counts[channel] > 0).map((channel) => ({ channel, n: counts[channel] }));
}

/** The day's counts by channel, how many emails need approval, and the cap flag. */
function DayCounts({ day }: { day: CalendarDay }) {
  const counts = countLine(day.counts);
  if (counts.length === 0 && !day.overCap) return null;
  return (
    <div data-testid="calendar-day-counts" className="mb-2 flex flex-col gap-1">
      {counts.length === 0 ? null : (
        <p className="type-mono flex flex-wrap gap-x-3 text-12 text-muted">
          {counts.map(({ channel, n }) => (
            <span key={channel} data-channel={channel}>
              <span aria-hidden>{`${c.channelGlyph[channel]} ${n}`}</span>
              <span className="sr-only">{`${n} ${n === 1 ? c.channelOne[channel] : c.channelMany[channel]}`}</span>
            </span>
          ))}
        </p>
      )}
      {day.needApproval === 0 ? null : (
        <p data-testid="calendar-need-approval" className="type-small text-warn">{`${day.needApproval} ${day.needApproval === 1 ? c.needApprovalOne : c.needApproval}`}</p>
      )}
      {day.overCap ? (
        <p data-testid="calendar-over-cap" className="type-small text-warn">{`${c.overCap} ${EMAIL_DAY_CAP}`}</p>
      ) : null}
    </div>
  );
}

/** One step: channel, step, person, company and campaign. A link to the person's drawer. */
function ItemCard({ item }: { item: CalendarItem }) {
  const channel = calendarChannelOf(item.step);
  const where = [item.company, item.campaignName].filter((part) => part !== "").join(" · ");
  return (
    <Link
      href={peopleHref(item.campaignId, NO_FILTER, item.campaignPersonId)}
      data-testid="calendar-item"
      data-channel={channel}
      className="block rounded-input border border-line bg-ground px-2.5 py-2 outline-none transition-colors duration-micro ease-standard hover:bg-soft focus-visible:ring-2"
    >
      <span className="type-small flex items-center gap-1.5 text-muted">
        <span aria-hidden className="type-mono">{c.channelGlyph[channel]}</span>
        <span className="sr-only">{`${c.channelName[channel]}:`}</span>
        {outreachPeopleCopy.step[item.step]}
      </span>
      <span className="type-name block truncate">{item.name}</span>
      {where === "" ? null : <span className="type-small block truncate text-muted">{where}</span>}
      {item.needsApproval ? (
        <Chip tone="warn" className="mt-1 text-11">
          {c.needsApproval}
        </Chip>
      ) : null}
    </Link>
  );
}
