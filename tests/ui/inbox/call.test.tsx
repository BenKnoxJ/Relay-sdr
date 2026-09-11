import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CallCard } from "@/components/inbox/CallCard";
import { Inbox } from "@/components/inbox/Inbox";
import { CALL_OUTCOMES, inboxCopy } from "@/lib/copy/inbox";
import { listQueue, resetQueue, type CallItem } from "@/lib/fixtures/inbox";

/** The call card (master doc §23.1b; mock section 2c): the number, why, and one job. */

beforeEach(() => {
  resetQueue();
});

function call(): CallItem {
  const found = listQueue().items.find((item): item is CallItem => item.kind === "call");
  if (found === undefined) throw new Error("no call in the fixtures");
  return found;
}

const noop = () => undefined;

describe("the call card", () => {
  it("shows who, and the number large and in mono", () => {
    const hannah = call();
    render(<CallCard item={hannah} onLog={noop} />);

    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(
      `Hannah Lee${inboxCopy.join}Customer Service Manager, Marlow Freight`,
    );
    expect(screen.getByText(inboxCopy.dayCallSmall)).toBeDefined();

    const number = screen.getByTestId("call-number");
    expect(number.textContent).toBe(hannah.phone);
    expect(number.className).toContain("type-mono");
    expect(number.className).toContain("text-20");
    // Text to read, not a link to press: the rep dials from their own phone.
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("says why to call in two lines, from the thread and the talking point, with the source", () => {
    const hannah = call();
    render(<CallCard item={hannah} onLog={noop} />);

    const { openingLine, oneQuestion } = hannah.draft.talkingPoint;
    expect(
      screen.getByText(`${inboxCopy.whyCall} ${hannah.context} ${openingLine} ${oneQuestion}`, {
        exact: false,
      }),
    ).toBeDefined();
    expect(screen.getByText(`${hannah.opener.source}, ${hannah.opener.date}`)).toBeDefined();
  });

  it("has one job: the four outcomes, spoke as the primary", () => {
    const { container } = render(<CallCard item={call()} onLog={noop} />);

    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(inboxCopy.logOutcome);
    const outcomes = screen.getAllByTestId("call-outcome");
    expect(outcomes.map((outcome) => outcome.textContent)).toEqual(
      CALL_OUTCOMES.map((outcome) => inboxCopy.callOutcome[outcome]),
    );
    expect(container.querySelectorAll(".bg-action")).toHaveLength(1);
    expect(outcomes[0]?.className).toContain("bg-action");
    expect(screen.getAllByRole("button")).toHaveLength(4);
  });

  it("logs voicemail, no answer and wrong number in one click", () => {
    for (const outcome of ["voicemail", "no_answer", "wrong_number"] as const) {
      const onLog = vi.fn();
      const hannah = call();
      const { unmount } = render(<CallCard item={hannah} onLog={onLog} />);

      fireEvent.click(screen.getByRole("button", { name: inboxCopy.callOutcome[outcome] }));
      expect(onLog).toHaveBeenCalledWith(hannah.id, outcome, undefined);
      unmount();
    }
  });

  it("asks for one line of notes after Spoke, and logs it with them", () => {
    const onLog = vi.fn();
    const hannah = call();
    const { container } = render(<CallCard item={hannah} onLog={onLog} />);

    expect(screen.queryByPlaceholderText(inboxCopy.notesPlaceholder)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: inboxCopy.callOutcome.spoke }));
    expect(onLog).not.toHaveBeenCalled();

    const box = screen.getByPlaceholderText(inboxCopy.notesPlaceholder);
    // The four outcomes have gone; Log it is the one primary now.
    expect(screen.queryAllByTestId("call-outcome")).toHaveLength(0);
    expect(container.querySelectorAll(".bg-action")).toHaveLength(1);

    fireEvent.change(box, { target: { value: "Weekend line is the answering service." } });
    fireEvent.click(screen.getByRole("button", { name: inboxCopy.notesDone }));
    expect(onLog).toHaveBeenCalledWith(hannah.id, "spoke", "Weekend line is the answering service.");
  });

  it("takes Enter in the notes box as Log it, and an empty line as no notes", () => {
    const onLog = vi.fn();
    const hannah = call();
    render(<CallCard item={hannah} onLog={onLog} />);

    fireEvent.click(screen.getByRole("button", { name: inboxCopy.callOutcome.spoke }));
    const box = screen.getByPlaceholderText(inboxCopy.notesPlaceholder);
    fireEvent.submit(box.closest("form") as HTMLFormElement);

    expect(onLog).toHaveBeenCalledWith(hannah.id, "spoke", undefined);
  });

  it("each outcome takes the row out of the queue and says so", () => {
    for (const outcome of CALL_OUTCOMES) {
      resetQueue();
      const { unmount } = render(<Inbox />);

      fireEvent.click(screen.getAllByTestId("queue-row")[2] as HTMLElement); // Hannah
      const before = screen.getAllByTestId("queue-row").length;

      fireEvent.click(screen.getByRole("button", { name: inboxCopy.callOutcome[outcome] }));
      if (outcome === "spoke") {
        fireEvent.click(screen.getByRole("button", { name: inboxCopy.notesDone }));
      }

      expect(screen.getAllByTestId("queue-row")).toHaveLength(before - 1);
      expect(screen.queryByRole("heading", { level: 2, name: /Hannah Lee/ })).toBeNull();
      expect(screen.getByRole("status").textContent).toBe(
        `${inboxCopy.logged} ${inboxCopy.callOutcome[outcome].toLowerCase()}.`,
      );
      unmount();
    }
  });
});
