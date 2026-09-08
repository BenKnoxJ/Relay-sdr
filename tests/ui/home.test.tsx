import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HomeDayOne } from "@/components/HomeDayOne";
import { campaignsCopy } from "@/lib/copy/campaigns";
import { homeCopy } from "@/lib/copy/home";

const BOTH_CONNECTED = { mailbox: true, zoho: true };
const NEITHER_CONNECTED = { mailbox: false, zoho: false };

const noop = async () => null;

describe("Home on day one", () => {
  it("greets the rep by first name, with the date beside it", () => {
    render(
      <HomeDayOne
        firstName="Ben"
        today="Mon 7 Sep"
        connections={BOTH_CONNECTED}
        startBrief={noop}
      />,
    );

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(`${homeCopy.welcome}, Ben`);
    expect(screen.getByText("Mon 7 Sep")).toBeDefined();
  });

  it("is the brief box and its question, and nothing else to click", () => {
    render(
      <HomeDayOne
        firstName="Ben"
        today="Mon 7 Sep"
        connections={BOTH_CONNECTED}
        startBrief={noop}
      />,
    );

    expect(screen.getByRole("heading", { level: 2, name: homeCopy.briefQuestion })).toBeDefined();
    expect(screen.getByText(homeCopy.briefHint)).toBeDefined();
    expect(screen.getByPlaceholderText(homeCopy.briefPlaceholder)).toBeDefined();
    expect(screen.getByText(homeCopy.briefFooter)).toBeDefined();
    // One control on the page: Start. Nothing else is clickable (§23.1a).
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([homeCopy.briefStart]);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("prompts for both connections while neither is connected", () => {
    render(
      <HomeDayOne
        firstName="Ben"
        today="Mon 7 Sep"
        connections={NEITHER_CONNECTED}
        startBrief={noop}
      />,
    );

    expect(screen.getByText(homeCopy.connectMailbox)).toBeDefined();
    expect(screen.getByText(homeCopy.connectZoho)).toBeDefined();
  });

  it("prompts for neither once both are connected", () => {
    render(
      <HomeDayOne
        firstName="Ben"
        today="Mon 7 Sep"
        connections={BOTH_CONNECTED}
        startBrief={noop}
      />,
    );

    expect(screen.queryByText(homeCopy.connectMailbox)).toBeNull();
    expect(screen.queryByText(homeCopy.connectZoho)).toBeNull();
  });

  it("prompts for only the one that is missing", () => {
    render(
      <HomeDayOne
        firstName="Ben"
        today="Mon 7 Sep"
        connections={{ mailbox: false, zoho: true }}
        startBrief={noop}
      />,
    );

    expect(screen.getByText(homeCopy.connectMailbox)).toBeDefined();
    expect(screen.queryByText(homeCopy.connectZoho)).toBeNull();
  });

  it("shows what Start does today, and only after it is used", async () => {
    const startBrief = vi.fn(async () => campaignsCopy.next);

    render(
      <HomeDayOne
        firstName="Ben"
        today="Mon 7 Sep"
        connections={BOTH_CONNECTED}
        startBrief={startBrief}
      />,
    );

    expect(screen.queryByText(campaignsCopy.next)).toBeNull();

    const box = screen.getByPlaceholderText(homeCopy.briefPlaceholder) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "UK logistics firms, ops directors" } });
    fireEvent.click(screen.getByRole("button", { name: homeCopy.briefStart }));

    expect(await screen.findByText(campaignsCopy.next)).toBeDefined();
    expect(startBrief).toHaveBeenCalledTimes(1);
    // The sentence reaches the action, which is the only thing it is for.
    const [, formData] = startBrief.mock.calls[0] as unknown as [unknown, FormData];
    expect(formData.get("sentence")).toBe("UK logistics firms, ops directors");
  });

  /**
   * The rail is the widget slot: slice 1 drops its widgets in without moving
   * the card. Empty today, so the grid must not leave a signed two-column gap
   * where nothing is (the signed mock centres the day-one card).
   */
  it("leaves the rail empty and the card centred on day one", () => {
    render(
      <HomeDayOne
        firstName="Ben"
        today="Mon 7 Sep"
        connections={BOTH_CONNECTED}
        startBrief={noop}
      />,
    );

    const grid = screen.getByTestId("home-grid");
    expect(grid.className).not.toContain("grid-cols-home");
    expect(screen.queryByTestId("home-rail")).toBeNull();
  });

  /**
   * WCAG 2.4.7. The input paints no ring of its own — it is borderless inside
   * the pill, and a ring drawn on it would sit inside the pill's own border.
   * The ring belongs to the pill, which is the control a rep sees.
   */
  it("rings the whole pill when the box has focus", () => {
    render(
      <HomeDayOne
        firstName="Ben"
        today="Mon 7 Sep"
        connections={BOTH_CONNECTED}
        startBrief={noop}
      />,
    );

    expect(screen.getByTestId("brief-pill").className).toContain("focus-within:ring-2");
  });

  /**
   * The disabled Start button guards the mouse and nothing else. Enter goes
   * straight to `requestSubmit`, so a rep leaning on it fired the action once
   * per press — harmless against today's stub, a duplicate campaign in slice 1.
   */
  it("does not fire the action again on Enter while one is already in flight", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const startBrief = vi.fn(async () => {
      await held;
      return campaignsCopy.next;
    });

    render(
      <HomeDayOne
        firstName="Ben"
        today="Mon 7 Sep"
        connections={BOTH_CONNECTED}
        startBrief={startBrief}
      />,
    );

    const box = screen.getByPlaceholderText(homeCopy.briefPlaceholder) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "UK logistics firms, ops directors" } });

    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.keyDown(box, { key: "Enter" });

    release();
    expect(await screen.findByText(campaignsCopy.next)).toBeDefined();
    expect(startBrief).toHaveBeenCalledTimes(1);
  });

  /**
   * The box is a textarea so the signed two-line example fits (mock 1b), which
   * hands Enter back its newline. A brief is one sentence and the mock draws
   * one button: Enter has to keep submitting, or the control the rep reaches
   * for silently changes meaning.
   */
  it("submits on Enter and takes a newline on Shift+Enter", async () => {
    const startBrief = vi.fn(async () => campaignsCopy.next);

    render(
      <HomeDayOne
        firstName="Ben"
        today="Mon 7 Sep"
        connections={BOTH_CONNECTED}
        startBrief={startBrief}
      />,
    );

    const box = screen.getByPlaceholderText(homeCopy.briefPlaceholder) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "UK logistics firms, ops directors" } });

    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(startBrief).not.toHaveBeenCalled();

    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByText(campaignsCopy.next)).toBeDefined();
    expect(startBrief).toHaveBeenCalledTimes(1);
  });

  /**
   * An IME composing Japanese or Chinese ends a candidate with Enter. Reading
   * that as submit sends a half-typed brief, so the box waits for the key that
   * is not part of the composition.
   */
  it("does not submit on the Enter that closes an IME candidate", () => {
    const startBrief = vi.fn(async () => campaignsCopy.next);

    render(
      <HomeDayOne
        firstName="Ben"
        today="Mon 7 Sep"
        connections={BOTH_CONNECTED}
        startBrief={startBrief}
      />,
    );

    const box = screen.getByPlaceholderText(homeCopy.briefPlaceholder) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "\u3042" } });
    fireEvent.keyDown(box, { key: "Enter", isComposing: true });

    expect(startBrief).not.toHaveBeenCalled();
  });

  /** The mock draws the example over two lines; one line clips two of its three clauses. */
  it("gives the box the two lines the signed example needs", () => {
    render(
      <HomeDayOne
        firstName="Ben"
        today="Mon 7 Sep"
        connections={BOTH_CONNECTED}
        startBrief={noop}
      />,
    );

    const box = screen.getByPlaceholderText(homeCopy.briefPlaceholder);
    expect(box.tagName).toBe("TEXTAREA");
    expect(box.getAttribute("rows")).toBe("2");
    expect(box.className).toContain("resize-none");
  });

  it("puts the rail beside the card once there is a widget for it", () => {
    render(
      <HomeDayOne
        firstName="Ben"
        today="Mon 7 Sep"
        connections={BOTH_CONNECTED}
        startBrief={noop}
        rail={<p>a widget</p>}
      />,
    );

    expect(screen.getByTestId("home-grid").className).toContain("grid-cols-home");
    expect(screen.getByTestId("home-rail").textContent).toBe("a widget");
  });
});
