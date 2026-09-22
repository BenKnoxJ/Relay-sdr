import type { OutreachDraftState, Prisma, PrismaClient } from "@prisma/client";

import type { CalendarItem } from "@/lib/outreach/calendar";
import { linkedinUrlOf } from "@/lib/outreach/peopleList";
import { fromDbDate, isIsoDate, londonDay, toDbDate, type IsoDate, type StepId } from "@/lib/outreach/sequence";
import {
  NOTE_MAX,
  campaignCounts,
  checkEvent,
  channelOf,
  checkUndo,
  isStepId,
  touchOf,
  dueSteps,
  liveEvents,
  trackPerson,
  type CallResult,
  type CampaignCounts,
  type OutreachOutcome,
  type PersonTracking,
  type Proposed,
  type Refusal,
  type StepAction,
  type TrackEvent,
} from "@/lib/outreach/track";

import { mutate } from "./mutate";
import { MAX_DRAFT_ATTEMPTS, nextAttemptKey, redraftsInFlight } from "./outreach";

/**
 * Tracking a person's outreach (Relay P4): the writes and the reads.
 *
 * Every write is one `mutate`: an `outreach_events` row (or the phone) and its
 * Event in one transaction, under a lock on the person's row, taken through
 * their campaign's org and owner. The lock is what makes the check sound: the
 * history is read, the fold (`src/lib/outreach/track.ts`) says whether the new
 * row is a valid next action, and the row is written, with no other writer
 * for that person in between. Nothing here updates or deletes an
 * `outreach_events` row; a correction is an `undo` row, and the table's own
 * trigger refuses the rest.
 *
 * The org and the rep come from the session. A person who is not on one of
 * the rep's campaigns is `not_found`, the same answer as one who does not
 * exist.
 */

export const OUTREACH_TRACKED = "outreach.tracked" as const;
export const OUTREACH_UNDONE = "outreach.undone" as const;
export const OUTREACH_PHONE_SET = "outreach.phone_set" as const;

export type TrackingRefusal = Refusal | "not_found" | "not_started" | "not_approved" | "bad_date" | "bad_range" | "empty_note" | "long_note" | "bad_phone";

export class TrackingRefused extends Error {
  constructor(readonly refusal: TrackingRefusal) {
    super(`tracking refused: ${refusal}`);
    this.name = "TrackingRefused";
  }
}

type Db = PrismaClient | Prisma.TransactionClient;
type Tx = Prisma.TransactionClient;
type Owner = { orgId: string; userId: string };
type PersonRef = Owner & { campaignPersonId: string; now?: () => Date };

/** The longest phone number kept, and what it may hold. */
export const PHONE_MAX = 40;
const PHONE = /^\+?[0-9 ()\-.]{3,40}$/;

/** The longest range `dueBetween` answers, in days. */
export const DUE_RANGE_MAX_DAYS = 92;

type Locked = { id: string; campaignId: string; personId: string | null; startOn: IsoDate | null };

/**
 * Lock one of the rep's tracked people for the rest of the transaction: a
 * kept, revealed person on a campaign the rep owns. Null when there is none.
 */
async function lockPerson(tx: Tx, ref: PersonRef): Promise<Locked | null> {
  const rows = await tx.$queryRaw<Array<{ id: string; campaign_id: string; person_id: string | null; outreach_start_on: Date | null }>>`
    SELECT cp.id, cp.campaign_id, cp.person_id, cp.outreach_start_on
      FROM campaign_people cp
      JOIN campaigns c ON c.id = cp.campaign_id AND c.org_id = cp.org_id
     WHERE cp.id = ${ref.campaignPersonId} AND cp.org_id = ${ref.orgId} AND c.owner_user_id = ${ref.userId}
       AND cp.status = 'chosen' AND cp.review = 'kept' AND cp.person_id IS NOT NULL
       FOR UPDATE OF cp
  `;
  const row = rows[0];
  if (row === undefined) return null;
  return { id: row.id, campaignId: row.campaign_id, personId: row.person_id, startOn: row.outreach_start_on === null ? null : fromDbDate(row.outreach_start_on) };
}

