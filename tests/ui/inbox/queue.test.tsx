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

/** A queue with nothing in it. */
function empty(): Queue {
  return { items: [], counts: { replies: 0, calls: 0, drafts: 0 } };
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

  /**
   * The queue is the fixture until there are rows, and the page says so: a
   * banner that stays whatever the rep does, and "example" where the signed
   * mock put the counts. A count of examples is a number true of nothing.
   */
  it("banners the whole queue as examples, and keeps the banner up as rows are worked", () => {
    render(<InboxPage />);

    const banner = screen.getByTestId("inbox-demo-banner");
    expect(banner.textContent).toBe(inboxCopy.demoBanner);
    expect(banner.className).toContain("bg-warn-bg");
    expect(banner.compareDocumentPosition(rows()[0] as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(screen.getAllByTestId("reply-label")[0] as HTMLElement);
    expect(screen.getByTestId("inbox-demo-banner")).toBeDefined();
  });

  it("says example in the header note, never a count of what is waiting", () => {
    render(<InboxPage />);

    const note = screen.getByText(inboxCopy.exampleNote);
    const header = note.closest("header");
    expect(header).not.toBeNull();
    expect(header?.textContent).not.toMatch(/[0-9]+ (replies|reply|calls|call|drafts|draft)/);
    // The adapter still counts; the page just does not put the number on the screen.
    expect(listQueue().counts).toEqual({ replies: 2, calls: 1, drafts: 3 });
  });

  it("greets nobody by name in the fixture reply, so no rep reads another person's name as theirs", () => {
    render(<InboxPage />);

    expect(document.body.textContent).not.toContain("Hi Ben");
    expect(screen.getByText(/^Hi there,/)).toBeDefined();
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
    it("says all clear and that replies arrive as they come, and promises no day for the next drafts", () => {
      render(<Inbox initial={empty()} />);

      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(inboxCopy.title);
      expect(screen.getByText(inboxCopy.nothingWaiting)).toBeDefined();
      expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(inboxCopy.emptyHeading);
      expect(screen.getByText(inboxCopy.repliesLand)).toBeDefined();
      expect(document.body.textContent).not.toMatch(/Thursday|Next drafts/);
      expect(screen.queryAllByRole("button")).toHaveLength(0);
      // The banner stays even here: the empty queue is still the fixture's.
      expect(screen.getByTestId("inbox-demo-banner")).toBeDefined();
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
