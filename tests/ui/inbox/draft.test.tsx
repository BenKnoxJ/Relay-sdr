import { readFileSync } from "node:fs";
import path from "node:path";

import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DraftCard } from "@/components/inbox/DraftCard";
import { Inbox } from "@/components/inbox/Inbox";
import { REJECT_REASONS, inboxCopy } from "@/lib/copy/inbox";
import { listQueue, openers, resetQueue, type DraftItem } from "@/lib/fixtures/inbox";

import { outreachOutputSchema } from "../../../agents/outreach/output.schema";

/**
 * The draft card (master doc §23.1b; mock section 2a), and the one rule that
 * makes it more than a mock: it renders the signed outreach output and
 * nothing else.
 */

beforeEach(() => {
  resetQueue();
});

const FIXTURES = path.join(import.meta.dirname, "..", "..", "..", "agents", "outreach", "fixtures");
const goodDraft = () => JSON.parse(readFileSync(path.join(FIXTURES, "output.good.json"), "utf8"));

function draft(name: string): DraftItem {
  const found = listQueue().items.find(
    (item): item is DraftItem => item.kind === "draft" && item.person.name === name,
  );
  if (found === undefined) throw new Error(`no draft for ${name} in the fixtures`);
  return found;
}

const noop = () => undefined;

describe("the draft card", () => {
  it("shows who, the evidence with its source and date, subject, body and the three chips", () => {
    const daniel = draft("Daniel Okoro");
    render(<DraftCard item={daniel} onApprove={noop} onReject={noop} />);

    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(
      `Daniel Okoro${inboxCopy.join}Operations Director, Kestrel Couriers`,
    );
    expect(screen.getByText(`${inboxCopy.email} 1 ${inboxCopy.of} 3`)).toBeDefined();

    // The evidence line is the opener reference, resolved.
    expect(screen.getByText(new RegExp(daniel.opener.text))).toBeDefined();
    expect(screen.getByText(`${daniel.opener.source}, ${daniel.opener.date}`)).toBeDefined();

    if (daniel.draft.kind !== "message") throw new Error("Daniel's draft is a message");
    expect(screen.getByText(daniel.draft.subject as string)).toBeDefined();
    expect(screen.getByTestId("draft-body").textContent).toBe(daniel.draft.body);

    expect(screen.getByText(inboxCopy.emailFound).className).toContain("text-action");
    expect(screen.getByText(`${inboxCopy.fitLabel} ${inboxCopy.fit.strong}`)).toBeDefined();
    expect(screen.getByText(`${inboxCopy.sends} Thu 09:00`)).toBeDefined();
  });

  it("offers Approve, Edit and Reject, with one primary among them", () => {
    const { container } = render(
      <DraftCard item={draft("Daniel Okoro")} onApprove={noop} onReject={noop} />,
    );

    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      inboxCopy.approve,
      inboxCopy.edit,
      inboxCopy.reject,
    ]);
    expect(container.querySelectorAll(".bg-action")).toHaveLength(1);
  });

  it("edits inline, and Approve takes the edit", () => {
    const onApprove = vi.fn();
    const daniel = draft("Daniel Okoro");
    render(<DraftCard item={daniel} onApprove={onApprove} onReject={noop} />);

    fireEvent.click(screen.getByRole("button", { name: inboxCopy.edit }));
    const box = screen.getByRole("textbox", { name: inboxCopy.bodyField }) as HTMLTextAreaElement;
    if (daniel.draft.kind !== "message") throw new Error("Daniel's draft is a message");
    expect(box.value).toBe(daniel.draft.body);

    fireEvent.change(box, { target: { value: "Daniel, shorter. Ten minutes?" } });
    fireEvent.click(screen.getByRole("button", { name: inboxCopy.editDone }));
    expect(screen.getByTestId("draft-body").textContent).toBe("Daniel, shorter. Ten minutes?");

    fireEvent.click(screen.getByRole("button", { name: inboxCopy.approve }));
    expect(onApprove).toHaveBeenCalledWith(daniel.id, "Daniel, shorter. Ten minutes?");
  });

  it("approves without a body when nothing was edited", () => {
    const onApprove = vi.fn();
    const daniel = draft("Daniel Okoro");
    render(<DraftCard item={daniel} onApprove={onApprove} onReject={noop} />);

    fireEvent.click(screen.getByRole("button", { name: inboxCopy.approve }));
    expect(onApprove).toHaveBeenCalledWith(daniel.id, undefined);
  });

  it("keeps the four reasons behind Reject until it is pressed", () => {
    render(<DraftCard item={draft("Daniel Okoro")} onApprove={noop} onReject={noop} />);

    expect(screen.queryAllByTestId("reject-reason")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: inboxCopy.reject }));

    const reasons = screen.getAllByTestId("reject-reason");
    expect(reasons.map((reason) => reason.textContent)).toEqual(
      REJECT_REASONS.map((reason) => inboxCopy.rejectReason[reason]),
    );
    // Each one says what it does before it is chosen.
    expect(reasons.map((reason) => reason.getAttribute("title"))).toEqual(
      REJECT_REASONS.map((reason) => inboxCopy.rejectConsequence[reason]),
    );
  });

  it("hands the chosen reason back", () => {
    const onReject = vi.fn();
    const daniel = draft("Daniel Okoro");
    render(<DraftCard item={daniel} onApprove={noop} onReject={onReject} />);

    fireEvent.click(screen.getByRole("button", { name: inboxCopy.reject }));
    fireEvent.click(screen.getByText(inboxCopy.rejectReason.wrong_fact));

    expect(onReject).toHaveBeenCalledWith(daniel.id, "wrong_fact");
  });

  it("applies the consequence text once a reason is chosen, and the row leaves", () => {
    render(<Inbox />);

    const rows = () => screen.getAllByTestId("queue-row");
    fireEvent.click(rows()[4] as HTMLElement); // Daniel
    fireEvent.click(screen.getByRole("button", { name: inboxCopy.reject }));
    fireEvent.click(screen.getByText(inboxCopy.rejectReason.not_now));

    expect(screen.getByRole("status").textContent).toBe(
      `${inboxCopy.rejectReason.not_now}. ${inboxCopy.rejectConsequence.not_now}`,
    );
    expect(rows()).toHaveLength(5);
    expect(screen.queryByRole("heading", { level: 2, name: /Daniel Okoro/ })).toBeNull();
  });

  it("is the same card with the reason above the body for a draft that needs the rep", () => {
    const rachel = draft("Rachel Muir");
    render(<DraftCard item={rachel} onApprove={noop} onReject={noop} />);

    const reason = screen.getByTestId("needs-you-reason");
    expect(reason.textContent).toBe(
      `${inboxCopy.needsYouLead}${inboxCopy.join}${inboxCopy.needsYouReason.voice}. ${inboxCopy.needsYouCard}`,
    );
    expect(reason.className).toContain("text-warn");
    // Above the body, not beside the chips.
    expect(
      reason.compareDocumentPosition(screen.getByTestId("draft-body")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Still a draft: Approve, Edit, Reject.
    expect(screen.getByRole("button", { name: inboxCopy.approve })).toBeDefined();
    // And this one has no email yet, which the chip says.
    expect(screen.getByText(inboxCopy.noEmailYet)).toBeDefined();
  });

  it("says nothing about needing the rep on a draft that does not", () => {
    render(<DraftCard item={draft("Daniel Okoro")} onApprove={noop} onReject={noop} />);
    expect(screen.queryByTestId("needs-you-reason")).toBeNull();
  });

  it("does not open the edit box or the reasons again on the next row", () => {
    render(<Inbox />);

    const rows = () => screen.getAllByTestId("queue-row");
    fireEvent.click(rows()[4] as HTMLElement); // Daniel
    fireEvent.click(screen.getByRole("button", { name: inboxCopy.edit }));
    fireEvent.click(screen.getByRole("button", { name: inboxCopy.reject }));
    expect(screen.getAllByTestId("reject-reason")).toHaveLength(4);

    fireEvent.click(rows()[5] as HTMLElement); // Sofia
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryAllByTestId("reject-reason")).toHaveLength(0);
  });
});