const TRACK_SELECT = { id: true, step: true, kind: true, outcome: true, callResult: true, note: true, happenedOn: true, undoesEventId: true } as const;
type TrackRow = { id: string; step: string | null; kind: TrackEvent["kind"]; outcome: OutreachOutcome | null; callResult: CallResult | null; note: string | null; happenedOn: Date; undoesEventId: string | null };

const toTrackEvent = (row: TrackRow): TrackEvent => ({ ...row, step: row.step as StepId | null, happenedOn: fromDbDate(row.happenedOn) });

async function historyOf(db: Db, orgId: string, campaignPersonId: string): Promise<TrackEvent[]> {
  const rows = await db.outreachEvent.findMany({ where: { orgId, campaignPersonId }, select: TRACK_SELECT, orderBy: { seq: "asc" } });
  return rows.map(toTrackEvent);
}

/** The day a mark happened on: today in London unless the rep named an earlier day. */
function dayOf(on: string | undefined, now: Date): IsoDate {
  const today = londonDay(now);
  if (on === undefined) return today;
  if (!isIsoDate(on) || on > today) throw new TrackingRefused("bad_date");
  return on;
}

function cleanNote(note: string | undefined | null): string | null {
  if (note === undefined || note === null) return null;
  const trimmed = note.trim();
  if (trimmed.length > NOTE_MAX) throw new TrackingRefused("long_note");
  return trimmed === "" ? null : trimmed;
}

export type RecordedEvent = { id: string; campaignId: string; kind: TrackEvent["kind"]; step: string | null; happenedOn: IsoDate };

/**
 * Write one row after the fold has said it is a valid next action. `build`
 * sees the locked person (and the transaction), so a step mark can refuse a
 * person not yet started, or an email nobody approved.
 */
async function record(db: PrismaClient, ref: PersonRef, build: (person: Locked, tx: Tx) => Proposed | Promise<Proposed>): Promise<RecordedEvent> {
  return mutate(db, {
    orgId: ref.orgId,
    actor: { kind: "user", userId: ref.userId },
    kind: OUTREACH_TRACKED,
    campaignId: (row: RecordedEvent) => row.campaignId,
    after: (row: RecordedEvent) => ({ ...row, campaignPersonId: ref.campaignPersonId }),
    apply: async (tx) => {
      const person = await lockPerson(tx, ref);
      if (person === null) throw new TrackingRefused("not_found");
      const proposed = await build(person, tx);
      const refusal = checkEvent(await historyOf(tx, ref.orgId, person.id), proposed, { startOn: person.startOn });
      if (refusal !== null) throw new TrackingRefused(refusal);
      const row = await tx.outreachEvent.create({
        data: {
          orgId: ref.orgId,
          campaignId: person.campaignId,
          campaignPersonId: person.id,
          step: proposed.step,
          kind: proposed.kind,
          outcome: proposed.outcome,
          callResult: proposed.callResult,
          note: proposed.note,
          happenedOn: toDbDate(proposed.happenedOn),
          undoesEventId: null,
          byUserId: ref.userId,
        },
        select: { id: true, kind: true, step: true, happenedOn: true },
      });
      return { id: row.id, campaignId: person.campaignId, kind: row.kind, step: row.step, happenedOn: fromDbDate(row.happenedOn) };
    },
  });
}

const blank = { outcome: null, callResult: null, note: null, undoesEventId: null } as const;

export type MarkStepInput = PersonRef & { step: string; kind: StepAction; callResult?: CallResult; note?: string; on?: string };

/**
 * Mark a step sent, accepted, declined, replied, bounced, or (a call) done
 * with how it went. An email is marked sent only once the rep has approved
 * it (P5): every email is approved before it goes, and the Inbox and the
 * person's drawer then agree on where it is.
 */
