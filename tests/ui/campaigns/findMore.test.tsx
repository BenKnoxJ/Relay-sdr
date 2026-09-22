import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FindMoreCard } from "@/components/campaigns/FindMoreCard";
import type { FindMoreView } from "@/lib/campaigns/types";
import { findMoreCopy as c } from "@/lib/copy/findMore";

/**
 * The Find more people card (P5b): closed, one button; open, 10, 20 or 30
 * people with the credit estimate and what is left of the approved search
 * limit; over what is left, it says so and the press approves a new limit.
 */

const view = (over: Partial<FindMoreView> = {}): FindMoreView => ({
  batch: 2,
  cap: 40,
  remaining: 28,
  newCap: 40,
  options: [
    { howMany: 10, estimate: 12, needsNewCap: false },
    { howMany: 20, estimate: 24, needsNewCap: false },
    { howMany: 30, estimate: 36, needsNewCap: true },
  ],
  sample: false,
  ...over,
});

function draw(v: FindMoreView = view(), error: string | null = null) {
  const onFind = vi.fn();
  render(<FindMoreCard view={v} pending={false} error={error} onFind={onFind} />);
  return { onFind };
}

describe("FindMoreCard", () => {
  it("closed, it names the batch and offers one button", () => {
    draw();
    expect(screen.getByTestId("find-more-card").textContent).toContain(`${c.batch} 2 ${c.intro}`);
    expect(screen.getByTestId("find-more-open").textContent).toBe(c.open);
    expect(screen.queryByTestId("find-more-form")).toBeNull();
  });

  it("open, it shows the estimate and what is left for the number chosen, and the press sends it", () => {
    const { onFind } = draw();
    fireEvent.click(screen.getByTestId("find-more-open"));
    expect(screen.getByTestId("find-more-estimate").textContent).toBe(`${c.about} 24 ${c.searchCredits}`);
    expect(screen.getByTestId("find-more-left").textContent).toBe(`28 ${c.of} 40 ${c.leftOfCap}`);
    fireEvent.click(screen.getByTestId("find-more-10"));
    expect(screen.getByTestId("find-more-estimate").textContent).toBe(`${c.about} 12 ${c.searchCredits}`);
    expect(screen.queryByTestId("find-more-new-cap")).toBeNull();
    fireEvent.click(screen.getByTestId("find-more-confirm"));
    expect(onFind).toHaveBeenCalledWith(10, false);
  });

  it("over what is left, it asks the rep to approve a new limit, and the press says so", () => {
    const { onFind } = draw();
    fireEvent.click(screen.getByTestId("find-more-open"));
    fireEvent.click(screen.getByTestId("find-more-30"));
    expect(screen.getByTestId("find-more-new-cap").textContent).toBe(`${c.capUsed} 40 ${c.credits}.`);
    expect(screen.getByTestId("find-more-confirm").textContent).toBe(c.confirmNewCap);
    fireEvent.click(screen.getByTestId("find-more-confirm"));
    expect(onFind).toHaveBeenCalledWith(30, true);
  });

  it("shows a refusal", () => {
    draw(view(), c.capUsedRefused);
    expect(screen.getByRole("alert").textContent).toBe(c.capUsedRefused);
  });
});
