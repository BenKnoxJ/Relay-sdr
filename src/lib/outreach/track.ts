import type { TouchKind } from "../../../agents/outreach/input.schema";
import { SEQUENCE_TEMPLATE, stepDueDates, stepState, type DatedStep, type IsoDate, type StepId, type StepState } from "@/lib/outreach/sequence";

/**
 * Where a person's outreach is, folded from what the rep recorded (Relay P4).
 *
 * Pure: no clock, no database. The input is the person's start day, their
 * `outreach_events` rows in the order they were written, `today` and whether
 * the campaign is paused; the answer is the same every time for the same
 * input. The rows are append-only, so a correction is an `undo` row naming the
 * row it reverses, and the fold drops both.
 *
 * The same fold is the server's check. `checkEvent` replays the history and
 * asks whether a new row is one of the valid next actions; `checkUndo` replays
 * the history without the undone row and refuses when a later row would stop
 * being valid (a reply on an email that was never sent). Nothing is enforced
 * only on a screen.
 */

export const OUTREACH_EVENT_KINDS = ["sent", "accepted", "declined", "replied", "bounced", "done", "note", "meeting", "outcome", "undo"] as const;
export type OutreachEventKind = (typeof OUTREACH_EVENT_KINDS)[number];

/** How the rep closed a person. */
export const OUTREACH_OUTCOMES = ["not_interested", "wrong_person", "bounced", "closed"] as const;
export type OutreachOutcome = (typeof OUTREACH_OUTCOMES)[number];

/** What happened on a call. */
export const CALL_RESULTS = ["spoke", "voicemail", "no_answer", "wrong_number"] as const;
export type CallResult = (typeof CALL_RESULTS)[number];

/** The kinds a rep marks on a step; the rest are person-level. */
export const STEP_ACTIONS = ["sent", "accepted", "declined", "replied", "bounced", "done"] as const;
export type StepAction = (typeof STEP_ACTIONS)[number];

/** The longest note, in characters (a CHECK on the table as well). */
export const NOTE_MAX = 2000;

/** One `outreach_events` row, as the fold reads it. */
export type TrackEvent = {
  id: string;
  step: StepId | null;
  kind: OutreachEventKind;
  outcome: OutreachOutcome | null;
  callResult: CallResult | null;
  note: string | null;
  happenedOn: IsoDate;
  undoesEventId: string | null;
};

type Channel = "email" | "connect" | "dm" | "call";

const CHANNEL: Record<TouchKind, Channel> = {
  email1: "email",
  email2: "email",
  breakup: "email",
  li_connect: "connect",
  li_dm: "dm",
  li_dm2: "dm",
  call: "call",
};

const STEP_IDS: readonly StepId[] = SEQUENCE_TEMPLATE.map((step) => step.id);
const TOUCH_OF = Object.fromEntries(SEQUENCE_TEMPLATE.map((step) => [step.id, step.touch])) as Record<StepId, TouchKind>;

export const channelOf = (step: StepId): Channel => CHANNEL[TOUCH_OF[step]];
export const isStepId = (value: string): value is StepId => (STEP_IDS as readonly string[]).includes(value);

/** A step's record so far. `sentOn` is the day the step itself was done: sent, or for a call, made. */
type StepRecord = { sentOn: IsoDate | null; callResult: CallResult | null; acceptedOn: IsoDate | null; declinedOn: IsoDate | null; repliedOn: IsoDate | null; bouncedOn: IsoDate | null };

type Replay = {
  steps: Record<StepId, StepRecord>;
  repliedOn: IsoDate | null;
  meetingOn: IsoDate | null;
  outcome: { outcome: OutreachOutcome; on: IsoDate } | null;
  lastActivityOn: IsoDate | null;
};

const emptyRecord = (): StepRecord => ({ sentOn: null, callResult: null, acceptedOn: null, declinedOn: null, repliedOn: null, bouncedOn: null });

function emptyReplay(): Replay {
  return { steps: Object.fromEntries(STEP_IDS.map((id) => [id, emptyRecord()])) as Record<StepId, StepRecord>, repliedOn: null, meetingOn: null, outcome: null, lastActivityOn: null };
}

/** A reply, a meeting or an outcome ends the sequence: every step not yet done is skipped. */
const stopped = (replay: Replay): boolean => replay.repliedOn !== null || replay.meetingOn !== null || replay.outcome !== null;