export async function markStep(db: PrismaClient, input: MarkStepInput): Promise<RecordedEvent> {
  const happenedOn = dayOf(input.on, (input.now ?? (() => new Date()))());
  const note = cleanNote(input.note);
  return record(db, input, async (person, tx) => {
    if (person.startOn === null) throw new TrackingRefused("not_started");
    if (input.kind === "sent" && isStepId(input.step) && channelOf(input.step) === "email") {
      const approved = await tx.outreachDraft.count({ where: { orgId: input.orgId, campaignPersonId: person.id, touch: touchOf(input.step), state: "approved" } });
      if (approved === 0) throw new TrackingRefused("not_approved");
    }
    return { ...blank, step: input.step as StepId, kind: input.kind, callResult: input.callResult ?? null, note, happenedOn };
  });
}

/** A note on the person. */
export async function addNote(db: PrismaClient, input: PersonRef & { text: string }): Promise<RecordedEvent> {
  const note = cleanNote(input.text);
  if (note === null) throw new TrackingRefused("empty_note");
  const happenedOn = londonDay((input.now ?? (() => new Date()))());
  return record(db, input, () => ({ ...blank, step: null, kind: "note", note, happenedOn }));
}

/** Close the person with an outcome. */
export async function setOutcome(db: PrismaClient, input: PersonRef & { outcome: OutreachOutcome; note?: string }): Promise<RecordedEvent> {
  const note = cleanNote(input.note);
  const happenedOn = londonDay((input.now ?? (() => new Date()))());
  return record(db, input, () => ({ ...blank, step: null, kind: "outcome", outcome: input.outcome, note, happenedOn }));
}

/** A meeting booked with the person, on the day it was booked. */
export async function meetingBooked(db: PrismaClient, input: PersonRef & { on?: string; note?: string }): Promise<RecordedEvent> {
  const happenedOn = dayOf(input.on, (input.now ?? (() => new Date()))());
  const note = cleanNote(input.note);
  return record(db, input, () => ({ ...blank, step: null, kind: "meeting", note, happenedOn }));
}

/**
 * Undo one row: a new `undo` row naming it. Refused when the row is not one of
 * this rep's people's, is itself an undo, is already undone, or when a later
 * row depends on it (undo the reply before the send it replies to).
 */
export async function undoEvent(db: PrismaClient, input: Owner & { eventId: string; now?: () => Date }): Promise<RecordedEvent> {
  const happenedOn = londonDay((input.now ?? (() => new Date()))());
  const target = await db.outreachEvent.findFirst({ where: { id: input.eventId, orgId: input.orgId }, select: { campaignPersonId: true } });
  if (target === null) throw new TrackingRefused("not_found");
  const ref: PersonRef = { orgId: input.orgId, userId: input.userId, campaignPersonId: target.campaignPersonId };
  return mutate(db, {
    orgId: input.orgId,
    actor: { kind: "user", userId: input.userId },
    kind: OUTREACH_UNDONE,
    campaignId: (row: RecordedEvent) => row.campaignId,
    after: (row: RecordedEvent) => ({ ...row, campaignPersonId: ref.campaignPersonId, undoes: input.eventId }),
    apply: async (tx) => {
      const person = await lockPerson(tx, ref);
      if (person === null) throw new TrackingRefused("not_found");
      const refusal = checkUndo(await historyOf(tx, input.orgId, person.id), input.eventId, { startOn: person.startOn });
      if (refusal !== null) throw new TrackingRefused(refusal);
      const row = await tx.outreachEvent.create({
        data: { orgId: input.orgId, campaignId: person.campaignId, campaignPersonId: person.id, step: null, kind: "undo", happenedOn: toDbDate(happenedOn), undoesEventId: input.eventId, byUserId: input.userId },
        select: { id: true },
      });
      return { id: row.id, campaignId: person.campaignId, kind: "undo", step: null, happenedOn };
    },
  });
}

