import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CampaignPage } from "@/components/campaigns/CampaignPage";
import type { RetrySubmission, StartResult, WidenSubmission } from "@/lib/campaigns/start";
import { campaignsCopy } from "@/lib/copy/campaigns";
import { getCampaign, type Campaign } from "@/lib/fixtures/campaigns";

import { liveCampaign } from "./live";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ usePathname: () => "/campaigns", useRouter: () => ({ push, refresh }) }));

beforeEach(() => {
  push.mockClear();
  refresh.mockClear();
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
    // The signed five, and Where: the region research is held to.
    expect(screen.getAllByTestId("brief-field")).toHaveLength(6);
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

describe("Edit brief replaces Change something", () => {
  it("has no reason picker anywhere, on a sample or a real campaign", () => {
    for (const shown of [campaign("managed-print-partners-midlands"), liveCampaign("complete")]) {
      const { unmount } = render(<CampaignPage campaign={shown} />);
      expect(screen.queryByTestId("change-dialog")).toBeNull();
      expect(screen.queryByTestId("change-reason")).toBeNull();
      expect(screen.queryByText("Change something…")).toBeNull();
      unmount();
    }
  });

  it("a sample offers no Edit brief: there is no real brief behind it", () => {
    render(<CampaignPage campaign={campaign("managed-print-partners-midlands")} />);
    expect(screen.queryByTestId("edit-brief")).toBeNull();
  });
});

/**
 * A real campaign, built the way the router builds it over contract data
 * (`./live.ts`). It offers only what is built, and draws nothing downstream
 * before it has happened.
 */
describe("a real campaign", () => {
  const currentStep = () =>
    screen.getAllByTestId("state-step").find((step) => step.getAttribute("aria-current") === "step")?.textContent;

  it("while research reads, shows the brief and how long it takes, and nothing downstream", () => {
    render(<CampaignPage campaign={liveCampaign("researching")} />);

    expect(screen.getByTestId("researching-note").textContent).toBe(campaignsCopy.researchingNote);
    expect(screen.getByTestId("progress-none").textContent).toBe(campaignsCopy.progressNone);
    expect(screen.queryAllByTestId("progress-count")).toHaveLength(0);
    // Nothing to change while research reads: no Edit brief, and no Try again.
    expect(screen.queryByTestId("edit-brief")).toBeNull();
    expect(screen.queryByRole("button", { name: campaignsCopy.actionTryAgain })).toBeNull();
    expect(screen.queryByRole("link", { name: campaignsCopy.peopleLink })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: campaignsCopy.askCost }));
    expect(screen.getByTestId("ask-answer").textContent).toBe(campaignsCopy.answerCostNoCredits);
  });

  it("on a complete plan, draws Confirm plan but cannot press it, and says why", () => {
    render(<CampaignPage campaign={liveCampaign("complete")} />);

    const confirm = screen.getByRole("button", { name: campaignsCopy.actionConfirm });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.click(confirm);
    expect(currentStep()).toBe(campaignsCopy.stepPlanReady);
    expect(screen.getByTestId("action-note").textContent).toBe(campaignsCopy.confirmLater);
    expect(screen.getAllByTestId("plan-card")).toHaveLength(5);
    // No people, credits or sending window: none of them exists before lead gen.
    expect(screen.queryAllByTestId("plan-fact")).toHaveLength(0);
    expect(screen.queryByTestId("plan-partial")).toBeNull();
  });

  it("names the kind of buyer the hook and the targeting are for", () => {
    const live = liveCampaign("complete");
    const chosen = live.pack?.archetypes.find((group) => group.id === live.pack?.chosenArchetypeId);
    expect(chosen).toBeDefined();
    render(<CampaignPage campaign={live} />);

    for (const card of screen.getAllByTestId("plan-card")) fireEvent.click(within(card).getAllByRole("button")[0]!);
    const labels = screen.getAllByTestId("plan-for").map((line) => line.textContent);
    expect(labels.length).toBeGreaterThanOrEqual(1);
    expect(new Set(labels)).toEqual(new Set([`${campaignsCopy.forGroup} ${chosen?.name}`]));
    // Each open card offers Edit brief, to the same page the brief card does.
    const fromCards = screen.getAllByRole("link", { name: campaignsCopy.editBrief });
    expect(fromCards.length).toBeGreaterThan(1);
    expect(new Set(fromCards.map((link) => link.getAttribute("href")))).toEqual(new Set([`/campaigns/${live.id}/edit`]));
  });

  it("on Plan ready, offers Edit brief on the brief card, and keeps finding people out of reach", () => {
    render(<CampaignPage campaign={liveCampaign("partial")} />);

    expect(screen.getByTestId("edit-brief").getAttribute("href")).toBe("/campaigns/camp-partial/edit");
    expect(screen.getByRole("button", { name: campaignsCopy.actionConfirm }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: campaignsCopy.actionTryAgain })).toBeNull();
  });

  it("on a partial plan, says which parts are missing, in a rep's words", () => {
    render(<CampaignPage campaign={liveCampaign("partial")} />);

    const note = screen.getByTestId("plan-partial").textContent ?? "";
    expect(note).toContain(campaignsCopy.planPartial);
    expect(note).toContain(campaignsCopy.partNames.m04);
    expect(note).not.toMatch(/\bm\d\d\b|repSummary|execSummary/);
  });

  it("on a stop, shows research's own options as a choice, with the evidence it cites", () => {
    const live = liveCampaign("stopped");
    render(<CampaignPage campaign={live} onWiden={vi.fn()} />);

    expect(screen.getAllByTestId("widening")).toHaveLength(3);
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.getByTestId("stop-reason").textContent).toBe(live.pack?.insufficient?.reason);
    // Research's text, word for word, under each heading.
    for (const option of live.pack!.insufficient!.widenings) expect(screen.getByText(option.text)).toBeDefined();
    expect(screen.getByTestId("widen-note").textContent).toBe(campaignsCopy.stopChooseOne);
    expect(screen.getByTestId("edit-brief")).toBeDefined();
    // The stop's action is on the option, not in the header.
    expect(screen.queryByRole("button", { name: campaignsCopy.actionWiden })).toBeNull();
    expect(screen.getAllByTestId("pack-item")).toHaveLength(live.pack?.stopEvidence?.length ?? -1);
    expect(screen.queryAllByTestId("plan-card")).toHaveLength(0);
    expect(currentStep()).toBe(campaignsCopy.stepStopped);
    // Nothing downstream is offered: no Confirm.
    expect(screen.queryByRole("button", { name: campaignsCopy.actionConfirm })).toBeNull();
  });

  it("tells two options that widen the same thing apart, without rewriting research's words", () => {
    render(<CampaignPage campaign={liveCampaign("stopped")} />);

    const headings = screen.getAllByTestId("widen-heading").map((heading) => heading.textContent);
    expect(new Set(headings).size).toBe(3);
    expect(headings.slice(0, 2)).toEqual([
      `${campaignsCopy.widenRegion}${campaignsCopy.noteJoin}${campaignsCopy.widenOption} 1`,
      `${campaignsCopy.widenRegion}${campaignsCopy.noteJoin}${campaignsCopy.widenOption} 2`,
    ]);
    const becomes = screen.getAllByTestId("widen-becomes").map((line) => line.textContent);
    expect(new Set(becomes).size).toBe(3);
  });

  it("asks for the chosen option once, from the version on screen, then comes back to the campaign", async () => {
    const live = liveCampaign("stopped");
    const onWiden = vi.fn<(submission: WidenSubmission) => Promise<StartResult>>().mockResolvedValue({ id: live.id });
    render(<CampaignPage campaign={live} onWiden={onWiden} />);

    const submit = screen.getByTestId("widen-submit");
    expect(submit.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getAllByRole("radio")[1]!);
    expect(submit.hasAttribute("disabled")).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => expect(push).toHaveBeenCalledWith(`/campaigns/${live.id}?again=1`));
    expect(onWiden).toHaveBeenCalledTimes(1);
    const sent = onWiden.mock.calls[0]![0];
    expect(sent).toMatchObject({ campaignId: live.id, briefVersion: 1, optionIndex: 1 });
    expect(sent.requestId).toMatch(UUID);
  });

  it("shows the line the server sends back when a choice is refused, and keeps the choice", async () => {
    const live = liveCampaign("stopped");
    const onWiden = vi.fn<(submission: WidenSubmission) => Promise<StartResult>>().mockResolvedValue({ error: campaignsCopy.changedSince });
    render(<CampaignPage campaign={live} onWiden={onWiden} />);

    fireEvent.click(screen.getAllByRole("radio")[0]!);
    fireEvent.click(screen.getByTestId("widen-submit"));

    expect((await screen.findByTestId("widen-error")).textContent).toBe(campaignsCopy.changedSince);
    expect((screen.getAllByRole("radio")[0] as HTMLInputElement).checked).toBe(true);
    expect(push).not.toHaveBeenCalled();
  });

  it("when research failed, says why in words, that nothing was spent, and offers Try again and Edit brief", async () => {
    const live = liveCampaign("failed");
    const onRetry = vi.fn<(submission: RetrySubmission) => Promise<StartResult>>().mockResolvedValue({ id: live.id });
    render(<CampaignPage campaign={live} onRetry={onRetry} />);

    const note = screen.getByTestId("failed-note").textContent ?? "";
    expect(note).toContain(campaignsCopy.failedTookTooLong);
    expect(note).toContain(campaignsCopy.failedNothingSpent);
    expect(note).toContain(campaignsCopy.failedNextRetry);
    expect(note).not.toContain("rail");
    expect(currentStep()).toBe(campaignsCopy.stepNeedsYou);
    expect(screen.getByTestId("edit-brief")).toBeDefined();
    for (const label of [campaignsCopy.actionConfirm, campaignsCopy.actionWiden]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }

    fireEvent.click(screen.getByRole("button", { name: campaignsCopy.actionTryAgain }));
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/campaigns/${live.id}?again=1`));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]![0]).toMatchObject({ campaignId: live.id, briefVersion: 1 });
    expect(onRetry.mock.calls[0]![0].requestId).toMatch(UUID);
  });

  it("offers Try again only when the research itself failed", () => {
    for (const kind of ["researching", "complete", "partial", "stopped", "unreadable"] as const) {
      const { unmount } = render(<CampaignPage campaign={liveCampaign(kind)} />);
      expect(screen.queryByRole("button", { name: campaignsCopy.actionTryAgain })).toBeNull();
      unmount();
    }
    // Nothing Relay could read came back: the rep edits the brief instead.
    render(<CampaignPage campaign={liveCampaign("unreadable")} />);
    expect(screen.getByTestId("failed-note").textContent).toContain(campaignsCopy.failedNextEdit);
    expect(screen.getByTestId("edit-brief")).toBeDefined();
  });

  it("never says an action arrives next, now that each one is real", () => {
    for (const kind of ["researching", "complete", "partial", "stopped", "failed", "unreadable"] as const) {
      const { container, unmount } = render(<CampaignPage campaign={liveCampaign(kind)} />);
      expect(container.textContent).not.toMatch(/able to .* next|arrives? (next|with)/i);
      unmount();
    }
  });

  it("shows who exactly on the brief card, and only the parts the rep set", () => {
    render(<CampaignPage campaign={liveCampaign("stopped")} />);

    const fields = Object.fromEntries(
      screen.getAllByTestId("brief-field").map((field) => [field.querySelector("dt")?.textContent, field.querySelector("dd")?.textContent]),
    );
    expect(fields[campaignsCopy.fieldWho]).toBe("veterinary practices in Orkney");
    expect(fields[campaignsCopy.fieldWhere]).toBe(
      `United Kingdom, Orkney (${campaignsCopy.alsoCalled} Orkney Islands, Kirkwall, Stromness)`,
    );
    expect(fields[campaignsCopy.fieldOrgTypes]).toBe("veterinary practice");
    expect(fields[campaignsCopy.fieldSize]).toBeUndefined();
    expect(fields[campaignsCopy.fieldRolesInclude]).toBeUndefined();
  });
});
