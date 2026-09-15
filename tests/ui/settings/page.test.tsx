import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SettingsPage from "@/app/(app)/settings/page";
import { linkedinCopy, mailboxCopy, settingsCopy, voiceCopy } from "@/lib/copy/settings";
import { resetProfile } from "@/lib/fixtures/repProfile";

/**
 * The whole page (master doc §23.1f): three cards in one column in the signed
 * order, LinkedIn and Your voice rendered from the empty fixture through the
 * adapter. The Calls card is not on the page: Start reads nothing from it
 * yet. The mailbox is stubbed as in `tests/ui/settings.test.tsx`; what is
 * checked here is the composition, and that nothing on it is invented.
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
  it("renders three cards, in the signed order, in one column, with nothing filled in", async () => {
    const { container } = render(await SettingsPage({ searchParams: Promise.resolve({}) }));

    expect(
      screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent),
    ).toEqual([settingsCopy.mailbox, settingsCopy.linkedin, settingsCopy.voice]);
    expect(screen.queryByText(settingsCopy.calls)).toBeNull();
    expect(screen.queryAllByRole("switch")).toHaveLength(0);

    const column = container.querySelector(".max-w-\\[720px\\]");
    expect(column).not.toBeNull();
    expect(column?.querySelectorAll(":scope > section")).toHaveLength(3);
    expect(screen.queryAllByRole("tab")).toHaveLength(0);

    // Empty, with the shape of a link as the placeholder and nobody's link as the value.
    const link = screen.getByRole("textbox", { name: linkedinCopy.profileLabel }) as HTMLInputElement;
    expect(link.value).toBe("");
    expect(link.placeholder).toBe(linkedinCopy.placeholder);
    // No emails, no count of emails, and the note empty with its placeholder.
    expect(screen.getByText(voiceCopy.none)).toBeDefined();
    expect(screen.queryByText(new RegExp(`^\\d+ ${voiceCopy.emails}$`))).toBeNull();
    expect(screen.queryAllByTestId("voice-sample")).toHaveLength(0);
    const note = screen.getByRole("textbox", { name: voiceCopy.noteLabel }) as HTMLTextAreaElement;
    expect(note.value).toBe("");
    expect(note.placeholder).toBe(voiceCopy.notePlaceholder);
    // No first name and no invented company anywhere on the page.
    expect(container.textContent).not.toMatch(/\bBen\b|linkedin\.com\/in\/[a-z]/i);
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
