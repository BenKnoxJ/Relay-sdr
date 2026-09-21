import type { TouchKind } from "../../../agents/outreach/input.schema";
import { outreachStartCopy } from "@/lib/copy/outreachStart";

/**
 * A person's outreach sequence as dated steps (Relay P3).
 *
 * Pure date maths and nothing else: no clock, no scheduler, no job. A step is
 * due on a calendar day worked out from the person's own start day, counted
 * in working days (Monday to Friday). `today` is always an argument, so P4, P5
 * and P6 read the same answer the tests pin.
 *
 * **A day is a calendar day, never an instant.** Every date here is an ISO
 * `YYYY-MM-DD` string, and the arithmetic runs on UTC midnights so the
 * server's own zone can never move one. The rep's day is Europe/London's
 * (`londonDay`): 23:30 UTC on a summer evening is already tomorrow for them.
 * Postgres keeps these as `DATE`; `toDbDate` and `fromDbDate` are the only way
 * across, and both are UTC midnight on the same day.
 */

/** A calendar day, `YYYY-MM-DD`. */
export type IsoDate = string;

/** What a step waits on when it has no fixed offset: the connect being accepted, or the LinkedIn message being sent (both recorded by P4). */
export type StepDependency = "accepted" | "li_dm_sent";

export type SequenceStep =
  | { id: string; touch: TouchKind; offset: number }
  | { id: string; touch: TouchKind; after: StepDependency; notBefore?: number; plus?: number };

/**
 * The sequence, as data (16 Sep D1 timing): front-loaded early, stretched
 * later. Offsets are working days from the person's start day; tune them
 * here. Both calls read the one call script.
 */
export const SEQUENCE_TEMPLATE = [
  { id: "email1", touch: "email1", offset: 0 },
  { id: "li_connect", touch: "li_connect", offset: 1 },
  { id: "call1", touch: "call", offset: 3 },
  { id: "email2", touch: "email2", offset: 5 },
  // When the connect is accepted, and not before day 5.
  { id: "li_dm", touch: "li_dm", after: "accepted", notBefore: 5 },
  { id: "call2", touch: "call", offset: 8 },
  // Four working days after the LinkedIn message was sent.
  { id: "li_dm2", touch: "li_dm2", after: "li_dm_sent", plus: 4 },
  { id: "breakup", touch: "breakup", offset: 12 },
] as const satisfies readonly SequenceStep[];

export type StepId = (typeof SEQUENCE_TEMPLATE)[number]["id"];

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** UTC midnight of a calendar day; throws on anything that is not one. */
function utcMidnight(day: IsoDate): Date {
  const match = ISO_DATE.exec(day);
  if (match === null) throw new Error(`sequence: not a calendar day: ${day}`);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.toISOString().slice(0, 10) !== day) throw new Error(`sequence: not a calendar day: ${day}`);
  return date;
}

const isoOf = (date: Date): IsoDate => date.toISOString().slice(0, 10);

/** A weekend day moves forward to the Monday after; a working day stays. */
function snapToWorkingDay(date: Date): Date {
  const weekday = date.getUTCDay();
  if (weekday === 6) return new Date(date.getTime() + 2 * DAY_MS);
  if (weekday === 0) return new Date(date.getTime() + DAY_MS);
  return date;
}

/**
 * `n` working days after `day`. A weekend `day` counts from the Monday after,
 * so 0 from a Saturday is that Monday and Friday + 1 is Monday.
 */
export function addWorkingDays(day: IsoDate, n: number): IsoDate {
  if (!Number.isInteger(n) || n < 0) throw new Error(`sequence: a working-day count is a whole number from 0: ${n}`);
  let date = snapToWorkingDay(utcMidnight(day));
  for (let left = n; left > 0; left -= 1) date = snapToWorkingDay(new Date(date.getTime() + DAY_MS));
  return isoOf(date);
}

const later = (a: IsoDate, b: IsoDate): IsoDate => (a >= b ? a : b);