/** Set the person's phone number, or clear it with an empty one. */
export async function setPhone(db: PrismaClient, input: PersonRef & { phone: string }): Promise<{ phone: string | null }> {
  const phone = input.phone.trim() === "" ? null : input.phone.trim();
  if (phone !== null && (phone.length > PHONE_MAX || !PHONE.test(phone))) throw new TrackingRefused("bad_phone");
  await mutate(db, {
    orgId: input.orgId,
    actor: { kind: "user", userId: input.userId },
    kind: OUTREACH_PHONE_SET,
    campaignId: (row: { campaignId: string; was: string | null }) => row.campaignId,
    before: (row: { was: string | null }) => ({ campaignPersonId: input.campaignPersonId, phone: row.was }),
    after: { campaignPersonId: input.campaignPersonId, phone },
    apply: async (tx) => {
      const person = await lockPerson(tx, input);
      if (person === null) throw new TrackingRefused("not_found");
      const was = await tx.campaignPerson.findUniqueOrThrow({ where: { id: person.id }, select: { phone: true } });
      await tx.campaignPerson.updateMany({ where: { id: person.id, orgId: input.orgId }, data: { phone } });
      return { campaignId: person.campaignId, was: was.phone };
    },
  });
  return { phone };
}

// ---- Reads ----------------------------------------------------------------

/** Title, company and a LinkedIn link that is a web address, read off the lead gen preview. */
function previewOf(value: unknown): { title: string; company: string; linkedinUrl: string | null } {
  const preview = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const text = (key: string) => (typeof preview[key] === "string" ? (preview[key] as string).trim() : "");
  return { title: text("title"), company: text("company"), linkedinUrl: linkedinUrlOf(preview.linkedinUrl) };
}

/** A tracked person on a campaign: kept, revealed, chosen. */
const trackedWhere = (orgId: string, campaignId: string): Prisma.CampaignPersonWhereInput => ({ orgId, campaignId, status: "chosen", review: "kept", personId: { not: null } });

export type TrackingRow = {
  campaignPersonId: string;
  name: string;
  /** From the lead gen preview (P5). */
  title: string;
  company: string;
  /** The profile link, only when it is a web address. */
  linkedinUrl: string | null;
  email: string;
  phone: string | null;
  startOn: IsoDate | null;
  status: PersonTracking["status"];
  progress: PersonTracking["progress"];
  nextDue: PersonTracking["nextDue"];
  lastActivityOn: IsoDate | null;
};

async function historiesFor(db: Db, orgId: string, campaignIds: string[]): Promise<Map<string, TrackEvent[]>> {
  const rows = await db.outreachEvent.findMany({ where: { orgId, campaignId: { in: campaignIds } }, select: { ...TRACK_SELECT, campaignPersonId: true }, orderBy: { seq: "asc" } });
  const byPerson = new Map<string, TrackEvent[]>();
  for (const row of rows) {
    const list = byPerson.get(row.campaignPersonId) ?? [];
    list.push(toTrackEvent(row));
    byPerson.set(row.campaignPersonId, list);
  }
  return byPerson;
}

/** One campaign's people as P5's list draws them, with the campaign's counts. Null when it is not the rep's. */
export async function campaignPeopleTracking(db: Db, input: Owner & { campaignId: string; today: IsoDate }): Promise<{ paused: boolean; rows: TrackingRow[]; counts: CampaignCounts } | null> {
  const campaign = await db.campaign.findFirst({ where: { id: input.campaignId, orgId: input.orgId, ownerUserId: input.userId }, select: { id: true, outreachPausedAt: true } });
  if (campaign === null) return null;
  const paused = campaign.outreachPausedAt !== null;
  const people = await db.campaignPerson.findMany({
    where: trackedWhere(input.orgId, campaign.id),
    select: { id: true, phone: true, outreachStartOn: true, preview: true, person: { select: { name: true, email: true } } },
    orderBy: [{ rank: "asc" }, { id: "asc" }],
  });
  const histories = await historiesFor(db, input.orgId, [campaign.id]);
  const folded = people.map((person) => {
    const startOn = person.outreachStartOn === null ? null : fromDbDate(person.outreachStartOn);
    return { person, startOn, tracking: trackPerson({ startOn, events: histories.get(person.id) ?? [], today: input.today, paused }) };
  });
  return {
    paused,
    rows: folded.map(({ person, startOn, tracking }) => ({
      campaignPersonId: person.id,
      name: person.person?.name ?? "",
      ...previewOf(person.preview),
      email: person.person?.email ?? "",
      phone: person.phone,
      startOn,
      status: tracking.status,
      progress: tracking.progress,
      nextDue: tracking.nextDue,
      lastActivityOn: tracking.lastActivityOn,
    })),
    counts: campaignCounts(folded),
  };
}

