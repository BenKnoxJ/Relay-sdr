import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import CampaignsPage from "@/app/(app)/campaigns/page";
import { CampaignPage } from "@/components/campaigns/CampaignPage";
import { StartForm } from "@/components/campaigns/StartForm";
import {
  HOW_LONG,
  HOW_MANY,
  PRODUCTS,
  REGIONS,
  getCampaign,
  startFromSentence,
  type Campaign,
} from "@/lib/fixtures/campaigns";

vi.mock("next/navigation", () => ({
  usePathname: () => "/campaigns",
  useRouter: () => ({ push: () => undefined }),
}));

/**
 * One snapshot per signed state, in both themes (the guard 9b set up in
 * `tests/ui/shell.test.tsx`, extended to the four states of the campaign page).
 *
 * jsdom applies no stylesheet, so the two themes produce the same markup unless
 * a component branches on the theme itself, which is exactly what this is here
 * to catch. What holds these pages to the tokens is the side-by-side
 * screenshots in the pull request; this catches an unintended change to the
 * markup or the copy.
 */
const stable = (html: string) => html.replace(/_r_[0-9a-z]+_/g, "_id_");

function campaign(id: string): Campaign {
  const found = getCampaign(id);
  if (found === null) throw new Error(`no fixture campaign ${id}`);
  return found;
}

const THEMES = ["light", "dark"] as const;

const PAGES = {
  list: () => <CampaignsPage />,
  start: () => (
    <StartForm
      sentence=""
      prefilled={startFromSentence("")}
      products={PRODUCTS}
      regions={REGIONS}
      howMany={HOW_MANY}
      howLong={HOW_LONG}
      mailboxConnected
    />
  ),
  "page-researching": () => <CampaignPage campaign={campaign("midlands-fleet-operators")} />,
  "page-plan-ready": () => <CampaignPage campaign={campaign("managed-print-partners-midlands")} />,
  "page-running": () => <CampaignPage campaign={campaign("uk-logistics-ops")} />,
  "page-stopped": () => <CampaignPage campaign={campaign("vets-scotland")} />,
};

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

describe.each(THEMES)("Campaigns in %s", (theme) => {
  for (const [name, Page] of Object.entries(PAGES)) {
    it(`renders ${name} as signed`, () => {
      document.documentElement.setAttribute("data-theme", theme);
      const { container } = render(<Page />);
      expect(stable(container.innerHTML)).toMatchSnapshot();
    });
  }
});
