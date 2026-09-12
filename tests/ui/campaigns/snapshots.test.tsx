import { render } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import CampaignsPage from "@/app/(app)/campaigns/page";
import { CampaignPage } from "@/components/campaigns/CampaignPage";
import { StartForm } from "@/components/campaigns/StartForm";
import { HOW_LONG, HOW_MANY, PRODUCTS, REGIONS, startFromSentence } from "@/lib/campaigns/start";
import { getCampaign, type Campaign } from "@/lib/fixtures/campaigns";

import { liveCampaign, type LiveKind } from "./live";

vi.mock("next/navigation", () => ({
  usePathname: () => "/campaigns",
  useRouter: () => ({ push: () => undefined }),
}));

vi.mock("@/server/campaigns", async () => {
  const samples = await import("@/lib/fixtures/campaigns");
  return {
    listCampaigns: async () => ({ campaigns: samples.listCampaigns(), counts: samples.listCounts() }),
    getCampaign: async () => null,
  };
});

/**
 * One snapshot per state, in both themes (the guard 9b set up in
 * `tests/ui/shell.test.tsx`).
 *
 * The sample states are the signed mock's (3a to 3d); the live states are what
 * a real campaign draws, built the way the router builds them over contract
 * data. jsdom applies no stylesheet, so the two themes produce the same markup
 * unless a component branches on the theme itself, which is what this is here
 * to catch. The clock is fixed because the complete pack's dates are relative
 * to today.
 */
const stable = (html: string) => html.replace(/_r_[0-9a-z]+_/g, "_id_");

function campaign(id: string): Campaign {
  const found = getCampaign(id);
  if (found === null) throw new Error(`no sample campaign ${id}`);
  return found;
}

const THEMES = ["light", "dark"] as const;
const LIVE: LiveKind[] = ["researching", "complete", "partial", "stopped", "failed"];

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-12T12:00:00Z"));
});

afterAll(() => {
  vi.useRealTimers();
});

const PAGES: Record<string, () => Promise<React.ReactElement> | React.ReactElement> = {
  list: () => CampaignsPage(),
  start: () => (
    <StartForm
      sentence=""
      prefilled={startFromSentence("")}
      products={PRODUCTS}
      regions={REGIONS}
      howMany={HOW_MANY}
      howLong={HOW_LONG}
      mailboxConnected
      onStart={async () => ({ id: "camp" })}
    />
  ),
  "page-researching": () => <CampaignPage campaign={campaign("midlands-fleet-operators")} />,
  "page-plan-ready": () => <CampaignPage campaign={campaign("managed-print-partners-midlands")} />,
  "page-running": () => <CampaignPage campaign={campaign("uk-logistics-ops")} />,
  "page-stopped": () => <CampaignPage campaign={campaign("vets-scotland")} />,
  ...Object.fromEntries(LIVE.map((kind) => [`live-${kind}`, () => <CampaignPage campaign={liveCampaign(kind)} />])),
};

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

describe.each(THEMES)("Campaigns in %s", (theme) => {
  for (const [name, Page] of Object.entries(PAGES)) {
    // The sample states keep the title they were signed under, so a change to
    // one shows as a diff against the signed markup rather than a new snapshot.
    it(name.startsWith("live-") ? `renders ${name}` : `renders ${name} as signed`, async () => {
      document.documentElement.setAttribute("data-theme", theme);
      const { container } = render(await Page());
      expect(stable(container.innerHTML)).toMatchSnapshot();
    });
  }
});
