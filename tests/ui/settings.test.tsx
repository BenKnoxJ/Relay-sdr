import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SettingsPage from "@/app/(app)/settings/page";
import { MailboxCard, type MailboxState } from "@/components/MailboxCard";
import { mailboxCopy, settingsCopy } from "@/lib/copy/settings";

/**
 * Settings, with the Mailbox card real (master doc §23.1f, mock section 5).
 *
 * Two states and the four cards. The page is driven through a stubbed caller
 * rather than a database, because what is being checked here is what the
 * signed screen shows for a given answer — `tests/api/connections.test.ts`
 * checks that the answer is right.
 */

const card = vi.fn();

vi.mock("next/navigation", () => ({ usePathname: () => "/settings", redirect: () => undefined }));

vi.mock("@/server/api/caller", () => ({
  serverCaller: async () => ({ connections: { get: async () => card() } }),
  isRefusal: () => false,
}));

const NOT_CONNECTED: MailboxState = {
  connected: false,
  adminCap: 10,
  none: mailboxCopy.none,
  connect: mailboxCopy.connect,
};

const CONNECTED: MailboxState = {
  connected: true,
  address: "ben@example.test",
  status: "healthy",
  healthTone: "ok",
  health: mailboxCopy.healthy,
  healthNote: null,
  cap: 10,
  adminCap: 10,
  capNote: "of 10 set by your admin",
  provider: mailboxCopy.provider,
  window: "09:00 to 16:30",
  days: "Monday, Tuesday, Wednesday, Thursday",
  ramp: "Starts at 5 a day and builds up.",
};

const noop = async () => undefined;
const noLine = async () => null;

beforeEach(() => {
  card.mockReset();
});

async function renderPage(state: MailboxState, params: Record<string, string> = {}) {
  card.mockReturnValue(state);
  return render(await SettingsPage({ searchParams: Promise.resolve(params) }));
}

describe("Settings", () => {
  it("shows the four signed cards in the signed order", async () => {
    await renderPage(NOT_CONNECTED);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(settingsCopy.title);
    expect(
      screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent),
    ).toEqual([settingsCopy.mailbox, settingsCopy.linkedin, settingsCopy.voice, settingsCopy.calls]);
  });

  it("leaves the other three cards saying they are coming", async () => {
    await renderPage(NOT_CONNECTED);

    // Three, not four: Mailbox is real now, and a card that still said this
    // would be the regression worth catching.
    expect(screen.getAllByText(settingsCopy.coming)).toHaveLength(3);
  });

  it("offers Connect when there is no mailbox", async () => {
    await renderPage(NOT_CONNECTED);

    expect(screen.getByText(mailboxCopy.none)).toBeDefined();
    expect(screen.getByRole("button", { name: mailboxCopy.connect })).toBeDefined();
    expect(screen.queryByRole("button", { name: mailboxCopy.disconnect })).toBeNull();
  });

  it("shows the mailbox, its health and Disconnect once it is connected", async () => {
    await renderPage(CONNECTED);

    expect(screen.getByText("ben@example.test")).toBeDefined();
    expect(screen.getByText(mailboxCopy.provider)).toBeDefined();
    expect(screen.getByText(mailboxCopy.healthy)).toBeDefined();
    expect(screen.getByRole("button", { name: mailboxCopy.disconnect })).toBeDefined();
    expect(screen.queryByRole("button", { name: mailboxCopy.connect })).toBeNull();
  });

  it("says a connect worked, and says why one did not", async () => {
    await renderPage(CONNECTED, { connected: "mailbox" });
    expect(screen.getByText(mailboxCopy.connected)).toBeDefined();

    await renderPage(NOT_CONNECTED, { connect: "link" });
    expect(screen.getByText(mailboxCopy.failedLink)).toBeDefined();
  });

  it("says nothing at all for a query string nobody wrote", async () => {
    await renderPage(NOT_CONNECTED, { connect: "invented" });

    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("the Mailbox card", () => {
  it("shows the cap, the ceiling, the window, the days and the ramp", () => {
    render(
      <MailboxCard
        state={CONNECTED}
        banner={null}
        connect={noop}
        disconnect={noop}
        saveCap={noLine}
      />,
    );

    expect(screen.getByRole("spinbutton", { name: mailboxCopy.capLabel })).toHaveProperty(
      "value",
      "10",
    );
    expect(screen.getByText("of 10 set by your admin")).toBeDefined();
    expect(screen.getByText("09:00 to 16:30")).toBeDefined();
    expect(screen.getByText("Monday, Tuesday, Wednesday, Thursday")).toBeDefined();
    expect(screen.getByText("Starts at 5 a day and builds up.")).toBeDefined();
  });

  it("cannot be used to raise the cap past the ceiling", () => {
    render(
      <MailboxCard
        state={{ ...CONNECTED, cap: 4, adminCap: 10 }}
        banner={null}
        connect={noop}
        disconnect={noop}
        saveCap={noLine}
      />,
    );

    const field = screen.getByRole("spinbutton", { name: mailboxCopy.capLabel });
    expect(field.getAttribute("max")).toBe("10");
    expect(field.getAttribute("min")).toBe("1");
  });

  it("says what is wrong, and how to fix it, when the mailbox needs re-linking", () => {
    render(
      <MailboxCard
        state={{
          ...CONNECTED,
          status: "expiring",
          health: mailboxCopy.needsRelink,
          healthTone: "warn",
          healthNote: mailboxCopy.needsRelinkWhy,
        }}
        banner={null}
        connect={noop}
        disconnect={noop}
        saveCap={noLine}
      />,
    );

    expect(screen.getByText(mailboxCopy.needsRelink)).toBeDefined();
    expect(screen.getByText(mailboxCopy.needsRelinkWhy)).toBeDefined();
  });

  it("gives an expiring mailbox a way back that is not Disconnect", () => {
    const { container } = render(
      <MailboxCard
        state={{
          ...CONNECTED,
          status: "expiring",
          health: mailboxCopy.needsRelink,
          healthTone: "warn",
          healthNote: mailboxCopy.needsRelinkWhy,
        }}
        banner={null}
        connect={noop}
        disconnect={noop}
        saveCap={noLine}
      />,
    );

    // Disconnect destroys the stored tokens, so it must not be the only route
    // out of an expiry the rep did not cause.
    expect(screen.getByRole("button", { name: mailboxCopy.connectAgain })).toBeDefined();
    // And it is still one accent on one control (§21).
    expect(container.querySelectorAll(".bg-action")).toHaveLength(1);
  });

  it("says plainly what Disconnect does and does not do", () => {
    render(
      <MailboxCard
        state={CONNECTED}
        banner={null}
        connect={noop}
        disconnect={noop}
        saveCap={noLine}
      />,
    );

    expect(screen.getByText(mailboxCopy.disconnectNote)).toBeDefined();
  });

  it("puts exactly one primary button on the card, and only when connecting", () => {
    const { container, rerender } = render(
      <MailboxCard
        state={NOT_CONNECTED}
        banner={null}
        connect={noop}
        disconnect={noop}
        saveCap={noLine}
      />,
    );
    // §21: one accent, on one control per card. `bg-action` is the filled
    // violet, and it is the primary variant's own class.
    expect(container.querySelectorAll(".bg-action")).toHaveLength(1);

    rerender(
      <MailboxCard
        state={CONNECTED}
        banner={null}
        connect={noop}
        disconnect={noop}
        saveCap={noLine}
      />,
    );
    expect(container.querySelectorAll(".bg-action")).toHaveLength(0);
  });
});