export type StepDraft = {
  id: string;
  state: OutreachDraftState;
  attempt: number;
  subject: string | null;
  body: string | null;
  /** Failed, or held as Needs you, with an attempt left: Try again redrafts this one draft. */
  canTryAgain: boolean;
  /** The next attempt at this draft is queued or being written. */
  redrafting: boolean;
};
export type EventView = { id: string; step: string | null; kind: TrackEvent["kind"]; outcome: OutreachOutcome | null; callResult: CallResult | null; note: string | null; happenedOn: IsoDate; undoesEventId: string | null; undone: boolean; createdAt: Date };

export type PersonTrackingView = TrackingRow & {
  campaignId: string;
  paused: boolean;
  tracking: PersonTracking;
  /**
   * The stored draft for each step's touch: the latest usable attempt
   * (approved, then to review, then needs you), else the latest. Both calls
   * read the one call script.
   */
  drafts: Record<string, StepDraft | null>;
  /** Every row, oldest first, each saying whether an undo reversed it. */
  events: EventView[];
  /** The notes that stand, newest first: a note row's, or one written on a mark. */
  notes: Array<{ eventId: string; kind: TrackEvent["kind"]; step: string | null; note: string; happenedOn: IsoDate }>;
};

/** One of the rep's people in full, for P5's drawer. Null when it is not theirs. */
export async function personTracking(db: Db, input: Owner & { campaignPersonId: string; today: IsoDate }): Promise<PersonTrackingView | null> {
  const person = await db.campaignPerson.findFirst({
    where: { id: input.campaignPersonId, orgId: input.orgId, status: "chosen", review: "kept", personId: { not: null }, campaign: { ownerUserId: input.userId } },
    select: { id: true, campaignId: true, phone: true, outreachStartOn: true, preview: true, person: { select: { name: true, email: true } }, campaign: { select: { outreachPausedAt: true } } },
  });
  if (person === null) return null;
  const paused = person.campaign.outreachPausedAt !== null;
  const startOn = person.outreachStartOn === null ? null : fromDbDate(person.outreachStartOn);
  const rows = await db.outreachEvent.findMany({ where: { orgId: input.orgId, campaignPersonId: person.id }, select: { ...TRACK_SELECT, createdAt: true }, orderBy: { seq: "asc" } });
  const history = rows.map(toTrackEvent);
  const tracking = trackPerson({ startOn, events: history, today: input.today, paused });
  const live = new Set(liveEvents(history).map((event) => event.id));
  const undone = new Set(history.flatMap((event) => (event.undoesEventId === null ? [] : [event.undoesEventId])));

  const drafts = await db.outreachDraft.findMany({
    where: { orgId: input.orgId, campaignPersonId: person.id },
    select: { id: true, campaignId: true, briefVersion: true, touch: true, state: true, attempt: true, subject: true, body: true, editedBody: true },
    orderBy: [{ touch: "asc" }, { attempt: "desc" }],
  });
  // A redraft on its way: the next attempt's job, by the key the reject that asked for it used.
  const inFlight = await redraftsInFlight(db, input.orgId, drafts.map((draft) => ({ ...draft, campaignPersonId: person.id })));
  const nextKey = (draft: (typeof drafts)[number]) => nextAttemptKey({ ...draft, campaignPersonId: person.id });
  // Latest attempt first; a usable one wins over a later one that is not, so a redraft that failed
  // cannot hide the draft the rep can still use (P4 and P5 reviews).
  const latest = new Map<string, StepDraft>();
  for (const draft of drafts) {
    const held = latest.get(draft.touch);
    if (held !== undefined && usableRank(held.state) >= usableRank(draft.state)) continue;
    const attemptLeft = draft.attempt < MAX_DRAFT_ATTEMPTS;
    latest.set(draft.touch, {
      id: draft.id,
      state: draft.state,
      attempt: draft.attempt,
      // A subject belongs to an email: a LinkedIn or call row stored before P5 still shows none.
      subject: (EMAIL_TOUCHES as readonly string[]).includes(draft.touch) ? draft.subject : null,
      body: draft.editedBody ?? draft.body,
      canTryAgain: (draft.state === "failed" || draft.state === "needs_you") && attemptLeft && !inFlight.has(nextKey(draft)),
      redrafting: inFlight.has(nextKey(draft)),
    });
  }

  return {
    campaignPersonId: person.id,
    campaignId: person.campaignId,
    name: person.person?.name ?? "",
    ...previewOf(person.preview),
    email: person.person?.email ?? "",
    phone: person.phone,
    startOn,
    paused,
    status: tracking.status,
    progress: tracking.progress,
    nextDue: tracking.nextDue,
    lastActivityOn: tracking.lastActivityOn,
    tracking,
    drafts: Object.fromEntries(tracking.steps.map((step) => [step.id, latest.get(step.touch) ?? null])),
    events: rows.map((row, index) => ({ ...history[index]!, createdAt: row.createdAt, undone: undone.has(row.id) })),
    notes: history
      .filter((event) => live.has(event.id) && event.note !== null)
      .reverse()
      .map((event) => ({ eventId: event.id, kind: event.kind, step: event.step, note: event.note!, happenedOn: event.happenedOn })),
  };
}

