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

describe("Nav", () => {
  it("shows the five areas in the signed order", () => {
    render(<Nav role="rep" initials="BK" hasCampaign={false} />);

    const labels = screen
      .getAllByRole("link")
      .map((link) => within(link).getByTestId("nav-label").textContent);

    expect(labels).toEqual(AREAS);
  });

  it("hides Admin from a rep", () => {
    render(<Nav role="rep" initials="BK" hasCampaign={false} />);

    expect(screen.queryByText(navCopy.admin)).toBeNull();
  });

  it("shows Admin to an admin", () => {
    render(<Nav role="admin" initials="BK" hasCampaign={false} />);

    expect(screen.getByText(navCopy.admin)).toBeDefined();
  });

  /**
   * The admin item is not a sixth link and must not become one by accident:
   * §23.0 lands Admin in slice 3, and the signed mock draws it as a quiet
   * dashed pill. A link here would take a rep's manager to a 404.
   */
  it("does not make Admin a link", () => {
    render(<Nav role="admin" initials="BK" hasCampaign={false} />);

    expect(screen.getAllByRole("link")).toHaveLength(AREAS.length);
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

    rerender(<Nav role="rep" initials="BK" hasCampaign={false} counts={{ inbox: 5 }} />);
    expect(screen.getByTestId("nav-count").textContent).toBe("5");
  });

  it("carries the rep's initials", () => {
    render(<Nav role="rep" initials="BK" hasCampaign={false} />);

    expect(screen.getByLabelText(navCopy.account).textContent).toBe("BK");
  });
});
