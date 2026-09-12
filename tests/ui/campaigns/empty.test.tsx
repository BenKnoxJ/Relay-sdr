import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { emptyCopy } from "@/lib/copy/empty";

vi.mock("next/navigation", () => ({ usePathname: () => "/campaigns" }));

/**
 * Campaigns with nothing behind it (§23.0, §22.7).
 *
 * This is what a rep with no campaigns sees. Mocking the adapter is the point
 * — it is the seam, so a page that stopped reading it would fail here.
 */
vi.mock("@/server/campaigns", () => ({
  listCampaigns: async () => ({ campaigns: [], counts: { running: 0, done: 0 } }),
  getCampaign: async () => null,
}));

describe("Campaigns before the first campaign", () => {
  it("sends the rep back to Home, which is where the box is", async () => {
    const { default: CampaignsPage } = await import("@/app/(app)/campaigns/page");
    render(await CampaignsPage());

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(emptyCopy.campaigns.title);
    expect(screen.getByText(emptyCopy.campaigns.note)).toBeDefined();
    expect(screen.getByText(emptyCopy.campaigns.heading)).toBeDefined();
    expect(screen.getByText(emptyCopy.campaigns.body)).toBeDefined();
  });
});