export type DatedStep = { id: StepId; touch: TouchKind; due: IsoDate | null; waitingFor: StepDependency | null };

/**
 * Each step of the template with its due day, or `null` and what it is
 * waiting for. The LinkedIn message is due on the later of day 5 and the day
 * the connect was accepted; the follow-up four working days after the
 * message went. Both wait until P4 records those.
 */
export function stepDueDates(startOn: IsoDate, events: { acceptedOn?: IsoDate | null; liDmSentOn?: IsoDate | null } = {}): DatedStep[] {
  return SEQUENCE_TEMPLATE.map((step): DatedStep => {
    if ("offset" in step) return { id: step.id, touch: step.touch, due: addWorkingDays(startOn, step.offset), waitingFor: null };
    const on = step.after === "accepted" ? events.acceptedOn : events.liDmSentOn;
    if (on === undefined || on === null) return { id: step.id, touch: step.touch, due: null, waitingFor: step.after };
    const floor = "notBefore" in step ? addWorkingDays(startOn, step.notBefore) : null;
    const from = addWorkingDays(on, "plus" in step ? step.plus : 0);
    return { id: step.id, touch: step.touch, due: floor === null ? from : later(floor, from), waitingFor: null };
  });
}

/** Where a step is on `today`. Done and skipped come from P4's events and are not here. */
export type StepState = "planned" | "due" | "overdue" | "waiting" | "paused";

export function stepState(due: IsoDate | null, context: { today: IsoDate; paused: boolean }): StepState {
  // While the campaign is paused nothing is due, and nothing is overdue either.
  if (context.paused) return "paused";
  if (due === null) return "waiting";
  if (context.today < due) return "planned";
  return context.today === due ? "due" : "overdue";
}

export function stepStates(steps: readonly DatedStep[], context: { today: IsoDate; paused: boolean }): Array<DatedStep & { state: StepState }> {
  return steps.map((step) => ({ ...step, state: stepState(step.due, context) }));
}

const LONDON = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" });

/** The calendar day it is in London at `instant`: the rep's day. */
export function londonDay(instant: Date): IsoDate {
  const parts = Object.fromEntries(LONDON.formatToParts(instant).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** A calendar day `n` days after `day` (weekends included). */
export function addCalendarDays(day: IsoDate, n: number): IsoDate {
  return isoOf(new Date(utcMidnight(day).getTime() + n * DAY_MS));
}

/** The furthest ahead Start outreach may be dated, in calendar days from London's today. */
export const START_HORIZON_DAYS = 30;

/**
 * The day Start outreach really uses for a chosen day: a weekend moves to the
 * Monday after, a working day stays (P3 review). The button and the server
 * both read this, so the day the rep is shown is the day that is stored.
 */
export function startDayFor(day: IsoDate): IsoDate {
  return addWorkingDays(day, 0);
}

/** The first working day after London's today: Start outreach's default. */
export function nextWorkingDay(now: Date): IsoDate {
  return addWorkingDays(isoOf(new Date(utcMidnight(londonDay(now)).getTime() + DAY_MS)), 0);
}

/** A calendar day as Prisma writes a `DATE`: UTC midnight on that day. */
export function toDbDate(day: IsoDate): Date {
  return utcMidnight(day);
}

/** A `DATE` as Prisma reads it (UTC midnight) back to its calendar day. */
export function fromDbDate(date: Date): IsoDate {
  return isoOf(date);
}

/**
 * A calendar day as a rep reads it: "Tue 22 Sep". Not `Intl`: ICU versions
 * disagree ("Sep" or "Sept"), and the server and the browser must draw the same.
 */
export function dayLabel(day: IsoDate): string {
  const date = utcMidnight(day);
  return `${outreachStartCopy.weekdays[date.getUTCDay()]} ${date.getUTCDate()} ${outreachStartCopy.months[date.getUTCMonth()]}`;
}

/** Whether a string is a real calendar day. */
export function isIsoDate(value: string): boolean {
  try {
    utcMidnight(value);
    return true;
  } catch {
    return false;
  }
}
