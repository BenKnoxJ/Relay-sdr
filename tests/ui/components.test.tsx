import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { PillButton } from "@/components/PillButton";

/**
 * The Phase 1 component set, checked for the things a snapshot cannot see: the
 * classes each one resolves to are token classes, and the parts that are
 * conditional are actually conditional.
 *
 * These do not assert colours. Nothing here renders a colour — a class name
 * resolves through `tailwind.config.ts` to a custom property, and the values
 * are already held to the signed file by `tests/ui/tokens.test.ts`. What is
 * worth asserting is that the components reach for those classes rather than
 * for a one-off.
 */

describe("Card", () => {
  it("carries the signed card shape: radius, hairline, panel, padding, shadow", () => {
    const { container } = render(<Card>body</Card>);
    const card = container.firstElementChild as HTMLElement;

    for (const token of ["rounded-card", "border-line", "bg-panel", "p-card", "shadow-card"]) {
      expect(card.className, token).toContain(token);
    }
  });

  it("renders a label as the card's heading, and nothing when there is none", () => {
    const { rerender } = render(<Card label="Where to go">body</Card>);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Where to go");

    rerender(<Card>body</Card>);
    expect(screen.queryByRole("heading")).toBeNull();
  });

  /**
   * A caller's class must win, or every page that needs a flush card fights
   * the component. `cn` is what makes that true, and it only works because
   * `src/lib/utils.ts` declares the token scales to tailwind-merge.
   */
  it("lets a caller override a token class rather than stacking with it", () => {
    const { container } = render(<Card className="p-0">body</Card>);
    const card = container.firstElementChild as HTMLElement;

    expect(card.className).toContain("p-0");
    expect(card.className).not.toContain("p-card");
  });
});

describe("Chip", () => {
  it("has three tones and no more, each on its own token pair", () => {
    const tones = {
      default: ["bg-ground", "text-muted"],
      ok: ["bg-soft", "text-action"],
      warn: ["bg-warn-bg", "text-warn"],
    } as const;

    for (const [tone, classes] of Object.entries(tones)) {
      const { container, unmount } = render(
        <Chip tone={tone as keyof typeof tones}>Sending</Chip>,
      );
      const chip = container.firstElementChild as HTMLElement;
      for (const token of classes) expect(chip.className, `${tone} ${token}`).toContain(token);
      expect(chip.className, tone).toContain("rounded-pill");
      unmount();
    }
  });

  it("is the quiet outline unless told otherwise", () => {
    const { container } = render(<Chip>Plan ready</Chip>);
    expect((container.firstElementChild as HTMLElement).className).toContain("bg-ground");
  });
});

describe("PillButton", () => {
  it("is a pill with a visible focus ring, in every variant", () => {
    for (const variant of ["primary", "outline", "text"] as const) {
      const { unmount } = render(<PillButton variant={variant}>Start</PillButton>);
      const button = screen.getByRole("button");

      expect(button.className, variant).toContain("rounded-pill");
      expect(button.className, variant).toContain("focus-visible:ring-2");
      unmount();
    }
  });

  it("fills with the accent as primary, outlines it as secondary", () => {
    const { rerender } = render(<PillButton>Start</PillButton>);
    expect(screen.getByRole("button").className).toContain("bg-action");

    rerender(<PillButton variant="outline">Start</PillButton>);
    expect(screen.getByRole("button").className).toContain("border-action");
    expect(screen.getByRole("button").className).not.toContain("bg-action");
  });

  /**
   * A bare `<button>` inside a form submits it. Every one of these sits in a
   * page that may grow a form around it, so the default has to be the one that
   * does nothing on its own.
   */
  it("does not submit a form unless it is asked to", () => {
    const { rerender } = render(<PillButton>Start</PillButton>);
    expect(screen.getByRole("button").getAttribute("type")).toBe("button");

    rerender(<PillButton type="submit">Start</PillButton>);
    expect(screen.getByRole("button").getAttribute("type")).toBe("submit");
  });

  /**
   * Banned #10 / the States gate: a control that looks identical under the
   * cursor and under the press reads as dead. The feedback is an opacity ramp
   * rather than a second violet, because there is one accent (signed §1) and
   * a hover colour would be a second one — and because `text-action` on
   * `bg-soft` is already the sub-AA pair the token pass is fixing.
   */
  it("answers the cursor and the press, in the doctrine micro band", () => {
    for (const variant of ["primary", "outline", "text"] as const) {
      const { unmount } = render(<PillButton variant={variant}>Start</PillButton>);
      const button = screen.getByRole("button");

      for (const token of [
        "hover:opacity-90",
        "active:opacity-80",
        "duration-micro",
        "ease-standard",
      ]) {
        expect(button.className, `${variant} ${token}`).toContain(token);
      }
      unmount();
    }
  });

  it("passes a click through", () => {
    const onClick = vi.fn();
    render(<PillButton onClick={onClick}>Start</PillButton>);
    screen.getByRole("button").click();

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("PageHeader", () => {
  it("is the page's one h1, with the note in mono beside it", () => {
    render(<PageHeader title="Inbox" note="nothing waiting" />);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Inbox");
    expect(screen.getByText("nothing waiting").className).toContain("type-mono");
  });

  it("leaves the note out when there is none", () => {
    const { container } = render(<PageHeader title="Inbox" />);
    expect(container.querySelectorAll("p")).toHaveLength(0);
  });
});

describe("EmptyState", () => {
  it("says what happens next: a heading and one line, and no way out", () => {
    render(<EmptyState heading="All clear" body="Nothing waiting until your first campaign." />);

    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("All clear");
    expect(screen.getByText("Nothing waiting until your first campaign.")).toBeDefined();
    // §22.7 is "say what happens next", not "offer a door" — there is nowhere
    // for one to go on a page with nothing behind it.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("renders the tile only when it is given a drawing", () => {
    const { container, rerender } = render(<EmptyState heading="All clear" body="Nothing yet." />);
    expect(container.querySelector(".bg-soft")).toBeNull();

    rerender(<EmptyState icon={<svg />} heading="All clear" body="Nothing yet." />);
    expect(container.querySelector(".bg-soft")).not.toBeNull();
  });
});
