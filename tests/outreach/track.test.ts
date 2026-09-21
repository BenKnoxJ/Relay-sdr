import { describe, expect, it } from "vitest";

import type { StepId } from "@/lib/outreach/sequence";
import { campaignCounts, checkEvent, checkUndo, dueSteps, trackPerson, type Proposed, type TrackEvent, type TrackInput } from "@/lib/outreach/track";

/**
 * The tracking fold (Relay P4), pure. Start day Mon 21 Sep 2026, so the D1
 * template's days are: email1 Mon 21, li_connect Tue 22, call1 Thu 24,
 * email2 Mon 28, li_dm from Mon 28 once accepted, call2 Thu 1 Oct,
 * li_dm2 four working days after the message, breakup Wed 7 Oct.
 */

const START = "2026-09-21";

let serial = 0;
function ev(kind: TrackEvent["kind"], step: StepId | null, happenedOn: string, extra: Partial<TrackEvent> = {}): TrackEvent {
  serial += 1;
  return { id: `e${serial}`, step, kind, outcome: null, callResult: null, note: null, happenedOn, undoesEventId: null, ...extra };
}
const propose = (kind: Proposed["kind"], step: StepId | null, extra: Partial<Proposed> = {}): Proposed => ({ kind, step, outcome: null, callResult: null, note: null, happenedOn: "2026-09-25", undoesEventId: null, ...extra });
const track = (events: TrackEvent[], over: Partial<TrackInput> = {}) => trackPerson({ startOn: START, events, today: "2026-09-25", paused: false, ...over });
const step = (tracking: ReturnType<typeof track>, id: StepId) => tracking.steps.find((s) => s.id === id)!;
const started = { startOn: START };

describe("valid next actions per step", () => {
  it("an email: sent while planned or due, then replied or bounced, then nothing", () => {
    expect(step(track([]), "email1").nextActions).toEqual(["sent"]);
    expect(step(track([]), "email2").nextActions).toEqual(["sent"]); // planned (due Mon 28)
    const sent = ev("sent", "email1", "2026-09-21");
    expect(step(track([sent]), "email1").nextActions).toEqual(["replied", "bounced"]);
    expect(step(track([sent, ev("bounced", "email1", "2026-09-22")]), "email1").nextActions).toEqual([]);
  });

  it("a connect: sent, then accepted or declined", () => {
    expect(step(track([]), "li_connect").nextActions).toEqual(["sent"]);
    const sent = ev("sent", "li_connect", "2026-09-22");
    expect(step(track([sent]), "li_connect").nextActions).toEqual(["accepted", "declined"]);
    expect(step(track([sent, ev("accepted", "li_connect", "2026-09-23")]), "li_connect").nextActions).toEqual([]);
  });

  it("a LinkedIn message: sent (even waiting on the accept), then replied; the follow-up waits for the first", () => {
    expect(step(track([]), "li_dm").nextActions).toEqual(["sent"]);
    expect(step(track([]), "li_dm2").nextActions).toEqual([]);
    const dm = ev("sent", "li_dm", "2026-09-28");
    expect(step(track([dm]), "li_dm").nextActions).toEqual(["replied"]);
    expect(step(track([dm]), "li_dm2").nextActions).toEqual(["sent"]);
  });

  it("a call: done with a result, once", () => {
    expect(step(track([]), "call1").nextActions).toEqual(["done"]);
    expect(step(track([ev("done", "call1", "2026-09-24", { callResult: "voicemail" })]), "call1").nextActions).toEqual([]);
  });

  it("nothing before the person's outreach has started", () => {
    const tracking = track([], { startOn: null });
    expect(tracking.steps.every((s) => s.nextActions.length === 0)).toBe(true);
    expect(checkEvent([], propose("sent", "email1"), { startOn: null })).toBe("not_allowed");
    expect(tracking.status).toBe("not_started");
    expect(tracking.personActions).toEqual(["note", "meeting", "outcome"]);
  });
});

