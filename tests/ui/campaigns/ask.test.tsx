import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AskRelay } from "@/components/campaigns/AskRelay";
import { campaignsCopy } from "@/lib/copy/campaigns";
import { getCampaign, type Campaign } from "@/lib/fixtures/campaigns";

function campaign(id: string): Campaign {
  const found = getCampaign(id);
  if (found === null) throw new Error(`no fixture campaign ${id}`);
  return found;
}

/**
 * Ask Relay (§23.1c, orchestrator §8): six chips, no free text.
 *
 * Every number in an answer is checked against the campaign's own counts, which
 * is rubric row 3 on the bench and the same rule here: the model phrases these
 * later, it never computes them.
 */
describe("Ask Relay", () => {
  it("is six questions and no way to ask a seventh", () => {
    render(<AskRelay questions={campaign("uk-logistics-ops").ask} />);

    const chips = screen.getAllByTestId("ask-chip");
    expect(chips.map((chip) => chip.textContent)).toEqual([
      campaignsCopy.askHowGoing,
      campaignsCopy.askWaiting,
      campaignsCopy.askReplies,
      campaignsCopy.askNextBatch,
      campaignsCopy.askCost,
      campaignsCopy.askWhyStopped,
    ]);
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
  });

  it("answers each one from the campaign's own counts", () => {
    const running = campaign("uk-logistics-ops");
    render(<AskRelay questions={running.ask} />);

    const answers = ["6 sent, 2 replied. 11 drafted of 20 found.",
      `2 ${campaignsCopy.answerWaitingDrafts}`,
      `2 ${campaignsCopy.answerRepliesLead} 2 ${campaignsCopy.answerRepliesWarm} · 0 ${campaignsCopy.answerRepliesMeetings}.`,
      `${campaignsCopy.answerBatchLead} Thursday ${campaignsCopy.answerBatchAt} 09:00.`,
      `20 ${campaignsCopy.answerCostUsed} 142 ${campaignsCopy.answerCostLeft}`,
      campaignsCopy.answerStoppedNone,
    ];

    screen.getAllByTestId("ask-chip").forEach((chip, index) => {
      fireEvent.click(chip);
      expect(screen.getByTestId("ask-answer").textContent).toBe(answers[index]);
    });
  });

  it("says what is waiting on the rep when a plan is ready, and why when research stopped", () => {
    const { unmount } = render(<AskRelay questions={campaign("managed-print-partners-midlands").ask} />);
    fireEvent.click(screen.getByRole("button", { name: campaignsCopy.askWaiting }));
    expect(screen.getByTestId("ask-answer").textContent).toBe(campaignsCopy.answerWaitingConfirm);
    unmount();

    render(<AskRelay questions={campaign("vets-scotland").ask} />);
    fireEvent.click(screen.getByRole("button", { name: campaignsCopy.askWhyStopped }));
    expect(screen.getByTestId("ask-answer").textContent).toBe(campaignsCopy.answerStopped);
  });

  it("closes an answer when the same question is pressed again", () => {
    render(<AskRelay questions={campaign("uk-logistics-ops").ask} />);

    const chip = screen.getByRole("button", { name: campaignsCopy.askCost });
    fireEvent.click(chip);
    expect(screen.getByTestId("ask-answer")).toBeDefined();
    fireEvent.click(chip);
    expect(screen.queryByTestId("ask-answer")).toBeNull();
  });
});
