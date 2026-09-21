import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PeopleTab } from "@/components/people/PeopleTab";
import { outreachPeopleCopy as c } from "@/lib/copy/outreachPeople";
import type { PeopleFilter } from "@/lib/outreach/peopleList";

import { TODAY, actionsMock, listRow, personView } from "./fixtures";

/**
 * The People tab (Relay P5): the rows, most urgent first; the filters in the
 * URL; the due colours; the LinkedIn link; and the drawer opening when the
 * page hands it the person `?person=` names.
 */

const push = vi.fn();
const replace = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ usePathname: () => "/campaigns/c1", useRouter: () => ({ push, replace, refresh }) }));

beforeEach(() => {
  push.mockReset();
  replace.mockReset();
  refresh.mockReset();
});
afterEach(() => vi.useRealTimers());

const NONE: PeopleFilter = { status: null, due: false, q: "" };

const rows = [
  listRow("Nell Oakley", { status: "replied", nextDue: null }),
  listRow("Blair Kendrick", { nextDue: { step: "email2", due: "2026-09-28" } }),
  listRow("Avery Dunmore", { nextDue: { step: "call1", due: "2026-09-17" }, linkedinUrl: "https://www.linkedin.com/in/avery" }),
  listRow("Orla Bellamy", { nextDue: { step: "li_connect", due: TODAY } }),
  listRow("Marlo Holloway", { nextDue: { step: "li_dm", due: "2026-09-23" } }),
];

function draw(filter: PeopleFilter = NONE, extra: Partial<Parameters<typeof PeopleTab>[0]> = {}) {
  return render(<PeopleTab campaignId="c1" today={TODAY} paused={false} rows={rows} filter={filter} person={null} actions={actionsMock()} {...extra} />);
}

const names = () => screen.getAllByTestId("people-row").map((row) => row.querySelector("[data-person-row] span")?.textContent);

describe("the People list", () => {
  it("lists everyone, most urgent first: overdue, due today, then by next due day, nothing due last", () => {
    draw();
    expect(names()).toEqual(["Avery Dunmore", "Orla Bellamy", "Marlo Holloway", "Blair Kendrick", "Nell Oakley"]);
    expect(screen.getByTestId("people-count").textContent).toBe(`5 ${c.of} 5 ${c.shown}`);
  });

  it("shows status, progress, the next step and its day, the LinkedIn link and the start day on a row", () => {
    draw();
    const avery = screen.getAllByTestId("people-row")[0]!;
    expect(within(avery).getByText(c.status.in_sequence)).toBeTruthy();
    expect(within(avery).getByTestId("people-progress").textContent).toBe("2/8");
    expect(within(avery).getByTestId("people-next").textContent).toBe(`${c.next} ${c.step.call1} ${c.overdue} Thu 17 Sep`);
    const link = within(avery).getByTestId("people-linkedin") as HTMLAnchorElement;
    expect(link.href).toBe("https://www.linkedin.com/in/avery");
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
    expect(within(avery).getByTestId("people-started").textContent).toBe(`${c.started} Mon 14 Sep`);
    // No link on a person with no web address for it.
    expect(within(screen.getAllByTestId("people-row")[1]!).queryByTestId("people-linkedin")).toBeNull();
  });

  it("marks overdue in the warn chip, today and the next two working days as soon, and later days plainly", () => {
    draw();
    const [avery, orla, marlo, blair] = screen.getAllByTestId("people-row");
    expect(within(avery!).getByText(`${c.overdue} Thu 17 Sep`).className).toContain("bg-warn-bg");
    expect(within(orla!).getByText("Mon 21 Sep").dataset.tone).toBe("soon");
    expect(within(marlo!).getByText("Wed 23 Sep").dataset.tone).toBe("soon");
    expect(within(blair!).getByText("Mon 28 Sep").dataset.tone).toBe("none");
  });

  it("filters by status, due today or overdue, and a search, all from the URL", () => {
    const { unmount } = draw({ status: "replied", due: false, q: "" });
    expect(names()).toEqual(["Nell Oakley"]);
    unmount();
    const second = draw({ status: null, due: true, q: "" });
    expect(names()).toEqual(["Avery Dunmore", "Orla Bellamy"]);
    second.unmount();
    draw({ status: null, due: false, q: "kendrick" });
    expect(names()).toEqual(["Blair Kendrick"]);
  });

  it("writes a filter change into the URL", () => {
    draw();
    fireEvent.change(screen.getByTestId("people-filter-status"), { target: { value: "meeting" } });
    expect(replace).toHaveBeenLastCalledWith("/campaigns/c1?tab=people&status=meeting", { scroll: false });
    fireEvent.click(screen.getByTestId("people-filter-due"));
    expect(replace).toHaveBeenLastCalledWith("/campaigns/c1?tab=people&due=1", { scroll: false });
  });

  it("writes the search into the URL a moment after typing stops", () => {
    vi.useFakeTimers();
    draw();
    fireEvent.change(screen.getByTestId("people-search"), { target: { value: "orla" } });
    expect(replace).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(replace).toHaveBeenLastCalledWith("/campaigns/c1?tab=people&q=orla", { scroll: false });
  });

  it("says when nobody matches, with a way back to everyone", () => {
    draw({ status: "closed", due: false, q: "" });
    expect(screen.getByTestId("people-empty").textContent).toContain(c.nobody);
    expect((screen.getByRole("link", { name: c.clearFilters }) as HTMLAnchorElement).getAttribute("href")).toBe("/campaigns/c1?tab=people");
  });

  it("each row is a link to that person's drawer, keeping the filters, so a keyboard opens it too", () => {
    draw({ status: null, due: true, q: "" });
    const link = within(screen.getAllByTestId("people-row")[0]!).getAllByRole("link")[0] as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/campaigns/c1?tab=people&due=1&person=cp-avery-dunmore");
    expect(link.textContent).toContain("Avery Dunmore");
  });

  it("opens the drawer for the person the page read from ?person=, and marks their row", () => {
    draw(NONE, { person: { ...personView(), campaignPersonId: "cp-avery-dunmore" } });
    expect(screen.getByRole("dialog", { name: "Avery Dunmore" })).toBeTruthy();
    expect(screen.getAllByTestId("people-row")[0]!.className).toContain("bg-soft");
  });

  it("a ?person= that names nobody here opens the drawer saying so", () => {
    draw(NONE, { personMissing: true });
    expect(screen.getByTestId("person-drawer-missing").textContent).toBe(c.notFound);
  });

  it("says so when the campaign is paused", () => {
    draw(NONE, { paused: true });
    expect(screen.getByTestId("people-paused").textContent).toBe(c.paused);
  });
});