/** How usable a draft is to the rep: approved, then to review, then needs you; anything else not at all. */
function usableRank(state: OutreachDraftState): number {
  return state === "approved" ? 3 : state === "to_review" ? 2 : state === "needs_you" ? 1 : 0;
}

export type DueItem = CalendarItem & { touch: string };

const DAY_MS = 86_400_000;

/** The email touches: a step on one of these needs its draft approved before it goes. */
const EMAIL_TOUCHES = ["email1", "email2", "breakup"] as const;

/**
 * Every open step due up to `to` (and from `from`, when there is one) on the
 * rep's running campaigns: the fold's own due day and state, per person
 * (`trackPerson`, `dueSteps`). A paused campaign adds none.
 */
async function openSteps(db: Db, input: Owner & { from: IsoDate | null; to: IsoDate; today: IsoDate; campaignIds: string[] }): Promise<DueItem[]> {
  if (input.campaignIds.length === 0) return [];
  const campaigns = await db.campaign.findMany({ where: { id: { in: input.campaignIds }, orgId: input.orgId, ownerUserId: input.userId, outreachPausedAt: null }, select: { id: true, name: true } });
  if (campaigns.length === 0) return [];
  const names = new Map(campaigns.map((campaign) => [campaign.id, campaign.name]));
  const people = await db.campaignPerson.findMany({
    where: { orgId: input.orgId, campaignId: { in: campaigns.map((campaign) => campaign.id) }, status: "chosen", review: "kept", personId: { not: null }, outreachStartOn: { not: null } },
    select: { id: true, campaignId: true, outreachStartOn: true, preview: true, person: { select: { name: true } } },
    orderBy: [{ campaignId: "asc" }, { rank: "asc" }, { id: "asc" }],
  });
  if (people.length === 0) return [];
  const histories = await historiesFor(db, input.orgId, [...new Set(people.map((person) => person.campaignId))]);
  const approved = await db.outreachDraft.findMany({
    where: { orgId: input.orgId, campaignPersonId: { in: people.map((person) => person.id) }, touch: { in: [...EMAIL_TOUCHES] }, state: "approved" },
    select: { campaignPersonId: true, touch: true },
  });
  const isApproved = new Set(approved.map((draft) => `${draft.campaignPersonId}:${draft.touch}`));
  const items: DueItem[] = [];
  for (const person of people) {
    const startOn = fromDbDate(person.outreachStartOn!);
    const tracking = trackPerson({ startOn, events: histories.get(person.id) ?? [], today: input.today, paused: false });
    // No lower bound is the person's own start day: nothing is due before it.
    for (const step of dueSteps(tracking, { from: input.from ?? startOn, to: input.to, paused: false })) {
      items.push({
        campaignId: person.campaignId,
        campaignName: names.get(person.campaignId) ?? "",
        campaignPersonId: person.id,
        name: person.person?.name ?? "",
        company: previewOf(person.preview).company,
        step: step.id,
        touch: step.touch,
        due: step.due!,
        state: step.state,
        needsApproval: channelOf(step.id) === "email" && !isApproved.has(`${person.id}:${step.touch}`),
      });
    }
  }
  return items.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
}

