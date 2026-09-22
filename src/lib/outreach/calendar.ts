import { SEND_DAILY_CAP } from "@/lib/outreach/send";
import { addCalendarDays, addWorkingDays, isIsoDate, SEQUENCE_TEMPLATE, type IsoDate, type StepId } from "@/lib/outreach/sequence";
import { channelOf, type TrackedStepState } from "@/lib/outreach/track";

/**
 * The outreach calendar (Relay P6): a Monday-to-Friday week of what is due,
 * as pure functions.
 *
 * No clock and no database, and no rule of its own about what is due: every
 * item arrives already folded by P4 (`trackPerson`, `dueSteps`), carrying
 * P3's due day and state. This file only puts those items in columns. An
 * item whose state is `overdue` goes in Overdue, whatever week is shown;
 * anything else goes on its due day if that day is in the week. The week and
 * the filters live in the URL, parsed from and written back to it here.
 */

/**
 * The most emails a day should carry: P7's send cap, one number for both. The
 * calendar flags a day due to carry more; Send refuses past it.
 */
export const EMAIL_DAY_CAP = SEND_DAILY_CAP;

/** The calendar's three channels: the connect note and both messages are all LinkedIn. */
export const CALENDAR_CHANNELS = ["email", "linkedin", "call"] as const;
export type CalendarChannel = (typeof CALENDAR_CHANNELS)[number];

export const calendarChannelOf = (step: StepId): CalendarChannel => {
  const channel = channelOf(step);
  return channel === "connect" || channel === "dm" ? "linkedin" : channel;
};

/** One open step, as the read side hands it over. */
export type CalendarItem = {
  campaignId: string;
  campaignName: string;
  campaignPersonId: string;
  name: string;
  company: string;
  step: StepId;
  due: IsoDate;
  state: TrackedStepState;
  /** An email whose draft is not approved yet. */
  needsApproval: boolean;
};

export type CalendarFilter = { campaign: string | null; channel: CalendarChannel | null };
export type CalendarQuery = { week: IsoDate; filter: CalendarFilter };

type Params = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined): string => (Array.isArray(value) ? (value[0] ?? "") : (value ?? ""));

const weekday = (day: IsoDate): number => new Date(`${day}T00:00:00Z`).getUTCDay();

/**
 * The Monday of the working week `day` falls in. A Saturday or Sunday reads
 * as the week after, the same way P3 moves a weekend start to the Monday.
 */
export function weekStartOf(day: IsoDate): IsoDate {
  const working = addWorkingDays(day, 0);
  return addCalendarDays(working, 1 - weekday(working));
}

/** The five working days of the week starting `monday`. */
export const weekDays = (monday: IsoDate): IsoDate[] => [0, 1, 2, 3, 4].map((n) => addCalendarDays(monday, n));

/** The Monday `weeks` weeks on (or back, when negative). */
export const shiftWeek = (monday: IsoDate, weeks: number): IsoDate => addCalendarDays(monday, 7 * weeks);

/** The week and filters from the page's search params; a missing or broken week is this one. */
export function parseCalendarQuery(params: Params, today: IsoDate): CalendarQuery {
  const week = first(params.week);
  const campaign = first(params.campaign).trim().slice(0, 100);
  const channel = first(params.channel);
  return {
    week: weekStartOf(isIsoDate(week) ? week : today),
    filter: {
      campaign: campaign === "" ? null : campaign,
      channel: (CALENDAR_CHANNELS as readonly string[]).includes(channel) ? (channel as CalendarChannel) : null,
    },
  };
}

/**
 * The filter with a campaign that is not one of `campaigns` (paused since the
 * link was made, or never the rep's) dropped, so the page shows everything
 * and its campaign filter can be changed.
 */
export function knownCampaign(filter: CalendarFilter, campaigns: ReadonlyArray<{ id: string }>): CalendarFilter {
  return filter.campaign === null || campaigns.some((campaign) => campaign.id === filter.campaign) ? filter : { ...filter, campaign: null };
}

