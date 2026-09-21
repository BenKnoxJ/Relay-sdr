import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PersonDrawer, type PersonView } from "@/components/people/PersonDrawer";
import { inboxCopy } from "@/lib/copy/inbox";
import { outreachPeopleCopy as c } from "@/lib/copy/outreachPeople";

import { START, TODAY, actionsMock, draft, emailCard, event, personView } from "./fixtures";

/**
 * The person drawer (Relay P5): it is a modal dialog that traps focus and
 * gives it back; Esc, ✕ and the backdrop close it; each step shows its state,
 * one NEXT mark, and only the buttons valid for it now; Copy copies the text
 * alone; a call is marked done with a result and a note; Try again, notes,
 * Undo and the outcome buttons call the server's procedures.
 */

const push = vi.fn();
vi.mock("next/navigation", () => ({ usePathname: () => "/campaigns/c1", useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }) }));

const writeText = vi.fn(async () => undefined);
beforeEach(() => {
  push.mockReset();
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(() => vi.useRealTimers());

const CLOSE = "/campaigns/c1?tab=people&due=1";

function draw(person: PersonView | null, actions = actionsMock()) {
  const onChanged = vi.fn();
  const view = render(<PersonDrawer person={person} closeHref={CLOSE} actions={actions} onChanged={onChanged} />);
  return { ...view, actions, onChanged };
}

const step = (id: string) => screen.getAllByTestId("drawer-step").find((item) => item.dataset.step === id)!;
const openStep = (id: string) => {
  const item = step(id);
  if (within(item).getByTestId("drawer-step-toggle").getAttribute("aria-expanded") === "false") fireEvent.click(within(item).getByTestId("drawer-step-toggle"));
  return step(id);
};

describe("the drawer as a dialog", () => {
  it("is a named modal dialog, and focus moves to its close button", () => {
    draw(personView());
    const dialog = screen.getByRole("dialog", { name: "Avery Dunmore" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: c.close }));
  });

  it("closes on Esc, on the ✕ and on the backdrop, keeping the list's filters", () => {
    draw(personView());
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: c.close }));
    fireEvent.click(screen.getByTestId("person-drawer-backdrop"));
    expect(push.mock.calls).toEqual([
      [CLOSE, { scroll: false }],
      [CLOSE, { scroll: false }],
      [CLOSE, { scroll: false }],
    ]);
  });

  it("keeps Tab inside: past the last control is the first, before the first is the last", () => {
    draw(personView());
    const dialog = screen.getByRole("dialog");
    // jsdom lays nothing out, so every control counts as shown.
    for (const element of dialog.querySelectorAll<HTMLElement>("*")) Object.defineProperty(element, "offsetParent", { get: () => dialog, configurable: true });
    const controls = [...dialog.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])")];
    const first = controls[0]!;
    const last = controls[controls.length - 1]!;
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("Esc still closes, and Tab comes back inside, when focus has fallen to the page behind", () => {
    draw(personView());
    const dialog = screen.getByRole("dialog");
    for (const element of dialog.querySelectorAll<HTMLElement>("*")) Object.defineProperty(element, "offsetParent", { get: () => dialog, configurable: true });
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: "Tab" });
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(push).toHaveBeenCalledWith(CLOSE, { scroll: false });
  });

  it("gives focus back to the row that opened it when it closes", () => {
    const row = document.createElement("a");
    row.href = "#";
    row.dataset.personRow = "cp1";
    document.body.appendChild(row);
    row.focus();
    const { unmount } = draw(personView());
    expect(document.activeElement).not.toBe(row);
    unmount();
    expect(document.activeElement).toBe(row);
    row.remove();
  });
});