async function ownCampaigns(db: Db, owner: Owner): Promise<Array<{ id: string; name: string; paused: boolean; started: boolean }>> {
  const campaigns = await db.campaign.findMany({ where: { orgId: owner.orgId, ownerUserId: owner.userId }, select: { id: true, name: true, outreachPausedAt: true }, orderBy: [{ name: "asc" }, { id: "asc" }] });
  if (campaigns.length === 0) return [];
  const started = await db.campaignPerson.groupBy({
    by: ["campaignId"],
    where: { orgId: owner.orgId, campaignId: { in: campaigns.map((campaign) => campaign.id) }, status: "chosen", review: "kept", personId: { not: null }, outreachStartOn: { not: null } },
  });
  const startedIds = new Set(started.map((row) => row.campaignId));
  return campaigns.map((campaign) => ({ id: campaign.id, name: campaign.name, paused: campaign.outreachPausedAt !== null, started: startedIds.has(campaign.id) }));
}

/** Every open step due from `from` to `to` across the rep's campaigns, for the calendar. A paused campaign adds none. */
export async function dueBetween(db: Db, input: Owner & { from: string; to: string; today: IsoDate }): Promise<DueItem[]> {
  if (!isIsoDate(input.from) || !isIsoDate(input.to) || input.from > input.to) throw new TrackingRefused("bad_range");
  if ((toDbDate(input.to).getTime() - toDbDate(input.from).getTime()) / DAY_MS > DUE_RANGE_MAX_DAYS) throw new TrackingRefused("bad_range");
  const campaigns = await ownCampaigns(db, input);
  return openSteps(db, { ...input, campaignIds: campaigns.filter((campaign) => !campaign.paused).map((campaign) => campaign.id) });
}

export type CalendarView = {
  /** Every open step due up to `to`, overdue ones included however old. */
  items: DueItem[];
  /** The running campaigns with outreach started: the campaign filter's choices. */
  campaigns: Array<{ id: string; name: string }>;
  /** Campaigns with outreach started and paused: nothing of theirs is due. */
  pausedCampaigns: number;
};

/** The calendar's read (P6): everything open up to `to`, and which campaigns are running or paused. */
export async function calendarItems(db: Db, input: Owner & { to: string; today: IsoDate }): Promise<CalendarView> {
  if (!isIsoDate(input.to)) throw new TrackingRefused("bad_range");
  const campaigns = (await ownCampaigns(db, input)).filter((campaign) => campaign.started);
  const running = campaigns.filter((campaign) => !campaign.paused);
  const items = await openSteps(db, { ...input, from: null, campaignIds: running.map((campaign) => campaign.id) });
  return { items, campaigns: running.map(({ id, name }) => ({ id, name })), pausedCampaigns: campaigns.length - running.length };
}
