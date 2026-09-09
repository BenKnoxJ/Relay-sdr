import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SettingsPage from "@/app/(app)/settings/page";
import { callsCopy, linkedinCopy, mailboxCopy, settingsCopy, voiceCopy } from "@/lib/copy/settings";
import { FIXTURE_PROFILE, resetProfile } from "@/lib/fixtures/repProfile";

/**
 * The whole page (master doc §23.1f): four cards in one column in the signed
 * order, the three new ones rendered from the fixture through the adapter.
 * The mailbox is stubbed as in `tests/ui/settings.test.tsx`; what is checked
 * here is the composition.
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

beforeEach(() => {
  resetProfile();
});

describe("Settings, in full", () => {
  it("renders the four cards from the fixture, in the signed order, in one column", async () => {
    const { container } = render(await SettingsPage({ searchParams: Promise.resolve({}) }));

    expect(
      screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent),
    ).toEqual([settingsCopy.mailbox, settingsCopy.linkedin, settingsCopy.voice, settingsCopy.calls]);

    const column = container.querySelector(".max-w-\\[720px\\]");
    expect(column).not.toBeNull();
    expect(column?.querySelectorAll(":scope > section")).toHaveLength(4);
    expect(screen.queryAllByRole("tab")).toHaveLength(0);

    expect((screen.getByRole("textbox", { name: linkedinCopy.profileLabel }) as HTMLInputElement).value).toBe(
      FIXTURE_PROFILE.linkedinUrl,
    );
    expect(screen.getByText(`${FIXTURE_PROFILE.voiceSamples.length} ${voiceCopy.emails}`)).toBeDefined();
    expect((screen.getByRole("textbox", { name: voiceCopy.noteLabel }) as HTMLTextAreaElement).value).toBe(
      FIXTURE_PROFILE.voiceNote,
    );
    expect(screen.getByRole("switch", { name: callsCopy.toggle }).getAttribute("aria-checked")).toBe("true");
  });

  it("has connect as the only outward button on the page (§23.1f)", async () => {
    render(await SettingsPage({ searchParams: Promise.resolve({}) }));
    const outward = screen.getAllByRole("button").filter((b) => b.closest("form") !== null);
    expect(outward.map((b) => b.textContent)).toEqual([mailboxCopy.connect]);
  });

  it("puts nothing on the page that is not the rep's own: no Zoho, Lusha, theme, password or notifications", async () => {
    const { container } = render(await SettingsPage({ searchParams: Promise.resolve({}) }));
    expect(container.textContent).not.toMatch(/zoho|lusha|theme|password|notification/i);
  });
});
