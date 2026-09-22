import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StateRow } from "@/components/campaigns/StateRow";
import { campaignsCopy } from "@/lib/copy/campaigns";

/**
 * The step row once outreach has started (P5c): drafts are still reviewed
 * after the start, but the rep's question is whether the campaign is running,
 * so the current step is Running, or Paused while it is held.
 */

const current = () => screen.getAllByTestId("state-step").find((step) => step.getAttribute("aria-current") === "step");

describe("the step row and outreach", () => {
  it("stays on Drafts to review until anyone has started", () => {
    render(<StateRow state="drafting" stage="drafts_ready" outreach={{ started: false, paused: false }} />);
    expect(current()?.textContent).toBe(campaignsCopy.stepDraftsReady);
  });

  it("shows Running once outreach has started, with drafts still to review", () => {
    render(<StateRow state="drafting" stage="drafts_ready" outreach={{ started: true, paused: false }} />);
    expect(current()?.textContent).toBe(campaignsCopy.stepRunning);
    expect(screen.getAllByTestId("state-step").map((step) => step.textContent)).toContain(campaignsCopy.stepDraftsReady);
  });

  it("shows Paused on the running step while the campaign is paused", () => {
    render(<StateRow state="drafting" stage="ready_to_send" outreach={{ started: true, paused: true }} />);
    expect(current()?.textContent).toBe(campaignsCopy.stepPaused);
  });

  it("leaves a finished campaign on Done", () => {
    render(<StateRow state="done" outreach={{ started: true, paused: false }} />);
    expect(current()?.textContent).toBe(campaignsCopy.stepDone);
  });
});
