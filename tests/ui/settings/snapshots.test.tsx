import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SettingsPage from "@/app/(app)/settings/page";
import { mailboxCopy, voiceCopy } from "@/lib/copy/settings";
import { resetProfile } from "@/lib/fixtures/repProfile";

/**
 * One snapshot per Settings state, in both themes: the page as it lands
 * (mock section 5), and the Your voice list unfolded with the Add box open.
 *
 * Read for what it is, as `tests/ui/shell.test.tsx` says of its own: jsdom
 * applies no stylesheet, so the two themes produce the same markup unless a
 * component branches on the theme itself, which nothing here does. What holds
 * the page to the tokens is the token discipline check in the shell test and
 * the side-by-side screenshots in the pull request; this catches an
 * unintended change to the markup or the copy.
 */

vi.mock("next/navigation", () => ({ usePathname: () => "/settings", redirect: () => undefined }));

vi.mock("@/server/api/caller", () => ({
  serverCaller: async () => ({
    connections: {
      get: async () => ({
        connected: false,
        adminCap: 10,
        none: mailboxCopy.none,
        connect: mailboxCopy.connect,
      }),
    },
  }),
  isRefusal: () => false,
}));

const THEMES = ["light", "dark"] as const;

const page = async () => render(await SettingsPage({ searchParams: Promise.resolve({}) }));

const STATES = {
  "5-settings": async () => {
    await page();
  },
  "5-voice-open": async () => {
    await page();
    fireEvent.click(screen.getByRole("button", { name: `${voiceCopy.show} 4 ${voiceCopy.more}` }));
    fireEvent.click(screen.getByRole("button", { name: voiceCopy.add }));
  },
};

beforeEach(() => {
  resetProfile();
});

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

/** `useId` output depends on render order; see the shell test for why it is masked. */
const stable = (html: string) => html.replace(/_r_[0-9a-z]+_/g, "_id_");

describe.each(THEMES)("Settings in %s", (theme) => {
  for (const [name, show] of Object.entries(STATES)) {
    it(`renders ${name} as signed`, async () => {
      document.documentElement.setAttribute("data-theme", theme);
      await show();
      expect(stable(document.body.innerHTML)).toMatchSnapshot();
    });
  }
});