describe("the header", () => {
  it("shows who they are, how to reach them, and status", () => {
    draw(personView());
    const header = screen.getByTestId("drawer-header");
    expect(header.textContent).toContain("Head of Claims · Ardent Motor");
    expect(screen.getByTestId("drawer-email").textContent).toBe("avery@ardent.example");
    expect((screen.getByTestId("drawer-linkedin") as HTMLAnchorElement).href).toBe("https://www.linkedin.com/in/avery");
    expect(within(header).getByText(c.status.in_sequence)).toBeTruthy();
  });

  it("Add phone saves the number through setPhone", async () => {
    const { actions, onChanged } = draw(personView());
    fireEvent.click(screen.getByRole("button", { name: c.addPhone }));
    fireEvent.change(screen.getByLabelText(c.phone), { target: { value: "+44 20 7946 0000" } });
    await act(async () => fireEvent.submit(screen.getByTestId("drawer-phone-form")));
    expect(actions.setPhone).toHaveBeenCalledWith({ personId: "cp1", phone: "+44 20 7946 0000" });
    expect(onChanged).toHaveBeenCalled();
    expect(screen.queryByTestId("drawer-phone-form")).toBeNull();
  });

  it("the outcome buttons call the server", async () => {
    const { actions } = draw(personView());
    await act(async () => fireEvent.click(screen.getByRole("button", { name: c.meetingBooked })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: c.notInterested })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: c.wrongPerson })));
    expect(actions.meetingBooked).toHaveBeenCalledWith({ personId: "cp1" });
    expect(actions.setOutcome.mock.calls).toEqual([[{ personId: "cp1", outcome: "not_interested" }], [{ personId: "cp1", outcome: "wrong_person" }]]);
  });

  it("once closed: no outcome buttons (a meeting can still be booked, as the fold allows), the outcome said, and the steps not done skipped", () => {
    draw(personView({ events: [event(null, "outcome", TODAY, { outcome: "not_interested" })] }));
    expect([...screen.getByTestId("drawer-outcomes").querySelectorAll("button")].map((button) => button.textContent)).toEqual([c.meetingBooked]);
    expect(screen.getByTestId("drawer-outcome").textContent).toBe(`${c.closedAs} ${c.outcome.not_interested}, Mon 21 Sep`);
    expect(screen.getAllByTestId("drawer-step").map((item) => item.dataset.state)).toEqual(Array(8).fill("skipped"));
    expect(screen.queryByTestId("drawer-step-next")).toBeNull();
  });

  it("shows a refusal from the server as its line", async () => {
    draw(personView(), actionsMock({ error: "That's already recorded for this person. Undo it first to change it." }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: c.meetingBooked })));
    expect(screen.getByRole("alert").textContent).toBe("That's already recorded for this person. Undo it first to change it.");
  });
});

describe("the sequence", () => {
  it("lists the eight steps in order with their channel, and one NEXT on the step to do next, open", () => {
    draw(personView());
    expect(screen.getAllByTestId("drawer-step").map((item) => item.dataset.step)).toEqual(["email1", "li_connect", "call1", "email2", "li_dm", "call2", "li_dm2", "breakup"]);
    expect(screen.getAllByTestId("drawer-step-next")).toHaveLength(1);
    expect(step("email1").dataset.next).toBe("true");
    expect(within(step("email1")).getByTestId("drawer-step-toggle").getAttribute("aria-expanded")).toBe("true");
    expect(within(step("li_connect")).getByText(c.channel.connect)).toBeTruthy();
  });

  it("says each step's state: overdue with its day, done on a day with what came back, waiting for accept, planned", () => {
    draw(personView({ events: [event("email1", "sent", START), event("li_connect", "sent", "2026-09-15")] }));
    expect(within(step("email1")).getByTestId("drawer-step-state").textContent).toBe(`${c.sentOn} Mon 14 Sep`);
    expect(within(step("call1")).getByTestId("drawer-step-state").textContent).toBe(`${c.stepState.overdue} Thu 17 Sep`);
    expect(within(step("li_dm")).getByTestId("drawer-step-state").textContent).toBe(c.waitingFor.accepted);
    expect(within(step("breakup")).getByTestId("drawer-step-state").textContent).toBe(`${c.due} Wed 30 Sep`);
    expect(step("call1").dataset.next).toBe("true");
  });

  it("a done step says what came back", () => {
    draw(personView({ events: [event("email1", "sent", START), event("email1", "replied", "2026-09-16")] }));
    expect(within(step("email1")).getByTestId("drawer-step-state").textContent).toBe(`${c.sentOn} Mon 14 Sep · ${c.response.replied} Wed 16 Sep`);
  });
});