/** The day the connect counts as accepted: its own accept, or a LinkedIn message sent before any (you only message a connection). */
function acceptedOn(replay: Replay): IsoDate | null {
  const connect = replay.steps.li_connect;
  if (connect.acceptedOn !== null) return connect.acceptedOn;
  const dm = replay.steps.li_dm.sentOn ?? replay.steps.li_dm2.sentOn;
  return dm;
}

/**
 * Why a step is skipped, or null: the sequence has stopped, the connect was
 * declined (both LinkedIn messages), or a message went out without the
 * connect (already connected, so there is no request to send).
 */
function skipped(replay: Replay, step: StepId): boolean {
  if (replay.steps[step].sentOn !== null) return false;
  if (stopped(replay)) return true;
  const channel = channelOf(step);
  if (channel === "dm") return replay.steps.li_connect.declinedOn !== null;
  if (channel === "connect") return replay.steps.li_dm.sentOn !== null || replay.steps.li_dm2.sentOn !== null;
  return false;
}

/** The valid next actions on one step; empty before the person's outreach has started. */
function actionsFor(replay: Replay, step: StepId, started: boolean): StepAction[] {
  if (!started) return [];
  const record = replay.steps[step];
  const channel = channelOf(step);
  if (record.sentOn === null) {
    if (skipped(replay, step)) return [];
    // The follow-up message waits on the first one; the first one may go before the accept (it implies it).
    if (step === "li_dm2" && replay.steps.li_dm.sentOn === null) return [];
    return [channel === "call" ? "done" : "sent"];
  }
  switch (channel) {
    case "email":
      return record.repliedOn === null && record.bouncedOn === null ? ["replied", "bounced"] : [];
    case "connect":
      return acceptedOn(replay) === null && record.declinedOn === null ? ["accepted", "declined"] : [];
    case "dm":
      return record.repliedOn === null ? ["replied"] : [];
    case "call":
      return [];
  }
}

export type Refusal =
  /** Not one of the valid next actions for that step now. */
  | "not_allowed"
  /** The step is not one of the sequence's. */
  | "unknown_step"
  /** A call is marked done with what happened on it, and nothing else is. */
  | "call_result"
  /** A meeting is already booked, or an outcome already set. */
  | "already_recorded"
  /** The row to undo is not this person's, is an undo, or is already undone. */
  | "cannot_undo"
  /** Undoing it would leave a later row without what it follows from: undo that one first. */
  | "undo_later_first"
  /** Dated before the person's start day, or before the send it answers. */
  | "too_early";

/** A new row as the write path proposes it; `id` is not minted yet. */
export type Proposed = Omit<TrackEvent, "id">;

/** Whether `event` is valid after the `replay` so far; null when it is. */
function refusalFor(replay: Replay, event: Proposed, startOn: IsoDate | null): Refusal | null {
  switch (event.kind) {
    case "note":
      return null;
    case "meeting":
      return replay.meetingOn === null ? null : "already_recorded";
    case "outcome":
      return replay.outcome === null && event.outcome !== null ? null : "already_recorded";
    case "undo":
      return "cannot_undo";
    default: {
      if (event.step === null || !isStepId(event.step)) return "unknown_step";
      const isCall = channelOf(event.step) === "call";
      if (isCall !== (event.callResult !== null)) return "call_result";
      if (!actionsFor(replay, event.step, startOn !== null).includes(event.kind)) return "not_allowed";
      return event.happenedOn < earliest(replay, event.step, event.kind, startOn!) ? "too_early" : null;
    }
  }
}

/**
 * The earliest day a step row may carry: a send on or after the start day
 * (the follow-up message on or after the first), and an accept, decline,
 * reply or bounce on or after the send it answers.
 */
function earliest(replay: Replay, step: StepId, kind: OutreachEventKind, startOn: IsoDate): IsoDate {
  const record = replay.steps[step];
  if (kind !== "sent" && kind !== "done") return record.sentOn ?? startOn;
  if (step === "li_dm2" && replay.steps.li_dm.sentOn !== null && replay.steps.li_dm.sentOn > startOn) return replay.steps.li_dm.sentOn;
  return startOn;
}