describe("the server's check refuses what is not a valid next action", () => {
  const sent = ev("sent", "email1", "2026-09-21");
  it.each<[string, TrackEvent[], Proposed, string | null]>([
    ["reply to an unsent email", [], propose("replied", "email1"), "not_allowed"],
    ["bounce on an unsent email", [], propose("bounced", "email2"), "not_allowed"],
    ["send an email twice", [sent], propose("sent", "email1"), "not_allowed"],
    ["accept an unsent connect", [], propose("accepted", "li_connect"), "not_allowed"],
    ["reply on a connect", [ev("sent", "li_connect", "2026-09-22")], propose("replied", "li_connect"), "not_allowed"],
    ["accept on an email", [sent], propose("accepted", "email1"), "not_allowed"],
    ["send the follow-up message first", [], propose("sent", "li_dm2"), "not_allowed"],
    ["mark a call sent", [], propose("sent", "call1"), "call_result"],
    ["a call done with no result", [], propose("done", "call1"), "call_result"],
    ["a result on an email", [], propose("sent", "email1", { callResult: "spoke" }), "call_result"],
    ["done on an email", [], propose("done", "email1"), "not_allowed"],
    ["a step that does not exist", [], propose("sent", "email9" as StepId), "unknown_step"],
    ["a step action with no step", [], propose("sent", null), "unknown_step"],
    ["a second meeting", [ev("meeting", null, "2026-09-24")], propose("meeting", null), "already_recorded"],
    ["a second outcome", [ev("outcome", null, "2026-09-24", { outcome: "closed" })], propose("outcome", null, { outcome: "not_interested" }), "already_recorded"],
    ["an outcome with none named", [], propose("outcome", null), "already_recorded"],
    ["an undo proposed as a plain row", [], propose("undo", null), "cannot_undo"],
    ["send after a reply stopped the sequence", [sent, ev("replied", "email1", "2026-09-22")], propose("sent", "email2"), "not_allowed"],
    ["send a message after a decline", [ev("sent", "li_connect", "2026-09-22"), ev("declined", "li_connect", "2026-09-23")], propose("sent", "li_dm"), "not_allowed"],
    ["a valid send", [], propose("sent", "email1"), null],
    ["a valid call", [], propose("done", "call2", { callResult: "no_answer" }), null],
    ["a send before the start day", [], propose("sent", "email1", { happenedOn: "2026-09-18" }), "too_early"],
    ["a reply dated before its send", [ev("sent", "email1", "2026-09-23")], propose("replied", "email1", { happenedOn: "2026-09-22" }), "too_early"],
    ["the follow-up message dated before the first", [ev("sent", "li_dm", "2026-09-24")], propose("sent", "li_dm2", { happenedOn: "2026-09-23" }), "too_early"],
    ["a reply on the day of its send", [ev("sent", "email1", "2026-09-23")], propose("replied", "email1", { happenedOn: "2026-09-23" }), null],
    ["a note, always", [sent, ev("outcome", null, "2026-09-22", { outcome: "closed" })], propose("note", null, { note: "left a message" }), null],
  ])("%s", (_name, events, proposed, expected) => {
    expect(checkEvent(events, proposed, started)).toBe(expected);
  });
});

