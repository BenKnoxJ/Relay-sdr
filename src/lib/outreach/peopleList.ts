import { addWorkingDays, type IsoDate } from "@/lib/outreach/sequence";
import { channelOf, type PersonStatus, type StepAction, type TrackedStep } from "@/lib/outreach/track";

/**
 * The People list and the person drawer, as pure functions (Relay P5).
 *
 * No clock and no database: `today` is an argument, as it is in the fold
 * (`track.ts`) these read. The list's filters live in the URL, so they are
 * parsed from and written back to search params here; the order is most
 * urgent first. The drawer's buttons are the fold's valid next actions,
 * with one thing the fold cannot see: an email is marked sent only once it
 * is approved, which the server checks too (`markStep`).
 */

/**
 * A LinkedIn profile link, or nothing: it is drawn as an `href` labelled
 * LinkedIn, so any other address (another site, or not a web address at all)
 * draws no link (P5c).
 */
export function linkedinUrlOf(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const host = url.hostname.toLowerCase();
    return host === "linkedin.com" || host.endsWith(".linkedin.com") ? url.toString() : null;
  } catch {
    return null;
  }
}

export const PERSON_STATUSES = ["not_started", "in_sequence", "replied", "meeting", "closed"] as const satisfies readonly PersonStatus[];

/** What the list shows: a status, "due today or overdue" only, and a name or company search. */
export type PeopleFilter = { status: PersonStatus | null; due: boolean; q: string };

type Params = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined): string => (Array.isArray(value) ? (value[0] ?? "") : (value ?? ""));

/** The filter from the page's search params; anything unknown reads as no filter. */
export function parsePeopleFilter(params: Params): PeopleFilter {
  const status = first(params.status);
  return {
    status: (PERSON_STATUSES as readonly string[]).includes(status) ? (status as PersonStatus) : null,
    due: first(params.due) === "1",
    q: first(params.q).trim().slice(0, 100),
  };
}

/** The People tab's URL for a filter (and a person open in the drawer, if any). */
export function peopleHref(campaignId: string, filter: PeopleFilter, personId: string | null = null): string {
  const params = new URLSearchParams({ tab: "people" });
  if (filter.status !== null) params.set("status", filter.status);
  if (filter.due) params.set("due", "1");
  if (filter.q !== "") params.set("q", filter.q);
  if (personId !== null) params.set("person", personId);
  return `/campaigns/${campaignId}?${params.toString()}`;
}

/** The parts of a list row these functions read. */
export type ListRow = { campaignPersonId: string; name: string; company: string; status: PersonStatus; nextDue: { due: IsoDate } | null };

/** Due today or before, and still open. */
export const isDueNow = (row: Pick<ListRow, "nextDue">, today: IsoDate): boolean => row.nextDue !== null && row.nextDue.due <= today;

export function filterPeople<T extends ListRow>(rows: readonly T[], filter: PeopleFilter, today: IsoDate): T[] {
  const q = filter.q.toLowerCase();
  return rows.filter(
    (row) =>
      (filter.status === null || row.status === filter.status) &&
      (!filter.due || isDueNow(row, today)) &&
      (q === "" || row.name.toLowerCase().includes(q) || row.company.toLowerCase().includes(q)),
  );
}

/**
 * Most urgent first: overdue (the longest overdue first), then due today,
 * then by next due day; people with nothing due come last. The name breaks
 * a tie, so the order is the same on every read.
 */
export function sortByUrgency<T extends ListRow>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const da = a.nextDue?.due ?? null;
    const db = b.nextDue?.due ?? null;
    if (da !== db) {
      if (da === null) return 1;
      if (db === null) return -1;
      return da < db ? -1 : 1;
    }
    return a.name.localeCompare(b.name) || a.campaignPersonId.localeCompare(b.campaignPersonId);
  });
}

/** How a next-due day reads: overdue, soon (today or within 2 working days), or neither. */
export type DueTone = "overdue" | "soon" | null;

export function dueTone(due: IsoDate | null, today: IsoDate): DueTone {
  if (due === null) return null;
  if (due < today) return "overdue";
  return due <= addWorkingDays(today, 2) ? "soon" : null;
}

/**
 * The mark buttons a step shows: the fold's valid next actions, except that
 * an email's Mark sent waits for the email to be approved.
 */
export function markButtonsFor(step: Pick<TrackedStep, "id" | "nextActions">, draftState: string | null): StepAction[] {
  if (channelOf(step.id) !== "email") return step.nextActions;
  return step.nextActions.filter((action) => action !== "sent" || draftState === "approved");
}

/** The words a LinkedIn message or a call script is copied as: the text alone, never a subject line. */
export function copyTextOf(draft: { body: string | null } | null): string {
  return draft?.body?.trim() ?? "";
}

/** The parts of an activity row these functions read. */
export type ActivityRow = { id: string; kind: string; happenedOn: IsoDate; undone: boolean };

/** Every row that still stands, in date order (write order within a day): undo rows and what they undid drop out. */
export function activityInDateOrder<T extends ActivityRow>(events: readonly T[]): T[] {
  return events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.kind !== "undo" && !event.undone)
    .sort((a, b) => (a.event.happenedOn < b.event.happenedOn ? -1 : a.event.happenedOn > b.event.happenedOn ? 1 : a.index - b.index))
    .map(({ event }) => event);
}

/** The row Undo offers: the latest one written that still stands. Nothing later can depend on it. */
export function undoableId(events: readonly ActivityRow[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.kind !== "undo" && !event.undone) return event.id;
  }
  return null;
}
