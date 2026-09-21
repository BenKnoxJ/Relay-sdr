import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CampaignPage } from "@/components/campaigns/CampaignPage";
import { outreachPeopleCopy as c } from "@/lib/copy/outreachPeople";
import { getCampaign, type Campaign } from "@/lib/fixtures/campaigns";

/**
 * The campaign page's Overview and People tabs (Relay P5): only on a
 * campaign the page gives a People view (one that has started outreach); the
 * People tab replaces the page's work area and rail with the list.
 */

vi.mock("next/navigation", () => ({ usePathname: () => "/campaigns", useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));

const campaign = (): Campaign => getCampaign("midlands-fleet-operators")!;

describe("the campaign tabs", () => {
  it("are absent until the page gives a People view", () => {
    render(<CampaignPage campaign={campaign()} />);
    expect(screen.queryByTestId("campaign-tabs")).toBeNull();
  });

  it("on Overview: the work area and rail, with People as a link to ?tab=people", () => {
    render(<CampaignPage campaign={campaign()} people={{ active: false, content: null }} />);
    const nav = screen.getByRole("navigation", { name: c.tabsLabel });
    expect(nav).toBeTruthy();
    expect(screen.getByRole("link", { name: c.tabOverview }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: c.tabPeople }).getAttribute("href")).toBe(`/campaigns/${campaign().id}?tab=people`);
    expect(screen.getByTestId("support-rail")).toBeTruthy();
  });

  it("on People: the list in place of the work area and rail", () => {
    render(<CampaignPage campaign={campaign()} people={{ active: true, content: <p data-testid="the-list">list</p> }} />);
    expect(screen.getByRole("link", { name: c.tabPeople }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("the-list")).toBeTruthy();
    expect(screen.queryByTestId("support-rail")).toBeNull();
  });
});
