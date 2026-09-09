import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import InboxPage from "@/app/(app)/inbox/page";
import { Inbox } from "@/components/inbox/Inbox";
import { inboxCopy } from "@/lib/copy/inbox";
import { listQueue, resetQueue, type Queue } from "@/lib/fixtures/inbox";

/**
 * The queue (master doc §23.1b; mock section 2): one list, fixed order, and
 * the way a rep moves through it.
 *
 * The adapter keeps its state for the session, so every case starts from the
 * fixtures again.
 */

beforeEach(() => {
  resetQueue();
});

const rows = () => screen.getAllByTestId("queue-row");
const selectedRow = () => rows().find((row) => row.getAttribute("aria-current") === "true");
const nameOf = (row: HTMLElement) => row.querySelector(".font-semibold.text-ink")?.textContent;

/** A queue with nothing in it, and the adapter's own next-drafts time. */
function empty(): Queue {
  const queue = listQueue();
  return { items: [], counts: { replies: 0, calls: 0, drafts: 0 }, nextDrafts: queue.nextDrafts };
}

describe("the queue", () => {
  it("is replies, then calls due, then drafts due today, under three headings", () => {
    render(<InboxPage />);

    expect(
      screen.getAllByRole("heading", { level: 2 }).slice(0, 3).map((heading) => heading.textContent),
    ).toEqual([inboxCopy.headingReplies, inboxCopy.headingCalls, inboxCopy.headingDrafts]);

    expect(rows().map((row) => row.getAttribute("data-kind"))).toEqual([
      "reply",
      "reply",
      "call",
      "draft",
      "draft",
      "draft",
    ]);
  });

  it("counts what is waiting in the header note", () => {
    render(<InboxPage />);

    expect(
      screen.getByText(
        `2 ${inboxCopy.replies}${inboxCopy.countJoin}1 ${inboxCopy.call}${inboxCopy.countJoin}3 ${inboxCopy.drafts}`,
      ),
    ).toBeDefined();
  });

  it("drops a kind from the note once none of it is waiting, as the mock's 2c does", () => {
    render(<InboxPage />);

    // Label both replies away.
    fireEvent.click(screen.getAllByTestId("reply-label")[0] as HTMLElement);
    fireEvent.click(screen.getAllByTestId("reply-label")[0] as HTMLElement);

    expect(
      screen.getByText(`1 ${inboxCopy.call}${inboxCopy.countJoin}3 ${inboxCopy.drafts}`),
    ).toBeDefined();
  });

  it("has no filter, no search and no tabs", () => {
    render(<InboxPage />);

    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryAllByRole("searchbox")).toHaveLength(0);
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
  });

  it("puts the drafts that need the rep first among the drafts, with the warn chip and the reason", () => {
    render(<InboxPage />);

    const drafts = rows().filter((row) => row.getAttribute("data-kind") === "draft");
    const first = drafts[0] as HTMLElement;

    expect(nameOf(first)).toBe("Rachel Muir");
    expect(within(first).getByText(inboxCopy.needsYou).className).toContain("text-warn");
    expect(
      within(first).getByText(
        `${inboxCopy.needsYouLead}${inboxCopy.join}${inboxCopy.needsYouReason.voice}`,
      ),
    ).toBeDefined();
    // And the others carry the send day where the chip would be.
    expect(within(drafts[1] as HTMLElement).getByText("Thu")).toBeDefined();
  });

  it("selects the first row to begin with, and the row that is clicked after that", () => {
    render(<InboxPage />);

    expect(nameOf(selectedRow() as HTMLElement)).toBe("Priya Raman");

    fireEvent.click(rows()[3] as HTMLElement);
    expect(nameOf(selectedRow() as HTMLElement)).toBe("Rachel Muir");
    expect(screen.getByRole("heading", { level: 2, name: /Rachel Muir/ })).toBeDefined();
  });

  it("takes a worked row out and selects the one that took its place", () => {
    render(<InboxPage />);

    fireEvent.click(rows()[4] as HTMLElement); // Daniel
    expect(nameOf(selectedRow() as HTMLElement)).toBe("Daniel Okoro");

    fireEvent.click(screen.getByRole("button", { name: inboxCopy.approve }));

    expect(rows()).toHaveLength(5);
    expect(rows().map(nameOf)).not.toContain("Daniel Okoro");
    expect(nameOf(selectedRow() as HTMLElement)).toBe("Sofia Marsh");
  });

  it("selects the new last row when the last one is worked", () => {
    render(<InboxPage />);

    fireEvent.click(rows()[5] as HTMLElement); // Sofia, last
    fireEvent.click(screen.getByRole("button", { name: inboxCopy.approve }));

    expect(rows()).toHaveLength(5);
    expect(nameOf(selectedRow() as HTMLElement)).toBe("Daniel Okoro");
  });

  it("says what just happened, in a live region that was already there", () => {
    render(<InboxPage />);

    const status = screen.getByRole("status");
    expect(status.textContent).toBe("");

    fireEvent.click(rows()[4] as HTMLElement); // Daniel
    fireEvent.click(screen.getByRole("button", { name: inboxCopy.approve }));

    expect(screen.getByRole("status")).toBe(status);
    expect(status.textContent).toBe(`${inboxCopy.approved} ${inboxCopy.sends} Thu 09:00.`);
  });

  describe("the keyboard", () => {
    it("moves down on J and up on K, and stops at the ends", () => {
      render(<InboxPage />);

      fireEvent.keyDown(document, { key: "j" });
      expect(nameOf(selectedRow() as HTMLElement)).toBe("Tom Ashworth");
      fireEvent.keyDown(document, { key: "J" });
      expect(nameOf(selectedRow() as HTMLElement)).toBe("Hannah Lee");
      fireEvent.keyDown(document, { key: "k" });
      expect(nameOf(selectedRow() as HTMLElement)).toBe("Tom Ashworth");
      fireEvent.keyDown(document, { key: "k" });
      fireEvent.keyDown(document, { key: "k" });
      expect(nameOf(selectedRow() as HTMLElement)).toBe("Priya Raman");

      for (let i = 0; i < 10; i += 1) fireEvent.keyDown(document, { key: "j" });
      expect(nameOf(selectedRow() as HTMLElement)).toBe("Sofia Marsh");
    });

    it("approves the selected draft on Enter", () => {
      render(<InboxPage />);

      fireEvent.click(rows()[4] as HTMLElement); // Daniel
      fireEvent.keyDown(document, { key: "Enter" });

      expect(rows().map(nameOf)).not.toContain("Daniel Okoro");
      expect(screen.getByRole("status").textContent).toContain(inboxCopy.approved);
    });

    it("approves on Enter from the focused row too, which is where a click leaves focus", () => {
      render(<InboxPage />);

      const daniel = rows()[4] as HTMLElement;
      fireEvent.click(daniel);
      daniel.focus();
      fireEvent.keyDown(daniel, { key: "Enter" });

      expect(rows().map(nameOf)).not.toContain("Daniel Okoro");
    });

    it("selects, never approves, on Enter from a row the rep tabbed to", () => {
      render(<InboxPage />);

      const daniel = rows()[4] as HTMLElement;
      fireEvent.click(daniel);
      expect(nameOf(selectedRow() as HTMLElement)).toBe("Daniel Okoro");

      // Tab lands focus on Sofia's row without selecting it.
      const sofia = rows()[5] as HTMLElement;
      sofia.focus();
      fireEvent.keyDown(sofia, { key: "Enter" });

      expect(rows()).toHaveLength(6);
      expect(rows().map(nameOf)).toContain("Daniel Okoro");
      expect(nameOf(selectedRow() as HTMLElement)).toBe("Sofia Marsh");
      expect(screen.getByRole("status").textContent).toBe("");

      // Now that Sofia is the selected draft, Enter on her row approves her.
      fireEvent.keyDown(rows()[5] as HTMLElement, { key: "Enter" });
      expect(rows().map(nameOf)).not.toContain("Sofia Marsh");
      expect(rows().map(nameOf)).toContain("Daniel Okoro");
      expect(screen.getByRole("status").textContent).toContain(inboxCopy.approved);
    });

    it("does nothing on Enter when the selected row is a reply or a call", () => {
      render(<InboxPage />);

      fireEvent.keyDown(document, { key: "Enter" }); // Priya, a reply
      expect(rows()).toHaveLength(6);

      fireEvent.click(rows()[2] as HTMLElement); // Hannah, a call
      fireEvent.keyDown(document, { key: "Enter" });
      expect(rows()).toHaveLength(6);
    });

    it("leaves the keys alone while the rep is typing", () => {
      render(<InboxPage />);

      fireEvent.click(rows()[4] as HTMLElement); // Daniel
      fireEvent.click(screen.getByRole("button", { name: inboxCopy.edit }));
      const box = screen.getByRole("textbox", { name: inboxCopy.bodyField });

      fireEvent.keyDown(box, { key: "j" });
      fireEvent.keyDown(box, { key: "Enter" });

      expect(nameOf(selectedRow() as HTMLElement)).toBe("Daniel Okoro");
      expect(rows()).toHaveLength(6);
    });

    it("answers to nothing else", () => {
      render(<InboxPage />);

      for (const key of ["ArrowDown", "ArrowUp", "n", "p", " ", "Tab", "Escape"]) {
        fireEvent.keyDown(document, { key });
      }
      expect(nameOf(selectedRow() as HTMLElement)).toBe("Priya Raman");
      expect(rows()).toHaveLength(6);
    });
  });

  describe("empty", () => {
    it("says all clear, when the next drafts land, and that replies arrive as they come", () => {
      render(<Inbox initial={empty()} />);

      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(inboxCopy.title);
      expect(screen.getByText(inboxCopy.nothingWaiting)).toBeDefined();
      expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(inboxCopy.emptyHeading);
      expect(
        screen.getByText(`${inboxCopy.nextDrafts} Thursday 09:00. ${inboxCopy.repliesLand}`),
      ).toBeDefined();
      expect(screen.queryAllByRole("button")).toHaveLength(0);
    });

    it("is what the rep reaches by working every row", () => {
      render(<InboxPage />);

      // Two labels, one outcome, three approves: six rows, six clicks.
      fireEvent.click(screen.getAllByTestId("reply-label")[0] as HTMLElement);
      fireEvent.click(screen.getAllByTestId("reply-label")[0] as HTMLElement);
      fireEvent.click(screen.getAllByTestId("call-outcome")[1] as HTMLElement);
      fireEvent.click(screen.getByRole("button", { name: inboxCopy.approve }));
      fireEvent.click(screen.getByRole("button", { name: inboxCopy.approve }));
      fireEvent.click(screen.getByRole("button", { name: inboxCopy.approve }));

      expect(screen.queryAllByTestId("queue-row")).toHaveLength(0);
      expect(screen.getByText(inboxCopy.emptyHeading)).toBeDefined();
      expect(screen.getByText(inboxCopy.nothingWaiting)).toBeDefined();
    });
  });

  it("lays the list and the card out on the signed inbox grid", () => {
    render(<InboxPage />);

    expect(screen.getByTestId("inbox-grid").className).toContain("grid-cols-inbox");
  });
});