describe("rules", () => {
  it("a reply skips every remaining planned step, and only those", () => {
    const tracking = track([ev("sent", "email1", "2026-09-21"), ev("sent", "li_connect", "2026-09-22"), ev("replied", "email1", "2026-09-23")]);
    expect(tracking.status).toBe("replied");
    expect(tracking.steps.map((s) => [s.id, s.state])).toEqual([
      ["email1", "done"],
      ["li_connect", "done"],
      ["call1", "skipped"],
      ["email2", "skipped"],
      ["li_dm", "skipped"],
      ["call2", "skipped"],
      ["li_dm2", "skipped"],
      ["breakup", "skipped"],
    ]);
    expect(tracking.nextDue).toBeNull();
    // What was already sent can still come back.
    expect(step(tracking, "li_connect").nextActions).toEqual(["accepted", "declined"]);
  });

  it.each([
    ["a meeting", ev("meeting", null, "2026-09-23"), "meeting"],
    ["an outcome", ev("outcome", null, "2026-09-23", { outcome: "not_interested" }), "closed"],
  ] as const)("%s skips the rest too", (_name, event, status) => {
    const tracking = track([ev("sent", "email1", "2026-09-21"), event]);
    expect(tracking.status).toBe(status);
    expect(tracking.steps.filter((s) => s.state === "skipped")).toHaveLength(7);
  });

  it("a LinkedIn message marked sent before any accept implies the accept", () => {
    const tracking = track([ev("sent", "li_connect", "2026-09-22"), ev("sent", "li_dm", "2026-09-28")], { today: "2026-09-29" });
    expect(step(tracking, "li_connect").response).toEqual({ kind: "accepted", on: "2026-09-28" });
    expect(step(tracking, "li_connect").nextActions).toEqual([]);
    expect(step(tracking, "li_dm").due).toBe("2026-09-28");
    expect(step(tracking, "li_dm2").due).toBe("2026-10-02");
    expect(campaignCounts([{ startOn: START, tracking }]).connectsAccepted).toBe(1);
  });

  it("a message sent with no connect (already connected) skips the connect", () => {
    const tracking = track([ev("sent", "li_dm", "2026-09-22")]);
    expect(step(tracking, "li_connect").state).toBe("skipped");
    expect(step(tracking, "li_connect").nextActions).toEqual([]);
  });

  it("declined skips both LinkedIn messages", () => {
    const tracking = track([ev("sent", "li_connect", "2026-09-22"), ev("declined", "li_connect", "2026-09-23")]);
    expect(step(tracking, "li_dm").state).toBe("skipped");
    expect(step(tracking, "li_dm2").state).toBe("skipped");
    expect(step(tracking, "email2").state).toBe("planned");
    expect(tracking.status).toBe("in_sequence");
  });

  it("accepted sets the LinkedIn message's due day (not before day 5)", () => {
    const early = track([ev("sent", "li_connect", "2026-09-22"), ev("accepted", "li_connect", "2026-09-23")]);
    expect(step(early, "li_dm")).toMatchObject({ due: "2026-09-28", state: "planned", waitingFor: null });
    const late = track([ev("sent", "li_connect", "2026-09-22"), ev("accepted", "li_connect", "2026-10-02")], { today: "2026-10-02" });
    expect(step(late, "li_dm")).toMatchObject({ due: "2026-10-02", state: "due" });
    expect(step(track([]), "li_dm")).toMatchObject({ due: null, state: "waiting", waitingFor: "accepted" });
  });

  it("a call carries its result and a note", () => {
    const tracking = track([ev("done", "call1", "2026-09-24", { callResult: "spoke", note: "Call back after month end." })]);
    expect(step(tracking, "call1")).toMatchObject({ state: "done", doneOn: "2026-09-24", callResult: "spoke" });
  });
});

describe("undo", () => {
  const sent = ev("sent", "email1", "2026-09-21");
  const undo = (target: TrackEvent) => ev("undo", null, "2026-09-25", { undoesEventId: target.id });

  it.each<[string, TrackEvent[], TrackEvent, (t: ReturnType<typeof track>) => unknown, unknown]>([
    ["sent", [], sent, (t) => step(t, "email1").state, "overdue"],
    ["replied", [sent], ev("replied", "email1", "2026-09-22"), (t) => t.status, "in_sequence"],
    ["bounced", [sent], ev("bounced", "email1", "2026-09-22"), (t) => step(t, "email1").nextActions, ["replied", "bounced"]],
    ["accepted", [ev("sent", "li_connect", "2026-09-22")], ev("accepted", "li_connect", "2026-09-23"), (t) => step(t, "li_dm").state, "waiting"],
    ["declined", [ev("sent", "li_connect", "2026-09-22")], ev("declined", "li_connect", "2026-09-23"), (t) => step(t, "li_dm").nextActions, ["sent"]],
    ["done", [], ev("done", "call1", "2026-09-24", { callResult: "no_answer" }), (t) => step(t, "call1").nextActions, ["done"]],
    ["meeting", [], ev("meeting", null, "2026-09-24"), (t) => [t.status, t.meetingOn], ["in_sequence", null]],
    ["outcome", [], ev("outcome", null, "2026-09-24", { outcome: "wrong_person" }), (t) => [t.status, t.outcome], ["in_sequence", null]],
    ["note", [], ev("note", null, "2026-09-24", { note: "hi" }), (t) => t.lastActivityOn, null],
  ])("undo of %s reverses exactly that row", (_kind, before, target, read, expected) => {
    const events = [...before, target];
    expect(checkUndo(events, target.id, started)).toBeNull();
    expect(read(track([...events, undo(target)]))).toEqual(expected);
  });

  it("refuses an undo that would strand a later row, an undo of an undo, and an undone row", () => {
    const replied = ev("replied", "email1", "2026-09-22");
    expect(checkUndo([sent, replied], sent.id, started)).toBe("undo_later_first");
    // Across steps: the follow-up message stands on the first.
    const dm = ev("sent", "li_dm", "2026-09-22");
    expect(checkUndo([dm, ev("sent", "li_dm2", "2026-09-28")], dm.id, started)).toBe("undo_later_first");
    const first = undo(replied);
    expect(checkUndo([sent, replied, first], replied.id, started)).toBe("cannot_undo");
    expect(checkUndo([sent, replied, first], first.id, started)).toBe("cannot_undo");
    expect(checkUndo([sent], "nope", started)).toBe("cannot_undo");
  });

  it("after an undo the step can be marked again", () => {
    expect(checkEvent([sent, undo(sent)], propose("sent", "email1"), started)).toBeNull();
  });
});

