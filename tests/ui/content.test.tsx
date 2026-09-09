import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import CampaignsPage from "@/app/(app)/campaigns/page";
import ContentPage from "@/app/(app)/content/page";
import { contentCopy } from "@/lib/copy/content";
import { emptyCopy } from "@/lib/copy/empty";

/**
 * The areas that have nothing behind them yet. Every one of them is in the
 * nav from day one and opens to a state that says what is coming (master doc
 * §23.0 and §22.7) — so every one of them is checked here, not only Content.
 * Settings left this file when Task 10b made its first card real; Inbox left
 * it when Task 9d gave it a queue. They are covered in `settings.test.tsx`
 * and `inbox/*.test.tsx`.
 */
describe("Content before its slice", () => {
  it("says what it will do and when", () => {
    render(<ContentPage />);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(contentCopy.title);
    expect(screen.getByText(contentCopy.note)).toBeDefined();
    expect(screen.getByText(contentCopy.heading)).toBeDefined();
    expect(screen.getByText(contentCopy.body)).toBeDefined();
  });

  it("has nothing to click", () => {
    render(<ContentPage />);

    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });
});

describe("Campaigns before the first campaign", () => {
  it("sends the rep back to Home, which is where the box is", () => {
    render(<CampaignsPage />);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(emptyCopy.campaigns.title);
    expect(screen.getByText(emptyCopy.campaigns.heading)).toBeDefined();
    expect(screen.getByText(emptyCopy.campaigns.body)).toBeDefined();
  });
});
