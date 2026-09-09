import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Inbox } from "@/components/inbox/Inbox";
import { ReplyCard } from "@/components/inbox/ReplyCard";
import { REPLY_LABELS, inboxCopy } from "@/lib/copy/inbox";
import { listQueue, resetQueue, type ReplyItem } from "@/lib/fixtures/inbox";

/** The reply card (master doc §23.1b; mock section 2b): their message, and one job. */

beforeEach(() => {
  resetQueue();
});

function reply(name: string): ReplyItem {
  const found = listQueue().items.find(
    (item): item is ReplyItem => item.kind === "reply" && item.person.name === name,
  );
  if (found === undefined) throw new Error(`no reply from ${name} in the fixtures`);
  return found;
}

const noop = () => undefined;

describe("the reply card", () => {
  it("shows their message in full, and when it came", () => {
    const priya = reply("Priya Raman");
    render(<ReplyCard item={priya} onLabel={noop} />);

    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(
      `Priya Raman${inboxCopy.join}Head of Operations, Brightline Logistics`,
    );
    expect(screen.getByText(`${inboxCopy.repliedAt} 07:42`)).toBeDefined();
    for (const paragraph of priya.message) {
      expect(screen.getByText(paragraph)).toBeDefined();
    }
  });

  it("keeps the sent email collapsed beneath, and opens it on request", () => {
    const priya = reply("Priya Raman");
    render(<ReplyCard item={priya} onLabel={noop} />);

    const sent = screen.getByTestId("sent-email") as HTMLDetailsElement;
    expect(sent.open).toBe(false);
    expect(sent.textContent).toContain(`${inboxCopy.yourEmail} ${priya.sent.sentAt}`);
    expect(sent.textContent).toContain(priya.sent.subject);
    for (const paragraph of priya.sent.body) {
      // In the markup, so a rep who opens it reads it; collapsed until then.
      expect(screen.getByText(paragraph)).toBeDefined();
    }
  });

  it("has one job: the four labels, warm as the primary", () => {
    const { container } = render(<ReplyCard item={reply("Priya Raman")} onLabel={noop} />);

    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(inboxCopy.labelThis);
    const labels = screen.getAllByTestId("reply-label");
    expect(labels.map((label) => label.textContent)).toEqual(
      REPLY_LABELS.map((label) => inboxCopy.replyLabel[label]),
    );
    expect(container.querySelectorAll(".bg-action")).toHaveLength(1);
    expect(labels[0]?.className).toContain("bg-action");
    // Nothing else to press: no approve, no reject, no Zoho.
    expect(screen.getAllByRole("button")).toHaveLength(4);
    expect(container.textContent).not.toMatch(/zoho/i);
  });

  it("hands the chosen label back", () => {
    const onLabel = vi.fn();
    const priya = reply("Priya Raman");
    render(<ReplyCard item={priya} onLabel={onLabel} />);

    fireEvent.click(screen.getByRole("button", { name: inboxCopy.replyLabel.stop }));
    expect(onLabel).toHaveBeenCalledWith(priya.id, "stop");
  });

  it("opens the thread from the mailbox when the fixture has one, and mailto when it does not", () => {
    const priya = reply("Priya Raman");
    const { unmount } = render(<ReplyCard item={priya} onLabel={noop} />);
    const link = screen.getByRole("link", { name: new RegExp(inboxCopy.replyFromMailbox) });
    expect(link.getAttribute("href")).toBe(priya.threadUrl);
    unmount();

    const tom = reply("Tom Ashworth");
    render(<ReplyCard item={tom} onLabel={noop} />);
    const href = screen
      .getByRole("link", { name: new RegExp(inboxCopy.replyFromMailbox) })
      .getAttribute("href");
    expect(href).toMatch(/^mailto:tom\.ashworth@harland\.example\?subject=/);
    expect(decodeURIComponent(href ?? "")).toContain(`Re: ${tom.sent.subject}`);
  });

  it("percent-encodes the mailto address as well as the subject", () => {
    const tom = reply("Tom Ashworth");
    const odd: ReplyItem = {
      ...tom,
      threadUrl: null,
      person: { ...tom.person, email: "tom+ops @harland.example" },
    };
    render(<ReplyCard item={odd} onLabel={noop} />);

    const href = screen
      .getByRole("link", { name: new RegExp(inboxCopy.replyFromMailbox) })
      .getAttribute("href");
    expect(href).toMatch(/^mailto:tom%2Bops%20@harland\.example\?subject=/);
  });

  it("each label takes the row out of the queue and says so", () => {
    for (const label of REPLY_LABELS) {
      resetQueue();
      const { unmount } = render(<Inbox />);

      const before = screen.getAllByTestId("queue-row").length;
      fireEvent.click(screen.getByRole("button", { name: inboxCopy.replyLabel[label] }));

      expect(screen.getAllByTestId("queue-row")).toHaveLength(before - 1);
      expect(screen.getByRole("status").textContent).toBe(
        `${inboxCopy.labelled} ${inboxCopy.replyLabel[label].toLowerCase()}.`,
      );
      unmount();
    }
  });
});
