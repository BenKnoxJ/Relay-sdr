import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import CampaignsPage from "@/app/(app)/campaigns/page";
import ContentPage from "@/app/(app)/content/page";
import InboxPage from "@/app/(app)/inbox/page";
import { HomeDayOne } from "@/components/HomeDayOne";
import { Nav } from "@/components/Nav";

vi.mock("next/navigation", () => ({ usePathname: () => "/", redirect: () => undefined }));

const THEMES = ["light", "dark"] as const;

const PAGES = {
  home: () => (
    <HomeDayOne
      firstName="Ben"
      today="Mon 7 Sep"
      connections={{ mailbox: false, zoho: false }}
      startBrief={async () => null}
    />
  ),
  content: () => <ContentPage />,
  inbox: () => <InboxPage />,
  campaigns: () => <CampaignsPage />,
  // Settings is not here: as of Task 9e it is a page of live fields with
  // state of its own, and its states are snapshotted in
  // `tests/ui/settings/snapshots.test.tsx`.
  "nav-rep": () => <Nav role="rep" initials="BK" hasCampaign={false} />,
  "nav-admin": () => <Nav role="admin" initials="BK" hasCampaign />,
};

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

/**
 * `useId` counts renders per module, so its output depends on how many
 * components rendered before this one. Left in, a snapshot here would break
 * when an unrelated case was added above it — which is a false alarm, and the
 * fastest way to teach everyone to run `-u` without reading the diff.
 */
const stable = (html: string) => html.replace(/_r_[0-9a-z]+_/g, "_id_");

/**
 * One snapshot per signed state, in both themes.
 *
 * Read for what it is: jsdom applies no stylesheet, so the two themes produce
 * the same markup unless a component branches on the theme itself — which
 * nothing here does, and which is the point. The palette switches under one
 * `data-theme` attribute and nothing else (`src/app/tokens.css`), so a
 * component that ever reached for a theme-conditional render would show up as
 * a diff between the pair rather than being invisible until someone looked at
 * the dark screenshots.
 *
 * What actually holds the pages to the tokens is the guard below and the
 * side-by-side screenshots in the pull request; this catches an unintended
 * change to the markup or the copy.
 */
describe.each(THEMES)("the shell in %s", (theme) => {
  for (const [name, Page] of Object.entries(PAGES)) {
    it(`renders ${name} as signed`, async () => {
      document.documentElement.setAttribute("data-theme", theme);
      const { container } = render(await Page());
      expect(stable(container.innerHTML)).toMatchSnapshot();
    });
  }
});

/**
 * The tokens are the single source for every colour, size and radius
 * (`src/lib/tokens.ts`), and the only thing standing between that and a
 * one-off hex in a component is a check that reads the components.
 *
 * The snapshots above cannot do this job: a hard-coded `#804ee7` renders
 * identically in both themes and snapshots clean, and then the dark theme is
 * quietly wrong. So this reads the source instead.
 */
const COMPONENTS = path.join(import.meta.dirname, "..", "..", "src", "components");
const APP_PAGES = path.join(import.meta.dirname, "..", "..", "src", "app", "(app)");

function sourcesUnder(dir: string): [string, string][] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tsx"))
    .map((entry) => {
      const file = path.join(entry.parentPath, entry.name);
      return [file, readFileSync(file, "utf8")] as [string, string];
    });
}

describe("token discipline", () => {
  const files = [...sourcesUnder(COMPONENTS), ...sourcesUnder(APP_PAGES)];

  it("has components to check", () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
  });

  it("hard-codes no colour", () => {
    const offenders = files
      .filter(([, source]) => /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(source))
      .map(([file]) => file);

    expect(offenders).toEqual([]);
  });

  /**
   * `text-[13px]` compiles and is off the signed nine-size scale; `text-13`
   * does not exist unless the scale carries 13. Same for a radius or a shadow
   * written as an arbitrary value.
   */
  it("writes no arbitrary type, radius or shadow", () => {
    const offenders = files
      .filter(([, source]) => /\b(text|rounded|shadow|font)-\[/.test(source))
      .map(([file]) => file);

    expect(offenders).toEqual([]);
  });

  it("sets no colour through an inline style", () => {
    const offenders = files
      .filter(([, source]) => /style=\{\{[^}]*(color|background|border|shadow)/i.test(source))
      .map(([file]) => file);

    expect(offenders).toEqual([]);
  });
});