describe("schema identity", () => {
  it("renders the signed outreach fixture as it is, through the adapter's own shape", () => {
    const parsed = outreachOutputSchema.parse(goodDraft());
    const daniel = draft("Daniel Okoro");
    // The fixture opens on a lookup item the page's pack does not hold, so the
    // card is given it resolved by hand: what is under test is that the card
    // takes the contract's shape, not the page's.
    const item: DraftItem = {
      ...daniel,
      draft: parsed,
      opener: {
        id: parsed.opener.ref,
        kind: parsed.opener.kind,
        text: "Told the trade press in June that complaint handling was being rebuilt.",
        source: "Trade press",
        date: "11 Jun",
      },
    };
    render(<DraftCard item={item} onApprove={noop} onReject={noop} />);

    if (parsed.kind !== "message") throw new Error("the good fixture is a message");
    expect(screen.getByText(parsed.subject as string)).toBeDefined();
    expect(screen.getByTestId("draft-body").textContent).toBe(parsed.body);
  });

  it("refuses a draft with no opener reference, rather than hiding the evidence line", () => {
    const raw = goodDraft() as Record<string, unknown>;
    delete raw.opener;

    const result = outreachOutputSchema.safeParse(raw);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toContain("opener");
    }
  });

  it("refuses an opener that is not an id, and a body that asks two questions", () => {
    const dangling = { ...goodDraft(), opener: { ref: "Not An Id", kind: "person_fact" } };
    expect(outreachOutputSchema.safeParse(dangling).success).toBe(false);

    const twoQuestions = { ...goodDraft(), body: `Is this one? ${goodDraft().body}` };
    expect(outreachOutputSchema.safeParse(twoQuestions).success).toBe(false);
  });

  it("resolves every fixture draft's opener through the pack, kind and id both", () => {
    const pack = openers();
    for (const item of listQueue().items) {
      if (item.kind === "reply") continue;
      const resolved = pack.find(
        (opener) => opener.id === item.draft.opener.ref && opener.kind === item.draft.opener.kind,
      );
      expect(resolved, item.id).toBeDefined();
      expect(item.opener).toBe(resolved);
    }
  });

  it("renders a call draft's talking point as three lines rather than a body", () => {
    const hannah = listQueue().items.find((item) => item.kind === "call");
    if (hannah === undefined || hannah.kind !== "call") throw new Error("no call in the fixtures");
    const daniel = draft("Daniel Okoro");

    render(
      <DraftCard
        item={{ ...daniel, draft: hannah.draft, opener: hannah.opener }}
        onApprove={noop}
        onReject={noop}
      />,
    );

    const point = screen.getByTestId("draft-talking-point");
    expect(within(point).getByText(hannah.draft.talkingPoint.openingLine)).toBeDefined();
    expect(within(point).getByText(hannah.draft.talkingPoint.oneQuestion)).toBeDefined();
    expect(within(point).getByText(hannah.draft.talkingPoint.listenFor)).toBeDefined();
    // Nothing to edit inline on a talking point.
    expect(screen.queryByRole("button", { name: inboxCopy.edit })).toBeNull();
  });
});
