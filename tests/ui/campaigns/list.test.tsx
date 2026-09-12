import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import CampaignsPage from "@/app/(app)/campaigns/page";
import { CampaignRow } from "@/components/campaigns/CampaignRow";
import { toSummary } from "@/lib/campaigns/view";
import { campaignsCopy } from "@/lib/copy/campaigns";
import { listCampaigns } from "@/lib/fixtures/campaigns";

import { liveCampaign } from "./live";

vi.mock("next/navigation", () => ({ usePathname: () => "/campaigns" }));

/**
 * The page reads the rep's campaigns through `src/server/campaigns.ts`; here
 * that seam hands it the signed list's three sample rows, which is what mock
 * 3a draws. What a real row carries is checked on its own below.
 */
vi.mock("@/server/campaigns", async () => {
  const samples = await import("@/lib/fixtures/campaigns");
  return {
    listCampaigns: async () => ({ campaigns: samples.listCampaigns(), counts: samples.listCounts() }),
    getCampaign: async () => null,
  };
});

/**
 * The Campaigns list (§23.1c, mock 3a).
 *
 * The order of the rows is asserted rather than their presence: "newest first"
 * is the only sort the signed section allows, and a list that quietly sorted by
 * name would still contain all three.
 */
describe("the Campaigns list", () => {
  it("is one row per campaign, in the adapter's order", async () => {
    render(await CampaignsPage());

    const rows = screen.getAllByTestId("campaign-row");
    expect(rows.map((row) => row.getAttribute("href"))).toEqual(
      listCampaigns().map((campaign) => `/campaigns/${campaign.id}`),
    );
    expect(rows).toHaveLength(3);
  });

  it("carries the name, the one line, the chip, the count and the next line", async () => {
    render(await CampaignsPage());

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

  it("says how many are running and how many are done, and leaves New campaign to the nav", async () => {
    render(await CampaignsPage());

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(campaignsCopy.title);
    expect(screen.getByText(`2 ${campaignsCopy.noteRunning} · 1 ${campaignsCopy.noteDone}`)).toBeDefined();

    // A rep with a campaign has "New campaign" in the nav pill (`tests/ui/nav.test.tsx`);
    // a second one on the page would be the same door twice.
    expect(screen.queryByRole("link", { name: campaignsCopy.newCampaign })).toBeNull();
  });

  it("has no search, no folders and no archive", async () => {
    render(await CampaignsPage());

    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});

describe("a real campaign's row", () => {
  it("says nothing has been sent rather than drawing 0 of 10", () => {
    render(<CampaignRow campaign={toSummary(liveCampaign("researching"))} />);

    const row = screen.getByTestId("campaign-row");
    expect(row.textContent).toContain(campaignsCopy.nothingSentYet);
    expect(row.textContent).not.toContain(`0 ${campaignsCopy.of}`);
    expect(row.textContent).toContain(`${campaignsCopy.nextPrefix} ${campaignsCopy.nextResearching}`);
  });

  it("is in the warn tone and asks for the rep when research failed", () => {
    render(<CampaignRow campaign={toSummary(liveCampaign("failed"))} />);

    const row = screen.getByTestId("campaign-row");
    expect(row.textContent).toContain(campaignsCopy.chipNeedsYou);
    expect(screen.getByTestId("campaign-next").textContent).toBe(`${campaignsCopy.nextPrefix} ${campaignsCopy.nextFailed}`);
  });
});
