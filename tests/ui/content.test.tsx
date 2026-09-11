import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import ContentPage from "@/app/(app)/content/page";
import { contentCopy } from "@/lib/copy/content";
import { emptyCopy } from "@/lib/copy/empty";

/**
 * The areas that have nothing behind them yet. Every one of them is in the
 * nav from day one and opens to a state that says what is coming (master doc
 * §23.0 and §22.7) — so every one of them is checked here, not only Content.
 * Settings left this file when Task 10b made its first card real (covered in
 * `settings.test.tsx`); Campaigns left it in Task 9c for `campaigns/empty.test.tsx`;
 * Inbox left it when Task 9d gave it a queue (`inbox/*.test.tsx`).
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

/*
 * Campaigns moved to `tests/ui/campaigns/`. Its empty state is still asserted,
 * in `empty.test.tsx`: the page grew a list in Task 9c, so reaching the empty
 * branch now needs the adapter handed back empty, and that mock cannot live in
 * a file that also renders the page above. Inbox moved to `tests/ui/inbox/`
 * in Task 9d for the same reason.
 */