describe("the buttons on each step", () => {
  it("an email to review: the Inbox card with Approve, Edit, Reject, and no Mark sent until it is approved", async () => {
    const { actions } = draw(personView({ drafts: { email1: draft("d1") }, emailCards: { email1: emailCard("d1") } }));
    const item = openStep("email1");
    expect(within(item).getByText("Calls behind complaints")).toBeTruthy();
    expect(within(item).queryByTestId("drawer-mark-sent")).toBeNull();
    expect(within(item).getByTestId("drawer-approve-first").textContent).toBe(c.approveFirst);
    await act(async () => fireEvent.click(within(item).getByRole("button", { name: inboxCopy.approve })));
    expect(actions.approveDraft).toHaveBeenCalledWith({ draftId: "d1" });
  });

  it("an approved email: the text, Approved, and Mark sent", async () => {
    const { actions } = draw(personView({ drafts: { email1: draft("d1", { state: "approved", subject: "Calls behind complaints", body: "The approved words." }) }, emailCards: { email1: emailCard("d1") } }));
    const item = openStep("email1");
    expect(within(item).getByTestId("drawer-email-approved").textContent).toContain("The approved words.");
    await act(async () => fireEvent.click(within(item).getByRole("button", { name: c.markSent })));
    expect(actions.markStep).toHaveBeenCalledWith({ personId: "cp1", step: "email1", kind: "sent" });
  });

  it("a sent email: Replied and Bounced", () => {
    draw(personView({ events: [event("email1", "sent", START)], drafts: { email1: draft("d1", { state: "approved" }) } }));
    const marks = within(openStep("email1")).getByTestId("drawer-step-marks");
    expect([...marks.querySelectorAll("button")].map((button) => button.textContent)).toEqual([c.markReplied, c.markBounced]);
  });

  it("the connect: its text with Copy, then Mark sent; once sent, Accepted and Declined", async () => {
    const first = draw(personView({ drafts: { li_connect: draft("d2", { subject: null, body: "Delay conversations stood out. Worth connecting?" }) } }));
    const item = openStep("li_connect");
    expect(within(item).getByTestId("drawer-message-text").textContent).toBe("Delay conversations stood out. Worth connecting?");
    expect([...within(item).getByTestId("drawer-step-marks").querySelectorAll("button")].map((button) => button.textContent)).toEqual([c.markSent]);
    first.unmount();

    const { actions } = draw(personView({ events: [event("li_connect", "sent", "2026-09-15")], drafts: { li_connect: draft("d2") } }));
    const sent = openStep("li_connect");
    expect([...within(sent).getByTestId("drawer-step-marks").querySelectorAll("button")].map((button) => button.textContent)).toEqual([c.markAccepted, c.markDeclined]);
    await act(async () => fireEvent.click(within(sent).getByRole("button", { name: c.markAccepted })));
    expect(actions.markStep).toHaveBeenCalledWith({ personId: "cp1", step: "li_connect", kind: "accepted" });
  });

  it("Copy copies exactly the text to paste, with no subject line", async () => {
    draw(personView({ drafts: { li_connect: draft("d2", { subject: "connecting", body: "Delay conversations stood out. Worth connecting?" }) } }));
    const item = openStep("li_connect");
    expect(within(item).queryByText("connecting")).toBeNull();
    await act(async () => fireEvent.click(within(item).getByRole("button", { name: c.copy })));
    expect(writeText).toHaveBeenCalledWith("Delay conversations stood out. Worth connecting?");
    expect(within(item).getByTestId("drawer-copy").textContent).toBe(c.copied);
  });

  it("a LinkedIn message after the accept: Mark sent, then Replied", () => {
    draw(personView({ events: [event("li_connect", "sent", "2026-09-15"), event("li_connect", "accepted", "2026-09-16"), event("li_dm", "sent", TODAY)], drafts: { li_dm: draft("d3") } }));
    expect([...within(openStep("li_dm")).getByTestId("drawer-step-marks").querySelectorAll("button")].map((button) => button.textContent)).toEqual([c.markReplied]);
    expect(within(openStep("li_dm2")).getByTestId("drawer-step-state").textContent).toBe(`${c.due} Fri 25 Sep`);
  });

  it("the call: the script with Copy, and Mark call done with a result and an optional note", async () => {
    const script = "Open with: Hi Avery, it's Sam.\n\nAsk: How do you find the calls behind complaints?\n\nListen for: A weekly sample.\n\nVoicemail: Sam here, I'll email.\n\nIf they say: We have QA.\nSay: This reads every call.";
    const { actions } = draw(personView({ drafts: { call1: draft("d4", { body: script }) } }));
    const item = openStep("call1");
    const lines = within(item).getByTestId("drawer-call-script");
    expect([...lines.querySelectorAll("dt")].map((dt) => dt.textContent)).toEqual(["Open with:", "Ask:", "Listen for:", "Voicemail:", "If they say:", "Say:"]);
    expect([...lines.querySelectorAll("dd")].map((dd) => dd.textContent)[0]).toBe("Hi Avery, it's Sam.");

    await act(async () => fireEvent.click(within(item).getByRole("button", { name: c.copy })));
    expect(writeText).toHaveBeenCalledWith(script);

    fireEvent.click(within(item).getByRole("button", { name: c.markCallDone }));
    const save = within(step("call1")).getByRole("button", { name: c.saveCall }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(within(step("call1")).getByLabelText(c.callResult.voicemail));
    fireEvent.change(within(step("call1")).getByLabelText(c.callNote), { target: { value: "Left the short one." } });
    await act(async () => fireEvent.submit(within(step("call1")).getByTestId("drawer-call-form")));
    expect(actions.markStep).toHaveBeenCalledWith({ personId: "cp1", step: "call1", kind: "done", callResult: "voicemail", note: "Left the short one." });
  });

  it("a call done without a note sends no note", async () => {
    const { actions } = draw(personView({ drafts: { call1: draft("d4") } }));
    fireEvent.click(within(openStep("call1")).getByRole("button", { name: c.markCallDone }));
    fireEvent.click(within(step("call1")).getByLabelText(c.callResult.no_answer));
    await act(async () => fireEvent.submit(within(step("call1")).getByTestId("drawer-call-form")));
    expect(actions.markStep).toHaveBeenCalledWith({ personId: "cp1", step: "call1", kind: "done", callResult: "no_answer" });
  });

  it("a skipped step has no buttons", () => {
    draw(personView({ events: [event("li_connect", "sent", "2026-09-15"), event("li_connect", "declined", "2026-09-16")], drafts: { li_dm: draft("d3") } }));
    const item = openStep("li_dm");
    expect(item.dataset.state).toBe("skipped");
    expect(within(item).queryByTestId("drawer-step-marks")).toBeNull();
  });
});

describe("Try again", () => {
  it("shows on a draft that failed, and asks for it once more", async () => {
    const { actions } = draw(personView({ drafts: { li_connect: draft("d2", { state: "failed", body: null, canTryAgain: true }) } }));
    const item = openStep("li_connect");
    expect(within(item).getByText(c.notWritten)).toBeTruthy();
    await act(async () => fireEvent.click(within(item).getByRole("button", { name: c.tryAgain })));
    expect(actions.tryAgain).toHaveBeenCalledWith({ draftId: "d2" });
  });

  it("shows on an email held as Needs you, beside the Inbox card", () => {
    draw(personView({ drafts: { email1: draft("d1", { state: "needs_you", canTryAgain: true }) }, emailCards: { email1: emailCard("d1", { needsYou: "checks" }) } }));
    expect(within(openStep("email1")).getByRole("button", { name: c.tryAgain })).toBeTruthy();
  });

  it("a failed draft being written again says so, not that Relay has given up", () => {
    draw(personView({ drafts: { li_connect: draft("d2", { state: "failed", body: null, canTryAgain: false, redrafting: true }) } }));
    const item = openStep("li_connect");
    expect(within(item).getByTestId("drawer-redrafting").textContent).toBe(c.redrafting);
    expect(within(item).queryByText(c.triedEnough)).toBeNull();
    expect(within(item).queryByRole("button", { name: c.tryAgain })).toBeNull();
  });

  it("says when Relay has tried three times, and when the next one is on its way", () => {
    const { unmount } = draw(personView({ drafts: { call1: draft("d4", { state: "needs_you", attempt: 3, canTryAgain: false }) } }));
    expect(within(openStep("call1")).getByText(c.triedEnough)).toBeTruthy();
    unmount();
    draw(personView({ drafts: { email2: draft("d5", { state: "rejected", redrafting: true }) } }));
    expect(within(openStep("email2")).getByTestId("drawer-draft-rejected").textContent).toContain(c.redrafting);
  });
});

describe("notes and activity", () => {
  it("lists the notes, newest first, and Add note sends the text", async () => {
    const { actions } = draw(personView({ events: [event(null, "note", "2026-09-15", { note: "Met at the conference." }), event("call1", "done", "2026-09-17", { callResult: "spoke", note: "Call back in October." })] }));
    expect(screen.getAllByTestId("drawer-note").map((note) => note.textContent)).toEqual(["Thu 17 Sep · Call 1Call back in October.", "Tue 15 Sep" + "Met at the conference."]);
    fireEvent.change(screen.getByLabelText(c.noteField), { target: { value: "Prefers mornings." } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: c.addNote })));
    expect(actions.addNote).toHaveBeenCalledWith({ personId: "cp1", text: "Prefers mornings." });
  });

  it("lists every event in date order, and offers Undo on the latest one only", async () => {
    const sent = event("li_connect", "sent", "2026-09-15");
    const note = event(null, "note", "2026-09-16", { note: "x" });
    const call = event("call1", "done", "2026-09-17", { callResult: "voicemail" });
    const undone = event("email1", "bounced", "2026-09-17");
    const email = event("email1", "sent", START);
    const { actions } = draw(personView({ events: [sent, call, note, email, undone, event(null, "undo", TODAY, { undoesEventId: undone.id })] }));
    const rows = screen.getAllByTestId("drawer-activity-row");
    expect(rows.map((row) => row.dataset.kind)).toEqual(["sent", "sent", "note", "done"]);
    expect(rows[0]!.textContent).toContain(`${c.step.email1} ${c.activity.sent}`);
    expect(rows[3]!.textContent).toContain(`${c.step.call1} ${c.activity.done}, ${c.callResult.voicemail.toLowerCase()}`);
    expect(screen.getAllByTestId("drawer-undo")).toHaveLength(1);
    expect(within(rows[0]!).getByRole("button", { name: c.undo })).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByTestId("drawer-undo")));
    // The latest row written that still stands (the bounce after it was undone), wherever its day sorts it.
    expect(actions.undo).toHaveBeenCalledWith({ eventId: email.id });
  });
});