function apply(replay: Replay, event: TrackEvent): void {
  const on = event.happenedOn;
  if (replay.lastActivityOn === null || on > replay.lastActivityOn) replay.lastActivityOn = on;
  if (event.kind === "meeting") replay.meetingOn = on;
  if (event.kind === "outcome" && event.outcome !== null) replay.outcome = { outcome: event.outcome, on };
  if (event.step === null || !isStepId(event.step)) return;
  const record = replay.steps[event.step];
  switch (event.kind) {
    case "sent":
    case "done":
      record.sentOn = on;
      record.callResult = event.callResult;
      return;
    case "accepted":
      record.acceptedOn = on;
      return;
    case "declined":
      record.declinedOn = on;
      return;
    case "replied":
      record.repliedOn = on;
      if (replay.repliedOn === null) replay.repliedOn = on;
      return;
    case "bounced":
      record.bouncedOn = on;
      return;
    default:
      return;
  }
}

/** The rows that still stand: every undo, and every row an undo names, dropped. */
export function liveEvents(events: readonly TrackEvent[]): TrackEvent[] {
  const undone = new Set(events.flatMap((event) => (event.kind === "undo" && event.undoesEventId !== null ? [event.undoesEventId] : [])));
  return events.filter((event) => event.kind !== "undo" && !undone.has(event.id));
}

/**
 * Replay the rows that stand, in order. A row that is not valid where it
 * falls is left out and named; the write path never stores one, so this only
 * happens for `checkUndo`'s question "what if that row were gone".
 */
function replay(events: readonly TrackEvent[], startOn: IsoDate | null): { replay: Replay; invalid: string | null } {
  const state = emptyReplay();
  let invalid: string | null = null;
  for (const event of liveEvents(events)) {
    if (refusalFor(state, event, startOn) !== null) {
      invalid ??= event.id;
      continue;
    }
    apply(state, event);
  }
  return { replay: state, invalid };
}

/** Whether a new row is one of the valid next actions after `events`; null when it is. */
export function checkEvent(events: readonly TrackEvent[], event: Proposed, context: { startOn: IsoDate | null }): Refusal | null {
  return refusalFor(replay(events, context.startOn).replay, event, context.startOn);
}

/** Whether the row `targetId` can be undone; null when it can. */
export function checkUndo(events: readonly TrackEvent[], targetId: string, context: { startOn: IsoDate | null }): Refusal | null {
  const live = liveEvents(events);
  if (!live.some((event) => event.id === targetId)) return "cannot_undo";
  const without = live.filter((event) => event.id !== targetId);
  return replay(without, context.startOn).invalid === null ? null : "undo_later_first";
}

export type TrackedStepState = StepState | "done" | "skipped";

export type TrackedStep = DatedStep & {
  state: TrackedStepState;
  /** The day it was sent (or the call made); null until then. */
  doneOn: IsoDate | null;
  callResult: CallResult | null;
  /** What came back on it, and when: an accept or decline on the connect, a reply or bounce on an email or message. */
  response: { kind: "accepted" | "declined" | "replied" | "bounced"; on: IsoDate } | null;
  nextActions: StepAction[];
};

export type PersonStatus = "not_started" | "in_sequence" | "replied" | "meeting" | "closed";

export type PersonTracking = {
  status: PersonStatus;
  steps: TrackedStep[];
  progress: { done: number; total: number };
  nextDue: { step: StepId; due: IsoDate } | null;
  lastActivityOn: IsoDate | null;
  meetingOn: IsoDate | null;
  outcome: { outcome: OutreachOutcome; on: IsoDate } | null;
  /** Person-level actions a rep can take now. A note is always one. */
  personActions: Array<"note" | "meeting" | "outcome">;
};

export type TrackInput = { startOn: IsoDate | null; events: readonly TrackEvent[]; today: IsoDate; paused: boolean };

function responseOf(record: StepRecord, channel: Channel, implied: IsoDate | null): TrackedStep["response"] {
  if (channel === "connect") {
    if (record.declinedOn !== null) return { kind: "declined", on: record.declinedOn };
    const on = record.acceptedOn ?? (record.sentOn === null ? null : implied);
    return on === null ? null : { kind: "accepted", on };
  }
  if (record.repliedOn !== null) return { kind: "replied", on: record.repliedOn };
  if (record.bouncedOn !== null) return { kind: "bounced", on: record.bouncedOn };
  return null;
}

