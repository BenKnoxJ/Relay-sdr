import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import CampaignsPage from "@/app/(app)/campaigns/page";
import { CampaignRow } from "@/components/campaigns/CampaignRow";
import { reasonLineOf, stageLineOf } from "@/lib/campaigns/stageLine";
import { toSummary } from "@/lib/campaigns/view";
import { campaignsCopy } from "@/lib/copy/campaigns";
import { listCampaigns } from "@/lib/fixtures/campaigns";

import { liveCampaign } from "./live";

vi.mock("next/navigation", () => ({ usePathname: () => "/campaigns" }));

/**
 * The page reads the rep's campaigns through `src/server/campaigns.ts`; here
 * that seam hands it the signed list's three sample rows (mock 3a) plus one
 * real campaign whose research failed, so the list has something that needs
 * the rep. What a real row carries is checked on its own below.
 */
vi.mock("@/server/campaigns", async () => {
  const samples = await import("@/lib/fixtures/campaigns");
  const view = await import("@/lib/campaigns/view");
  const { liveCampaign: live } = await import("./live");
  const campaigns = [...samples.listCampaigns(), view.toSummary(live("failed"))];
  return {
    listCampaigns: async () => ({ campaigns, counts: view.listCounts(campaigns) }),
    getCampaign: async () => null,
  };
});

const FAILED_ID = `/campaigns/${liveCampaign("failed").id}`;

/**
 * The Campaigns list (§23.1c, mock 3a; product-truth pass).
 *
 * The order of the rows is asserted rather than their presence: what needs
 * the rep first, then what is in progress, then done, and a list that quietly
 * sorted by name would still contain all four.
 */
describe("the Campaigns list", () => {
  it("is one row per campaign, what needs the rep first", async () => {
    render(await CampaignsPage());

    const rows = screen.getAllByTestId("campaign-row");
    expect(rows).toHaveLength(4);
    expect(rows[0]?.getAttribute("href")).toBe(FAILED_ID);
    // The samples follow, sorted: the decision, then what Relay is doing, then done.
    const samples = listCampaigns();
    const byState = (state: string) => `/campaigns/${samples.find((campaign) => campaign.state === state)?.id}`;
    expect(rows.slice(1).map((row) => row.getAttribute("href"))).toEqual([byState("planReady"), byState("running"), byState("done")]);
  });

  it("groups the rows in Home's own five words, and draws no empty group", async () => {
    render(await CampaignsPage());

    expect(screen.getAllByTestId("campaign-group").map((group) => group.textContent)).toEqual([
      campaignsCopy.groupNeedsYou,
      campaignsCopy.groupDecide,
      campaignsCopy.groupWorking,
      campaignsCopy.groupDone,
    ]);
    expect(screen.queryByText(campaignsCopy.groupReady)).toBeNull();
    // Nothing has been spent, so the header carries no spend line rather than a row of zeros.
    expect(screen.queryByTestId("campaigns-spend")).toBeNull();
  });

  it("carries the name, the one line, the chip and the next line", async () => {
    render(await CampaignsPage());

    const [, planReady, running, done] = screen.getAllByTestId("campaign-row");

    expect(running?.textContent).toContain("UK logistics ops");
    // A sample has no stage summary of its own, so its line is the brief's.
    expect(running?.textContent).toContain("Direct · call handling · 20 people over 3 weeks · email + LinkedIn");
    expect(running?.textContent).toContain(campaignsCopy.chipRunning);
    expect(running?.textContent).toContain(`6 ${campaignsCopy.of} 20 ${campaignsCopy.contacted}`);
    expect(running?.textContent).toContain(`${campaignsCopy.nextPrefix} 2 ${campaignsCopy.nextRunningDrafts}`);

    expect(planReady?.textContent).toContain(campaignsCopy.chipPlanReady);
    // Nobody has been contacted, so no "0 of 15": a fraction reads as progress.
    expect(planReady?.textContent).not.toContain(`0 ${campaignsCopy.of}`);
    expect(planReady?.textContent).toContain(`${campaignsCopy.nextPrefix} ${campaignsCopy.nextPlanReady}`);

    // Done stays in the list (§23.1c), and its "next" is its outcome.
    expect(done?.textContent).toContain(campaignsCopy.chipDone);
    expect(done?.textContent).toContain(`30 ${campaignsCopy.of} 30`);
    expect(done?.textContent).toContain(`4 ${campaignsCopy.doneWarm}`);
    expect(done?.textContent).toContain(`2 ${campaignsCopy.doneMeetings}`);
  });

  it("counts by what each campaign needs, never as running, and leaves New campaign to the nav", async () => {
    render(await CampaignsPage());

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(campaignsCopy.title);
    expect(
      screen.getByText(
        [
          `1 ${campaignsCopy.bucketNeedsYou}`,
          `1 ${campaignsCopy.bucketDecide}`,
          `1 ${campaignsCopy.bucketWorking}`,
          `1 ${campaignsCopy.bucketDone}`,
        ].join(campaignsCopy.noteJoin),
      ),
    ).toBeDefined();
    expect(screen.queryByText(new RegExp(`\\d ${campaignsCopy.noteRunning}`))).toBeNull();

    // A rep with a campaign has "New campaign" in the nav pill (`tests/ui/nav.test.tsx`);
    // a second one on the page would be the same door twice.
    expect(screen.queryByRole("link", { name: campaignsCopy.newCampaign })).toBeNull();
  });

  it("no longer says nothing has been sent: a row says what is happening, not what is not", async () => {
    const { container } = render(await CampaignsPage());

    expect(container.textContent).not.toContain(campaignsCopy.nothingSentYet);
  });

  it("has no search, no folders and no archive", async () => {
    render(await CampaignsPage());

    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});

describe("a real campaign's row", () => {
  it("says what Relay is doing, and draws no count while nobody has been contacted", () => {
    const campaign = toSummary(liveCampaign("researching"));
    render(<CampaignRow campaign={campaign} />);

    const row = screen.getByTestId("campaign-row");
    expect(row.textContent).toContain(stageLineOf(campaign.facts!));
    expect(row.textContent).not.toContain(campaignsCopy.nothingSentYet);
    expect(row.textContent).not.toContain(`0 ${campaignsCopy.of}`);
    expect(row.textContent).toContain(`${campaignsCopy.nextPrefix} ${campaignsCopy.nextResearching}`);
  });

  it("is in the warn tone, says why, and asks for the rep when research failed", () => {
    const campaign = toSummary(liveCampaign("failed"));
    render(<CampaignRow campaign={campaign} />);

    const row = screen.getByTestId("campaign-row");
    expect(reasonLineOf(campaign.facts!)).not.toBeNull();
    expect(row.textContent).toContain(reasonLineOf(campaign.facts!));
    expect(row.textContent).toContain(campaignsCopy.chipNeedsYou);
    expect(row.querySelector(".text-warn")).not.toBeNull();
    expect(screen.getByTestId("campaign-next").textContent).toBe(`${campaignsCopy.nextPrefix} ${campaignsCopy.nextFailed}`);
  });
});
