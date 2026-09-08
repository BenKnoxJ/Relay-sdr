import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import CampaignsPage from "@/app/(app)/campaigns/page";
import ContentPage from "@/app/(app)/content/page";
import InboxPage from "@/app/(app)/inbox/page";
import SettingsPage from "@/app/(app)/settings/page";
import { contentCopy } from "@/lib/copy/content";
import { emptyCopy } from "@/lib/copy/empty";
import { settingsCopy } from "@/lib/copy/settings";

/**
 * The four areas that have nothing behind them yet. Every one of them is in
 * the nav from day one and opens to a state that says what is coming
 * (master doc §23.0 and §22.7) — so every one of them is checked here, not
 * only Content.
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

describe("Inbox before the first campaign", () => {
  it("says what happens next rather than that it is empty", () => {
    render(<InboxPage />);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(emptyCopy.inbox.title);
    expect(screen.getByText(emptyCopy.inbox.note)).toBeDefined();
    expect(screen.getByText(emptyCopy.inbox.heading)).toBeDefined();
    expect(screen.getByText(emptyCopy.inbox.body)).toBeDefined();
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

describe("Settings before the connect step", () => {
  it("shows the four signed cards, each saying it is coming", () => {
    render(<SettingsPage />);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(settingsCopy.title);

    const headings = screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);

    expect(headings).toEqual([
      settingsCopy.mailbox,
      settingsCopy.linkedin,
      settingsCopy.voice,
      settingsCopy.calls,
    ]);
    expect(screen.getAllByText(settingsCopy.coming)).toHaveLength(4);
  });
});
