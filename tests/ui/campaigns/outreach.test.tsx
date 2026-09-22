import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { OutreachCard } from "@/components/campaigns/OutreachCard";
import type { OutreachStartView } from "@/lib/campaigns/types";
import { outreachStartCopy as c } from "@/lib/copy/outreachStart";

/**
 * The Outreach card (Relay P3): Not started, or each start day with its
 * people; Start outreach says how many it starts and on which day; Pause and
 * Resume, with a clear Paused state.
 */

const view = (over: Partial<OutreachStartView> = {}): OutreachStartView => ({ startable: 18, drafted: 18, batches: [], paused: false, today: "2026-09-21", defaultStartOn: "2026-09-22", latestStartOn: "2026-10-21", ...over });

function draw(v: OutreachStartView, error: string | null = null) {
  const onStart = vi.fn();
  const onPause = vi.fn();
  render(<OutreachCard view={v} pending={false} error={error} onStart={onStart} onPause={onPause} />);
  return { onStart, onPause };
}

describe("OutreachCard", () => {
  it("before anyone starts: Not started, and the press says how many it will start", () => {
    draw(view());
    expect(screen.getByTestId("outreach-not-started").textContent).toBe(c.notStarted);
    expect(screen.getByTestId("outreach-start").textContent).toBe("Start outreach for 18 people");
    expect(screen.queryByTestId("outreach-pause")).toBeNull();
  });

  it("the date picker starts on the next working day, takes no day before today, and the press sends the day chosen", () => {
    const { onStart } = draw(view());
    fireEvent.click(screen.getByTestId("outreach-start"));
    const picker = screen.getByTestId("outreach-start-on") as HTMLInputElement;
    expect(picker.value).toBe("2026-09-22");
    expect(picker.min).toBe("2026-09-21");
    fireEvent.change(picker, { target: { value: "2026-09-28" } });
    fireEvent.click(screen.getByTestId("outreach-start-confirm"));
    expect(onStart).toHaveBeenCalledWith("2026-09-28");
  });

  it("the confirm button names the day, and a weekend day is sent as the Monday after (P3 review)", () => {
    const { onStart } = draw(view({ startable: 6 }));
    fireEvent.click(screen.getByTestId("outreach-start"));
    expect(screen.getByTestId("outreach-start-confirm").textContent).toBe("Start outreach for 6 people on Tue 22 Sep");
    fireEvent.change(screen.getByTestId("outreach-start-on"), { target: { value: "2026-09-26" } });
    expect(screen.getByTestId("outreach-start-confirm").textContent).toBe("Start outreach for 6 people on Mon 28 Sep");
    fireEvent.click(screen.getByTestId("outreach-start-confirm"));
    expect(onStart).toHaveBeenCalledWith("2026-09-28");
  });

  it("the picker stops 30 days ahead, and a day past it cannot be pressed", () => {
    const { onStart } = draw(view());
    fireEvent.click(screen.getByTestId("outreach-start"));
    const picker = screen.getByTestId("outreach-start-on") as HTMLInputElement;
    expect(picker.max).toBe("2026-10-21");
    fireEvent.change(picker, { target: { value: "2026-10-22" } });
    const confirm = screen.getByTestId("outreach-start-confirm") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(confirm.textContent).toBe("Start outreach for 18 people");
    fireEvent.click(confirm);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("a weekend at the end of the 30 days moves past it, so it cannot be pressed", () => {
    // The last day is Sat 17 Oct: it would start on Mon 19 Oct, which the server refuses.
    const { onStart } = draw(view({ latestStartOn: "2026-10-17" }));
    fireEvent.click(screen.getByTestId("outreach-start"));
    fireEvent.change(screen.getByTestId("outreach-start-on"), { target: { value: "2026-10-17" } });
    const confirm = screen.getByTestId("outreach-start-confirm") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("after starting: each start day with its people, and anyone added later waiting to start", () => {
    draw(
      view({
        startable: 1,
        batches: [
          { startOn: "2026-09-22", people: 18 },
          { startOn: "2026-10-05", people: 20 },
        ],
      }),
    );
    const lines = [...screen.getByTestId("outreach-batches").querySelectorAll("li")].map((li) => li.textContent);
    expect(lines).toEqual([`${c.startedOn} Tue 22 Sep · 18 people`, `${c.startedOn} Mon 5 Oct · 20 people`]);
    expect(screen.getByTestId("outreach-waiting").textContent).toBe(`1 person ${c.waiting}`);
    expect(screen.getByTestId("outreach-start").textContent).toBe("Start outreach for 1 person");
  });

  it("once everyone has started there is no Start press, and Pause pauses", () => {
    const { onPause } = draw(view({ startable: 0, batches: [{ startOn: "2026-09-22", people: 18 }] }));
    expect(screen.queryByTestId("outreach-start")).toBeNull();
    fireEvent.click(screen.getByTestId("outreach-pause"));
    expect(onPause).toHaveBeenCalledWith(true);
  });

  it("while paused: a Paused mark, the note, and Resume", () => {
    const { onPause } = draw(view({ startable: 0, batches: [{ startOn: "2026-09-22", people: 18 }], paused: true }));
    expect(screen.getByText(c.paused)).toBeTruthy();
    expect(screen.getByTestId("outreach-paused").textContent).toBe(c.pausedNote);
    fireEvent.click(screen.getByTestId("outreach-resume"));
    expect(onPause).toHaveBeenCalledWith(false);
  });

  it("shows a refusal line", () => {
    draw(view(), c.nothingToStart);
    expect(screen.getByRole("alert").textContent).toBe(c.nothingToStart);
  });
});