/** One person's steps, status, progress, next due step and last activity on `today`. */
export function trackPerson(input: TrackInput): PersonTracking {
  const started = input.startOn !== null;
  const { replay: state } = replay(input.events, input.startOn);
  const implied = acceptedOn(state);
  const dated: DatedStep[] =
    input.startOn === null
      ? SEQUENCE_TEMPLATE.map((step) => ({ id: step.id, touch: step.touch, due: null, waitingFor: null }))
      : stepDueDates(input.startOn, { acceptedOn: implied, liDmSentOn: state.steps.li_dm.sentOn });

  const steps = dated.map((step): TrackedStep => {
    const record = state.steps[step.id];
    const channel = channelOf(step.id);
    const base = { doneOn: record.sentOn, callResult: record.callResult, response: responseOf(record, channel, implied), nextActions: actionsFor(state, step.id, started) };
    if (record.sentOn !== null) return { ...step, ...base, state: "done" };
    if (skipped(state, step.id)) return { ...step, ...base, state: "skipped" };
    if (!started) return { ...step, ...base, state: "planned" };
    return { ...step, ...base, state: stepState(step.due, { today: input.today, paused: input.paused }) };
  });

  const open = steps.filter((step) => step.due !== null && (step.state === "planned" || step.state === "due" || step.state === "overdue"));
  // Earliest due day first; the template's order breaks a tie. Paused: nothing is due.
  const next = input.paused ? undefined : [...open].sort((a, b) => (a.due! < b.due! ? -1 : a.due! > b.due! ? 1 : STEP_IDS.indexOf(a.id) - STEP_IDS.indexOf(b.id)))[0];

  const status: PersonStatus =
    state.outcome !== null ? "closed" : state.meetingOn !== null ? "meeting" : state.repliedOn !== null ? "replied" : started || steps.some((step) => step.doneOn !== null) ? "in_sequence" : "not_started";

  return {
    status,
    steps,
    progress: { done: steps.filter((step) => step.state === "done").length, total: steps.length },
    nextDue: next === undefined ? null : { step: next.id, due: next.due! },
    lastActivityOn: state.lastActivityOn,
    meetingOn: state.meetingOn,
    outcome: state.outcome,
    personActions: ["note", ...(state.meetingOn === null ? (["meeting"] as const) : []), ...(state.outcome === null ? (["outcome"] as const) : [])],
  };
}

export type CampaignCounts = { peopleStarted: number; emailsSent: number; connectsSent: number; connectsAccepted: number; replies: number; callsDone: number; meetings: number };

/**
 * A campaign's counts, for its stats later: people started, emails sent,
 * connects sent and accepted, people who replied, calls made and people with a
 * meeting. `startOn` says who was started; the rest is read off each fold.
 */
export function campaignCounts(people: ReadonlyArray<{ startOn: IsoDate | null; tracking: PersonTracking }>): CampaignCounts {
  const counts: CampaignCounts = { peopleStarted: 0, emailsSent: 0, connectsSent: 0, connectsAccepted: 0, replies: 0, callsDone: 0, meetings: 0 };
  for (const { startOn, tracking } of people) {
    if (startOn !== null) counts.peopleStarted += 1;
    if (tracking.steps.some((step) => step.response?.kind === "replied")) counts.replies += 1;
    if (tracking.meetingOn !== null) counts.meetings += 1;
    for (const step of tracking.steps) {
      if (step.doneOn === null) continue;
      const channel = channelOf(step.id);
      if (channel === "email") counts.emailsSent += 1;
      if (channel === "call") counts.callsDone += 1;
      if (channel === "connect") {
        counts.connectsSent += 1;
        if (step.response?.kind === "accepted") counts.connectsAccepted += 1;
      }
    }
  }
  return counts;
}

/** A person's open steps due from `from` to `to` (both included). A paused campaign has none. */
export function dueSteps(tracking: PersonTracking, range: { from: IsoDate; to: IsoDate; paused: boolean }): TrackedStep[] {
  if (range.paused) return [];
  return tracking.steps.filter((step) => step.due !== null && step.due >= range.from && step.due <= range.to && step.state !== "done" && step.state !== "skipped");
}
