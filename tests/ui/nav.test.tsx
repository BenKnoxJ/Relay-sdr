import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Nav } from "@/components/Nav";
import { navCopy } from "@/lib/copy/nav";

/**
 * `Nav` reads the current path so it can mark one item, and `usePathname`
 * throws outside a Next render. The path is the only thing stubbed; the role,
 * the order and the "New campaign" rule are all the component's own.
 */
vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

/** The signed order (master doc §23.0). Admin is not one of them. */
const AREAS = [
  navCopy.home,
  navCopy.inbox,
  navCopy.campaigns,
  navCopy.content,
  navCopy.settings,
];

/** What a rep sees until the example surfaces are switched on: the same order, two fewer. */
const LIVE_AREAS = [navCopy.home,
  navCopy.inbox, navCopy.campaigns, navCopy.settings];

const labels = () =>
  screen.getAllByRole("link").map((link) => within(link).getByTestId("nav-label").textContent);

describe("Nav", () => {
  it("shows all five areas in the signed order when the example surfaces are on", () => {
    render(<Nav role="rep" initials="BK" hasCampaign={false} showDemo />);

    expect(labels()).toEqual(AREAS);
  });

  /**
   * Inbox and Content are fixtures until their rows exist. A pilot rep must
   * not find a queue of invented replies one click from Home, so the nav
   * carries three areas unless the environment says otherwise. The routes
   * still answer by URL; only the links are gone.
   */
  it("shows the live areas, Inbox included, when the example surfaces are off, which is the default", () => {
    const { unmount } = render(<Nav role="rep" initials="BK" hasCampaign={false} />);
    expect(labels()).toEqual(LIVE_AREAS);
    unmount();

    render(<Nav role="rep" initials="BK" hasCampaign={false} showDemo={false} />);
    expect(labels()).toEqual(LIVE_AREAS);
  });

  /**
   * There is no Admin pill for anyone. The Admin area lands in slice 3, and
   * a dashed "you only" label with nothing behind it was a promise on the
   * screen; it comes back as a link when there is somewhere to go.
   */
  it("carries no Admin item for a rep or an admin", () => {
    const { unmount } = render(<Nav role="rep" initials="BK" hasCampaign={false} />);
    expect(screen.queryByText(/admin/i)).toBeNull();
    unmount();

    render(<Nav role="admin" initials="BK" hasCampaign={false} />);
    expect(screen.queryByText(/admin/i)).toBeNull();
    expect("admin" in navCopy).toBe(false);
  });

  it("puts nothing in the nav that is not a link, the wordmark or the avatar", () => {
    const { container } = render(<Nav role="admin" initials="BK" hasCampaign />);

    // Every area is a link, "New campaign" is a link, and the only other
    // text on the pill is the wordmark and the two initials.
    const text = container.textContent ?? "";
    const linkText = screen.getAllByRole("link").map((link) => link.textContent ?? "");
    expect(text).toBe(`Relay${linkText.join("")}BK`);
    expect(screen.getAllByRole("link")).toHaveLength(LIVE_AREAS.length + 1);
  });

  /**
   * Phone: two rows and never three. The area links live in one scrolling
   * row of their own, so a long list runs sideways rather than wrapping.
   */
  it("keeps the areas in one row of their own that scrolls rather than wraps", () => {
    render(<Nav role="rep" initials="BK" hasCampaign showDemo />);

    const row = screen.getByTestId("nav-areas");
    expect(row.className).toContain("overflow-x-auto");
    expect(row.className).toContain("w-full");
    expect(row.className).not.toContain("flex-wrap");
    for (const link of within(row).getAllByRole("link")) {
      expect(link.className).toContain("whitespace-nowrap");
    }
    // "New campaign" is outside the row, so it stays on the first line.
    expect(row.contains(screen.getByText(navCopy.newCampaign))).toBe(false);
  });

  it("leaves New campaign out of the nav until a campaign exists", () => {
    render(<Nav role="admin" initials="BK" hasCampaign={false} />);

    expect(screen.queryByText(navCopy.newCampaign)).toBeNull();
  });

  it("shows New campaign once one exists", () => {
    render(<Nav role="rep" initials="BK" hasCampaign />);

    expect(screen.getByText(navCopy.newCampaign)).toBeDefined();
  });

  it("marks the area the rep is in, and only that one", () => {
    render(<Nav role="rep" initials="BK" hasCampaign={false} />);

    const current = screen.getAllByRole("link").filter((link) => link.getAttribute("aria-current") === "page");

    expect(current).toHaveLength(1);
    expect(within(current[0] as HTMLElement).getByTestId("nav-label").textContent).toBe(navCopy.home);
  });

  /** A count is a count, and there are none on day one. */
  it("shows a count beside an area only when it has one", () => {
    const { rerender } = render(<Nav role="rep" initials="BK" hasCampaign={false} />);
    expect(screen.queryByTestId("nav-count")).toBeNull();

    rerender(<Nav role="rep" initials="BK" hasCampaign={false} counts={{ inbox: 5 }} showDemo />);
    expect(screen.getByTestId("nav-count").textContent).toBe("5");
  });

  it("carries the rep's initials", () => {
    render(<Nav role="rep" initials="BK" hasCampaign={false} />);

    expect(screen.getByLabelText(navCopy.account).textContent).toBe("BK");
  });

  /**
   * The area the rep is NOT in is `text-muted`, which under the cursor has to
   * say it is a link. `text-ink` is the colour the current area already
   * carries, so hovering previews the destination rather than inventing a
   * fourth text colour.
   */
  it("lifts an unvisited area to ink under the cursor, in the micro band", () => {
    render(<Nav role="rep" initials="BK" hasCampaign={false} />);

    for (const link of screen.getAllByRole("link")) {
      expect(link.className).toContain("hover:text-ink");
      expect(link.className).toContain("duration-micro");
      expect(link.className).toContain("ease-standard");
    }
  });
});
