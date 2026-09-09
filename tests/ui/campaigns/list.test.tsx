import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import CampaignsPage from "@/app/(app)/campaigns/page";
import { campaignsCopy } from "@/lib/copy/campaigns";
import { listCampaigns } from "@/lib/fixtures/campaigns";

vi.mock("next/navigation", () => ({ usePathname: () => "/campaigns" }));

/**
 * The Campaigns list (§23.1c, mock 3a).
 *
 * The order of the rows is asserted rather than their presence: "newest first"
 * is the only sort the signed section allows, and a list that quietly sorted by
 * name would still contain all three.
 */
describe("the Campaigns list", () => {
  it("is one row per campaign, in the adapter's order", () => {
    render(<CampaignsPage />);

    const rows = screen.getAllByTestId("campaign-row");
    expect(rows.map((row) => row.getAttribute("href"))).toEqual(
      listCampaigns().map((campaign) => `/campaigns/${campaign.id}`),
    );
    expect(rows).toHaveLength(3);
  });

  it("carries the name, the one line, the chip, the count and the next line", () => {
    render(<CampaignsPage />);

    const [running, planReady, done] = screen.getAllByTestId("campaign-row");

    expect(running?.textContent).toContain("UK logistics ops");
    expect(running?.textContent).toContain("Direct · call handling · 20 people over 3 weeks · email + LinkedIn");
    expect(running?.textContent).toContain(campaignsCopy.chipRunning);
    expect(running?.textContent).toContain(`6 ${campaignsCopy.of} 20 ${campaignsCopy.contacted}`);
    expect(running?.textContent).toContain(`${campaignsCopy.nextPrefix} 2 ${campaignsCopy.nextRunningDrafts}`);

    expect(planReady?.textContent).toContain(campaignsCopy.chipPlanReady);
    expect(planReady?.textContent).toContain(`0 ${campaignsCopy.of} 15`);
    expect(planReady?.textContent).toContain(`${campaignsCopy.nextPrefix} ${campaignsCopy.nextPlanReady}`);

    // Done stays in the list (§23.1c), and its "next" is its outcome.
    expect(done?.textContent).toContain(campaignsCopy.chipDone);
    expect(done?.textContent).toContain(`30 ${campaignsCopy.of} 30`);
    expect(done?.textContent).toContain(`4 ${campaignsCopy.doneWarm}`);
    expect(done?.textContent).toContain(`2 ${campaignsCopy.doneMeetings}`);
  });

  it("says how many are running and how many are done, and offers one door", () => {
    render(<CampaignsPage />);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(campaignsCopy.title);
    expect(screen.getByText(`2 ${campaignsCopy.noteRunning} · 1 ${campaignsCopy.noteDone}`)).toBeDefined();

    const newCampaign = screen.getByRole("link", { name: campaignsCopy.newCampaign });
    expect(newCampaign.getAttribute("href")).toBe("/campaigns/new");
  });

  it("has no search, no folders and no archive", () => {
    render(<CampaignsPage />);

    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
