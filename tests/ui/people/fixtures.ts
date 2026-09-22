import { vi } from "vitest";

import type { PeopleActions, PersonView } from "@/components/people/PersonDrawer";
import type { DraftItem } from "@/lib/fixtures/inbox";
import { SEQUENCE_TEMPLATE, type StepId } from "@/lib/outreach/sequence";
import { liveEvents, trackPerson, type TrackEvent } from "@/lib/outreach/track";
import type { StepDraft, TrackingRow } from "@/lib/repo/outreachTracking";

/**
 * A person as the drawer receives them, folded by the real `trackPerson`,
 * so each test draws a state the server would send.
 */

// Mon 21 Sep 2026; the person started on Mon 14 Sep.
export const TODAY = "2026-09-21";
export const START = "2026-09-14";

let serial = 0;
export function event(step: StepId | null, kind: TrackEvent["kind"], happenedOn: string, extra: Partial<TrackEvent> = {}): TrackEvent {
  serial += 1;
  return { id: `ev${serial}`, step, kind, outcome: null, callResult: null, note: null, happenedOn, undoesEventId: null, ...extra };
}

export const draft = (id: string, over: Partial<StepDraft> = {}): StepDraft => ({ id, state: "to_review", attempt: 1, subject: null, body: `${id} words.`, canTryAgain: false, redrafting: false, ...over });

export function emailCard(id: string, over: Partial<DraftItem> = {}): DraftItem {
  return {
    kind: "draft",
    id,
    person: { name: "Avery Dunmore", title: "Head of Claims", company: "Ardent Motor", email: "avery@ardent.example" },
    ordinal: 1,
    total: 3,
    draft: { kind: "message", subject: "Calls behind complaints", body: "Complaints arrive long after the call. Would that be useful?", ask: "Would that be useful?", opener: { ref: "role-runs", kind: "role_pain" }, claims: [] },
    opener: { id: "role-runs", kind: "role_pain", text: "Complaints arrive late", source: "The campaign plan", date: "" },
    emailFound: true,
    fit: "strong",
    sends: null,
    needsYou: null,
    findings: [],
    advice: [],
    envelope: { greeting: "Hi Avery,", signOff: "Sam" },
    campaignName: "Motor claims",
    written: true,
    ...over,
  };
}

export function personView(options: { events?: TrackEvent[]; drafts?: Partial<Record<StepId, StepDraft | null>>; emailCards?: Record<string, DraftItem>; phone?: string | null; paused?: boolean } = {}): PersonView {
  const events = options.events ?? [];
  const tracking = trackPerson({ startOn: START, events, today: TODAY, paused: options.paused ?? false });
  const undone = new Set(events.flatMap((row) => (row.undoesEventId === null ? [] : [row.undoesEventId])));
  const live = new Set(liveEvents(events).map((row) => row.id));
  return {
    campaignPersonId: "cp1",
    campaignId: "c1",
    name: "Avery Dunmore",
    title: "Head of Claims",
    company: "Ardent Motor",
    linkedinUrl: "https://www.linkedin.com/in/avery",
    email: "avery@ardent.example",
    phone: options.phone ?? null,
    startOn: START,
    paused: options.paused ?? false,
    status: tracking.status,
    progress: tracking.progress,
    nextDue: tracking.nextDue,
    lastActivityOn: tracking.lastActivityOn,
    tracking,
    drafts: Object.fromEntries(SEQUENCE_TEMPLATE.map((step) => [step.id, options.drafts?.[step.id] ?? null])),
    emailCards: options.emailCards ?? {},
    events: events.map((row) => ({ ...row, createdAt: new Date("2026-09-21T09:00:00Z"), undone: undone.has(row.id) })),
    notes: events
      .filter((row) => live.has(row.id) && row.note !== null)
      .reverse()
      .map((row) => ({ eventId: row.id, kind: row.kind, step: row.step, note: row.note!, happenedOn: row.happenedOn })),
  };
}

export function listRow(name: string, over: Partial<TrackingRow> = {}): TrackingRow {
  return {
    campaignPersonId: `cp-${name.toLowerCase().replace(/\s+/g, "-")}`,
    name,
    title: "Head of Claims",
    company: `${name.split(" ")[1] ?? name} Insurance`,
    linkedinUrl: null,
    email: `${name.split(" ")[0]?.toLowerCase()}@example.test`,
    phone: null,
    startOn: START,
    status: "in_sequence",
    progress: { done: 2, total: 8 },
    nextDue: { step: "call1", due: TODAY },
    lastActivityOn: null,
    ...over,
  };
}

/** Every action, answering `ok` unless told otherwise. */
export function actionsMock(answer: { ok: true } | { error: string } = { ok: true }): { [K in keyof PeopleActions]: ReturnType<typeof vi.fn> } & PeopleActions {
  const fn = () => vi.fn(async () => answer);
  return { markStep: fn(), undo: fn(), addNote: fn(), setOutcome: fn(), meetingBooked: fn(), setPhone: fn(), approveDraft: fn(), rejectDraft: fn(), tryAgain: fn(), sendEmail: fn() } as never;
}
