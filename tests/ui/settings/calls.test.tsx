import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { CallsCard } from "@/components/settings/CallsCard";
import { callsCopy, settingsCopy } from "@/lib/copy/settings";
import { getProfile, resetProfile } from "@/lib/fixtures/repProfile";

/**
 * The Calls card (master doc §23.1f): one toggle, a real switch, and the
 * answer lands in the adapter.
 */

beforeEach(() => {
  resetProfile();
});

const toggle = () => screen.getByRole("switch", { name: callsCopy.toggle });

describe("the Calls card", () => {
  it("renders the one toggle from the fixture, on, with its note", () => {
    render(<CallsCard />);

    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(settingsCopy.calls);
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(callsCopy.note)).toBeDefined();
    // One control, and it is the switch: nothing on the card reads as a plain button.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getAllByRole("switch")).toHaveLength(1);
  });

  it("turns off on a click, says Saved, and the adapter has it", () => {
    render(<CallsCard />);

    fireEvent.click(toggle());

    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("status").textContent).toBe(settingsCopy.saved);
    expect(getProfile().callByDefault).toBe(false);
  });

  it("persists through a remount, because the adapter is the state", () => {
    const first = render(<CallsCard />);
    fireEvent.click(toggle());
    first.unmount();

    render(<CallsCard />);
    expect(toggle().getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle());
    expect(getProfile().callByDefault).toBe(true);
  });

  it("is a button with a focus ring, so the keyboard reaches it", () => {
    render(<CallsCard />);
    expect(toggle().tagName).toBe("BUTTON");
    expect(toggle().className).toContain("focus-visible:ring-2");
  });
});
