import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CampaignPage } from "@/components/campaigns/CampaignPage";
import { campaignsCopy } from "@/lib/copy/campaigns";
import { getCampaign, type Campaign } from "@/lib/fixtures/campaigns";

vi.mock("next/navigation", () => ({ usePathname: () => "/campaigns" }));

/** A fixture campaign, or a failure that names the id rather than a null deref. */
function campaign(id: string): Campaign {
  const found = getCampaign(id);
  if (found === null) throw new Error(`no fixture campaign ${id}`);
  return found;
}

describe("the campaign page, by state", () => {
  it("Researching shows the brief and one line, and no action", () => {
    render(<CampaignPage campaign={campaign("midlands-fleet-operators")} />);

    expect(screen.getByTestId("researching-note").textContent).toBe(campaignsCopy.researchingNote);
    // The one action is absent, because Researching carries none (§23.1c).
    for (const label of [campaignsCopy.actionConfirm, campaignsCopy.actionPause, campaignsCopy.actionResume, campaignsCopy.actionWiden]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
    // No spinner, and no plan: there is nothing to show yet.
    expect(screen.queryAllByTestId("plan-card")).toHaveLength(0);
    expect(screen.getAllByTestId("brief-field")).toHaveLength(5);
  });

  it("Plan ready leads with the plan and offers Confirm plan", () => {
    render(<CampaignPage campaign={campaign("managed-print-partners-midlands")} />);

    expect(screen.getByRole("button", { name: campaignsCopy.actionConfirm })).toBeDefined();
    expect(screen.getAllByTestId("plan-card")).toHaveLength(5);
    // The plan section is open, not folded: this state is the Confirm screen.
    expect(screen.queryByTestId("plan-toggle")).toBeNull();
    // And the plan's own facts are under it, ending in the lawful-basis line.
    expect(screen.getAllByTestId("plan-fact")).toHaveLength(4);
    expect(screen.getByText(campaignsCopy.lawfulBasis)).toBeDefined();
  });

  it("Running leads with progress, collapses the plan, and offers Pause", () => {
    render(<CampaignPage campaign={campaign("uk-logistics-ops")} />);

    expect(screen.getByRole("button", { name: campaignsCopy.actionPause })).toBeDefined();
    expect(screen.getByTestId("plan-toggle").getAttribute("aria-expanded")).toBe("false");
    expect(screen.getAllByTestId("progress-count").map((count) => count.textContent)).toEqual([
      // The word is the term and the number its definition, so the word is
      // first in the markup and the column is reversed to draw it under.
      `${campaignsCopy.progressFound}20`,
      `${campaignsCopy.progressDrafted}11`,
      `${campaignsCopy.progressApproved}9`,
      `${campaignsCopy.progressSent}6`,
      `${campaignsCopy.progressReplied}2`,
    ]);
  });

  it("Pause becomes Resume, and nothing was spent doing it", () => {
    render(<CampaignPage campaign={campaign("uk-logistics-ops")} />);

    fireEvent.click(screen.getByRole("button", { name: campaignsCopy.actionPause }));

    expect(screen.getByRole("button", { name: campaignsCopy.actionResume })).toBeDefined();
    expect(screen.getByTestId("campaign-toast").textContent).toBe(campaignsCopy.toastConfirmed);
  });

  it("moves the six answers with the screen, not with the campaign it arrived as", () => {
    render(<CampaignPage campaign={campaign("uk-logistics-ops")} />);

    fireEvent.click(screen.getByRole("button", { name: campaignsCopy.askWhyStopped }));
    expect(screen.getByTestId("ask-answer").textContent).toBe(campaignsCopy.answerStoppedNone);

    // The chip stays open across the pause: the answer under it is the thing
    // that has to move, and it moves without being asked again.
    fireEvent.click(screen.getByRole("button", { name: campaignsCopy.actionPause }));

    expect(screen.getByTestId("ask-answer").textContent).toBe(campaignsCopy.answerPaused);
  });

  it("the research stop shows what it found, three widenings, and Widen the brief", () => {
    render(<CampaignPage campaign={campaign("vets-scotland")} />);

    expect(screen.getByRole("button", { name: campaignsCopy.actionWiden })).toBeDefined();
    expect(screen.getByText(campaignsCopy.stopBanner)).toBeDefined();
    expect(screen.getAllByTestId("widening")).toHaveLength(3);
    // Nothing is spent, so the plan is not offered here at all (§23.1c).
    expect(screen.queryAllByTestId("plan-card")).toHaveLength(0);
  });

  it("marks the step the campaign is on, and never adds an eighth", () => {
    render(<CampaignPage campaign={campaign("vets-scotland")} />);

    const steps = screen.getAllByTestId("state-step");
    expect(steps).toHaveLength(7);
    const current = steps.filter((step) => step.getAttribute("aria-current") === "step");
    expect(current.map((step) => step.textContent)).toEqual([campaignsCopy.stepStopped]);
  });
});

describe("arriving from Start", () => {
  it("says nothing was bought or sent", () => {
    render(
      <CampaignPage
        campaign={campaign("midlands-fleet-operators")}
        banner={campaignsCopy.toastStarted}
      />,
    );

    expect(screen.getByTestId("campaign-toast").textContent).toBe(campaignsCopy.toastStarted);
  });
});

describe("Change something", () => {
  it("asks a reason, then shows the campaign reading around the brief again", () => {
    render(<CampaignPage campaign={campaign("managed-print-partners-midlands")} />);

    fireEvent.click(screen.getByRole("button", { name: campaignsCopy.changeSomething }));

    const dialog = screen.getByTestId("change-dialog");
    expect(dialog).toBeDefined();
    // The reason is required: nothing is asked for until one is picked.
    const submit = screen.getByRole("button", { name: campaignsCopy.changeSubmit });
    expect(submit.hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: campaignsCopy.changeReasonPain }));
    fireEvent.change(screen.getByLabelText(campaignsCopy.changeNoteLabel), {
      target: { value: "they are dealers, not end users" },
    });
    fireEvent.click(submit);

    expect(screen.getByTestId("researching-note")).toBeDefined();
    expect(screen.getByTestId("campaign-toast").textContent).toContain(campaignsCopy.changeReasonPain);
    // The note is kept word for word, as the box under it promises.
    expect(screen.getByTestId("campaign-toast").textContent).toContain(
      "they are dealers, not end users",
    );
    // The rejected plan goes with it: there is no research behind the campaign
    // again until the new reading lands.
    expect(screen.queryAllByTestId("plan-card")).toHaveLength(0);
  });

  it("opens the same dialog from a plan card, with that card named", () => {
    render(<CampaignPage campaign={campaign("managed-print-partners-midlands")} />);

    const painCard = screen
      .getAllByTestId("plan-card")
      .find((card) => card.textContent?.startsWith(campaignsCopy.cardPain));
    expect(painCard).toBeDefined();
    fireEvent.click(painCard!.querySelectorAll("button")[0]!);
    fireEvent.click(
      screen.getAllByRole("button", { name: campaignsCopy.changeFromCard })[0]!,
    );

    const dialog = screen.getByTestId("change-dialog");
    expect(dialog.textContent).toContain(campaignsCopy.cardPain);
  });

  it("forgets a reason that was cancelled, rather than arming the next open", () => {
    render(<CampaignPage campaign={campaign("managed-print-partners-midlands")} />);

    fireEvent.click(screen.getByRole("button", { name: campaignsCopy.changeSomething }));
    fireEvent.click(screen.getByRole("button", { name: campaignsCopy.changeReasonWho }));
    fireEvent.click(screen.getByRole("button", { name: campaignsCopy.changeCancel }));

    fireEvent.click(screen.getByRole("button", { name: campaignsCopy.changeSomething }));
    expect(
      screen.getByRole("button", { name: campaignsCopy.changeSubmit }).hasAttribute("disabled"),
    ).toBe(true);
  });
});