describe("per person, for realistic histories", () => {
  it("started, nothing done yet: first email overdue, next due is the earliest open step", () => {
    const tracking = track([]);
    expect(tracking).toMatchObject({ status: "in_sequence", progress: { done: 0, total: 8 }, nextDue: { step: "email1", due: "2026-09-21" }, lastActivityOn: null });
  });

  it("email and connect sent, call made: next is email 2; last activity is the latest day", () => {
    const tracking = track([ev("sent", "email1", "2026-09-21"), ev("sent", "li_connect", "2026-09-22"), ev("done", "call1", "2026-09-24", { callResult: "voicemail" })]);
    expect(tracking).toMatchObject({ status: "in_sequence", progress: { done: 3, total: 8 }, nextDue: { step: "email2", due: "2026-09-28" }, lastActivityOn: "2026-09-24" });
  });

  it("recorded out of order: last activity is still the latest day", () => {
    expect(track([ev("sent", "email1", "2026-09-23"), ev("note", null, "2026-09-21", { note: "x" })]).lastActivityOn).toBe("2026-09-23");
  });

  it("replied then a meeting then closed", () => {
    const tracking = track([ev("sent", "email1", "2026-09-21"), ev("replied", "email1", "2026-09-22"), ev("meeting", null, "2026-09-30"), ev("outcome", null, "2026-10-05", { outcome: "closed" })]);
    expect(tracking).toMatchObject({ status: "closed", progress: { done: 1, total: 8 }, nextDue: null, meetingOn: "2026-09-30", outcome: { outcome: "closed", on: "2026-10-05" }, personActions: ["note"] });
  });

  it("paused: nothing due, and no next due step", () => {
    const tracking = track([], { paused: true });
    expect(tracking.nextDue).toBeNull();
    expect(tracking.steps.filter((s) => s.state === "due" || s.state === "overdue")).toEqual([]);
    expect(dueSteps(tracking, { from: "2026-09-01", to: "2026-12-31", paused: true })).toEqual([]);
  });

  it("the same input gives the same answer", () => {
    const events = [ev("sent", "email1", "2026-09-21"), ev("sent", "li_connect", "2026-09-22")];
    expect(track(events)).toEqual(track(events));
  });
});

describe("dueSteps and campaign counts", () => {
  it("dueSteps is the open steps due in the range, both ends included", () => {
    const tracking = track([ev("sent", "email1", "2026-09-21")]);
    expect(dueSteps(tracking, { from: "2026-09-22", to: "2026-09-28", paused: false }).map((s) => s.id)).toEqual(["li_connect", "call1", "email2"]);
  });

  it("counts people started, emails, connects sent and accepted, people replied, calls and meetings", () => {
    const a = track([ev("sent", "email1", "2026-09-21"), ev("sent", "li_connect", "2026-09-22"), ev("accepted", "li_connect", "2026-09-23"), ev("replied", "email1", "2026-09-24"), ev("meeting", null, "2026-09-25")]);
    const b = track([ev("sent", "email1", "2026-09-21"), ev("sent", "email2", "2026-09-28"), ev("sent", "li_connect", "2026-09-22"), ev("done", "call1", "2026-09-24", { callResult: "spoke" })]);
    const c = track([], { startOn: null });
    expect(campaignCounts([{ startOn: START, tracking: a }, { startOn: START, tracking: b }, { startOn: null, tracking: c }])).toEqual({
      peopleStarted: 2,
      emailsSent: 3,
      connectsSent: 2,
      connectsAccepted: 1,
      replies: 1,
      callsDone: 1,
      meetings: 1,
    });
  });
});