/** The calendar's URL for a week and filters. */
export function calendarHref(query: CalendarQuery): string {
  const params = new URLSearchParams({ week: query.week });
  if (query.filter.campaign !== null) params.set("campaign", query.filter.campaign);
  if (query.filter.channel !== null) params.set("channel", query.filter.channel);
  return `/calendar?${params.toString()}`;
}

export type ChannelCounts = Record<CalendarChannel, number>;

export type CalendarDay = {
  day: IsoDate;
  isToday: boolean;
  items: CalendarItem[];
  counts: ChannelCounts;
  /** Emails on this day not yet approved. */
  needApproval: number;
  /** Emails due this day, across every campaign and whatever the filters, are over `EMAIL_DAY_CAP`. */
  overCap: boolean;
};

/** `weekEmpty`: nothing due Monday to Friday. `empty`: nor anything overdue. */
export type CalendarWeek = { week: IsoDate; overdue: CalendarItem[]; days: CalendarDay[]; weekEmpty: boolean; empty: boolean };

const STEP_ORDER: readonly StepId[] = SEQUENCE_TEMPLATE.map((step) => step.id);

/** Due day first, then campaign, person and step, so the order is the same on every read. */
function byDueThenName(a: CalendarItem, b: CalendarItem): number {
  if (a.due !== b.due) return a.due < b.due ? -1 : 1;
  return (
    a.campaignName.localeCompare(b.campaignName) ||
    a.name.localeCompare(b.name) ||
    a.campaignPersonId.localeCompare(b.campaignPersonId) ||
    STEP_ORDER.indexOf(a.step) - STEP_ORDER.indexOf(b.step)
  );
}

const matches = (item: CalendarItem, filter: CalendarFilter): boolean =>
  (filter.campaign === null || item.campaignId === filter.campaign) && (filter.channel === null || calendarChannelOf(item.step) === filter.channel);

export function countByChannel(items: readonly CalendarItem[]): ChannelCounts {
  const counts: ChannelCounts = { email: 0, linkedin: 0, call: 0 };
  for (const item of items) counts[calendarChannelOf(item.step)] += 1;
  return counts;
}

/**
 * The week starting `week`: Overdue, then Monday to Friday. The filters
 * decide what is shown and counted; the cap flag reads every email due that
 * day, because the mailbox sends them all.
 */
export function buildWeek(items: readonly CalendarItem[], context: { today: IsoDate; week: IsoDate; filter: CalendarFilter }): CalendarWeek {
  const shown = items.filter((item) => matches(item, context.filter)).sort(byDueThenName);
  const overdue = shown.filter((item) => item.state === "overdue");
  const days = weekDays(context.week).map((day): CalendarDay => {
    const onDay = shown.filter((item) => item.state !== "overdue" && item.due === day);
    const emailsAll = items.filter((item) => item.state !== "overdue" && item.due === day && calendarChannelOf(item.step) === "email").length;
    return {
      day,
      isToday: day === context.today,
      items: onDay,
      counts: countByChannel(onDay),
      needApproval: onDay.filter((item) => item.needsApproval).length,
      overCap: emailsAll > EMAIL_DAY_CAP,
    };
  });
  const weekEmpty = days.every((day) => day.items.length === 0);
  return { week: context.week, overdue, days, weekEmpty, empty: weekEmpty && overdue.length === 0 };
}

export type DueToday = { counts: ChannelCounts; overdue: number; total: number };

/** Home's line: what is due today by channel, and how much is overdue. */
export function dueToday(items: readonly CalendarItem[], today: IsoDate): DueToday {
  const counts = countByChannel(items.filter((item) => item.state !== "overdue" && item.due === today));
  const overdue = items.filter((item) => item.state === "overdue").length;
  return { counts, overdue, total: counts.email + counts.linkedin + counts.call + overdue };
}
