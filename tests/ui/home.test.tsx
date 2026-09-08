import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HomeDayOne } from "@/components/HomeDayOne";
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
    const startBrief = vi.fn(async () => homeCopy.campaignsNext);

    render(
      <HomeDayOne
        firstName="Ben"
        today="Mon 7 Sep"
        connections={BOTH_CONNECTED}
        startBrief={startBrief}
      />,
    );

    expect(screen.queryByText(homeCopy.campaignsNext)).toBeNull();

    const box = screen.getByPlaceholderText(homeCopy.briefPlaceholder) as HTMLInputElement;
    fireEvent.change(box, { target: { value: "UK logistics firms, ops directors" } });
    fireEvent.click(screen.getByRole("button", { name: homeCopy.briefStart }));

    expect(await screen.findByText(homeCopy.campaignsNext)).toBeDefined();
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
