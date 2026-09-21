import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

    expect(screen.getByTestId("researching-note").textContent).toBe(`${campaignsCopy.researchingRunning} ${campaignsCopy.researchingUsually}`);
    // The one action is absent, because Researching carries none (§23.1c).
    for (const label of [campaignsCopy.actionConfirm, campaignsCopy.actionPause, campaignsCopy.actionResume, campaignsCopy.actionWiden]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
    // No spinner, and no plan: there is nothing to show yet.
    expect(screen.queryAllByTestId("plan-card")).toHaveLength(0);
    // The signed five, and Where: the region research is held to, in the rail's Brief tab.
    expect(screen.getAllByTestId("brief-field")).toHaveLength(6);
    // What research produces is a plain list, never a bar.
    expect(screen.getByTestId("researching-produces").querySelectorAll("li")).toHaveLength(campaignsCopy.researchingProduces.length);
    expect(document.querySelector("progress")).toBeNull();
  });

  it("Plan ready leads with the plan and offers Confirm plan", () => {
    render(<CampaignPage campaign={campaign("managed-print-partners-midlands")} />);

    expect(screen.getByRole("button", { name: campaignsCopy.actionConfirm })).toBeDefined();
    expect(screen.getAllByTestId("plan-card")).toHaveLength(5);
    // The plan section is open, not folded: this state is the Confirm screen.
    expect(screen.queryByTestId("plan-toggle")).toBeNull();
    // Nothing downstream is drawn as a number before it exists.
    expect(screen.queryAllByTestId("plan-fact")).toHaveLength(0);
    expect(screen.queryAllByTestId("progress-count")).toHaveLength(0);
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

  it("has no Ask tab and no free-text box: a sample has no record to read activity from", () => {
    render(<CampaignPage campaign={campaign("uk-logistics-ops")} />);
    expect(screen.queryByTestId("rail-tab-ask")).toBeNull();
    expect(screen.queryByTestId("rail-tab-activity")).toBeNull();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
  });

  it("the research stop shows what it found, three widenings, and Widen the brief", () => {
    render(<CampaignPage campaign={campaign("vets-scotland")} />);

    expect(screen.getByRole("button", { name: campaignsCopy.actionWiden })).toBeDefined();
    // Said in the stage summary and on the stop card, once each.
    expect(screen.getAllByText(campaignsCopy.stopBanner, { exact: false }).length).toBeGreaterThan(0);
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

  it("while research reads, says so truthfully, shows the brief, and nothing downstream", () => {
    render(<CampaignPage campaign={liveCampaign("researching")} />);

    // The fixture's job is running, so the page says reading, not waiting.
    expect(screen.getByTestId("researching-note").textContent).toBe(`${campaignsCopy.researchingRunning} ${campaignsCopy.researchingUsually}`);
    expect(screen.getByTestId("stage-activity").textContent).toContain(campaignsCopy.summaryRunning);
    expect(screen.queryAllByTestId("progress-count")).toHaveLength(0);
    // Nothing to change while research reads: no Edit brief, and no Try again.
    expect(screen.queryByTestId("edit-brief")).toBeNull();
    expect(screen.queryByRole("button", { name: campaignsCopy.actionTryAgain })).toBeNull();
    expect(screen.queryByRole("link", { name: campaignsCopy.peopleLink })).toBeNull();
    // Nothing spent, and the rail says so.
    fireEvent.click(screen.getByTestId("rail-tab-spend"));
    expect(screen.getByTestId("spend-none").textContent).toBe(campaignsCopy.spendNothingYet);
  });

  it("a queued job is said to be waiting, never reading", () => {
    const live = liveCampaign("researching");
    const queued = { ...live, facts: { ...live.facts!, inFlight: { kind: "research" as const, status: "queued" as const } } };
    render(<CampaignPage campaign={queued} />);
    expect(screen.getByTestId("researching-note").textContent).toBe(`${campaignsCopy.researchingWaiting} ${campaignsCopy.researchingUsually}`);
    expect(screen.getByTestId("stage-line").textContent).toBe(campaignsCopy.summaryWaiting);
    expect(screen.queryByTestId("stage-activity")).toBeNull();
  });

  it("on a complete plan, draws Confirm plan but cannot press it, and says why", () => {
    render(<CampaignPage campaign={liveCampaign("complete")} />);

    const confirm = screen.getByRole("button", { name: campaignsCopy.actionConfirm });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.click(confirm);
    expect(currentStep()).toBe(campaignsCopy.stepPlanReady);
    expect(screen.getByTestId("action-note").textContent).toBe(campaignsCopy.confirmLater);
    // A real plan is the decision (product-truth pass); the plan cards are for the samples only.
    expect(screen.getByTestId("plan-decision")).toBeDefined();
    expect(screen.queryAllByTestId("plan-card")).toHaveLength(0);
    // No people, credits or sending window: none of them exists before lead gen.
    expect(screen.queryAllByTestId("plan-fact")).toHaveLength(0);
    expect(screen.queryByTestId("plan-partial")).toBeNull();
    expect(screen.queryByTestId("incomplete-note")).toBeNull();
  });

  it("says how many plays research found, recommends the first, and lets the rest be read and picked", () => {
    const live = liveCampaign("complete");
    const plays = live.plays ?? [];
    expect(plays.length).toBeGreaterThan(1);
    expect(plays[0]?.recommended).toBe(true);
    render(<CampaignPage campaign={live} />);

    expect(screen.getByTestId("plays-found").textContent).toContain(`${campaignsCopy.playsFoundLead} ${plays.length} ${campaignsCopy.playsFoundMany}`);
    // The recommended play is read in full under the comparison, Who first.
    expect(screen.getByTestId("play-recommended").textContent).toContain(live.overview?.startWith?.groupName ?? "missing");
    const others = screen.getAllByTestId("play-alternative");
    expect(others).toHaveLength(plays.length - 1);
    // Every play is compared on the same three things, in one table.
    const table = screen.getByTestId("plays-compare");
    for (const column of [campaignsCopy.playsColumnPlay, campaignsCopy.playsColumnWho, campaignsCopy.playsColumnWrongIf]) expect(table.textContent).toContain(column);
    for (const play of plays) expect(table.textContent).toContain(play.wrongIf);
    // Confirm starts with the recommended play until another that can be searched is picked (lead gen v2.3).
    expect(screen.getByTestId("confirm-starts-with").textContent).toContain(plays[0]?.group.name ?? "missing");
    const executable = plays.slice(1).find((play) => play.executable);
    expect(executable).toBeDefined();
    const pick = others.find((row) => row.getAttribute("data-executable") === "true")?.querySelector("[data-testid=play-select]");
    fireEvent.click(pick!);
    expect(screen.getByTestId("confirm-starts-with").textContent).toContain(executable?.group.name ?? "missing");
    // The card under the table now reads the picked play, and the recommended one is a press away.
    expect(screen.getByTestId("play-detail").textContent).toContain(executable?.group.name ?? "missing");
    expect(screen.queryByTestId("play-recommended")).toBeNull();
    fireEvent.click(screen.getByTestId("play-select-recommended"));
    expect(screen.getByTestId("confirm-starts-with").textContent).toContain(plays[0]?.group.name ?? "missing");
    expect(screen.getByTestId("play-recommended")).toBeDefined();
    // A play with no search can be read but never picked.
    for (const item of others) {
      const searchable = item.getAttribute("data-executable") === "true";
      expect(item.querySelector("[data-testid=play-select]") !== null).toBe(searchable);
    }
  });

  it("ticks the plays that can be searched, and Create campaigns sends them once and goes to the list (Relay P1)", async () => {
    const live = liveCampaign("complete");
    expect(live.canCreatePlays).toBe(true);
    const onCreatePlays = vi.fn<(submission: RetrySubmission & { playIds: string[] }) => Promise<StartResult>>().mockResolvedValue({ id: live.id });
    render(<CampaignPage campaign={live} onConfirm={vi.fn()} onCreatePlays={onCreatePlays} />);

    const executable = (live.plays ?? []).filter((play) => play.executable);
    const ticks = screen.getAllByTestId("play-tick");
    expect(ticks).toHaveLength(executable.length);
    const create = screen.getByRole("button", { name: campaignsCopy.playsCreate });
    expect(create.hasAttribute("disabled")).toBe(true);
    // One clear action: Create campaigns is the primary, and Confirm waits until the campaigns exist.
    expect(create.className).toContain("bg-action");
    expect(screen.queryByRole("button", { name: campaignsCopy.actionConfirm })).toBeNull();
    expect(screen.queryByTestId("confirm-card")).toBeNull();
    expect(screen.queryByTestId("confirm-starts-with")).toBeNull();
    fireEvent.click(ticks[1]!);
    fireEvent.click(ticks[0]!);
    fireEvent.click(create);
    fireEvent.click(create);
    await waitFor(() => expect(push).toHaveBeenCalledWith("/campaigns"));
    expect(onCreatePlays).toHaveBeenCalledTimes(1);
    expect(onCreatePlays.mock.calls[0]?.[0]).toMatchObject({ campaignId: live.id, briefVersion: live.briefVersion, playIds: [executable[1]?.id, executable[0]?.id] });
    expect(onCreatePlays.mock.calls[0]?.[0].requestId).toMatch(UUID);
  });

  it("shows a campaign made for one play that play only, with no tick boxes, and Confirm names it (Relay P1)", async () => {
    const live = liveCampaign("complete");
    const mine = (live.plays ?? []).filter((play) => play.executable)[1]!;
    const made = { ...live, plays: [mine], playId: mine.id, canCreatePlays: false };
    const onConfirm = vi.fn<(submission: RetrySubmission & { candidateId?: string }) => Promise<StartResult>>().mockResolvedValue({ id: live.id });
    render(<CampaignPage campaign={made} onConfirm={onConfirm} onCreatePlays={vi.fn()} />);

    expect(screen.queryAllByTestId("play-tick")).toHaveLength(0);
    expect(screen.queryByTestId("plays-create")).toBeNull();
    expect(screen.getByTestId("confirm-starts-with").textContent).toContain(mine.group.name);
    // Once campaigns are made, Confirm is the header's action again.
    expect(screen.getByRole("button", { name: campaignsCopy.actionConfirm })).toBeDefined();
  });

  it("keeps Confirm as it was when only one play can be searched (Relay P1)", () => {
    const live = liveCampaign("complete");
    const only = (live.plays ?? []).filter((play) => play.executable)[0]!;
    const single = { ...live, plays: [only], canCreatePlays: false };
    render(<CampaignPage campaign={single} onConfirm={vi.fn()} onCreatePlays={vi.fn()} />);

    expect(screen.queryByTestId("plays-create")).toBeNull();
    expect(screen.getByRole("button", { name: campaignsCopy.actionConfirm })).toBeDefined();
    expect(screen.getByTestId("confirm-starts-with").textContent).toContain(only.group.name);
  });

  it("keeps the whole research one tab away, and offers Edit brief", () => {
    const live = liveCampaign("complete");
    render(<CampaignPage campaign={live} />);

    expect(screen.getByTestId("edit-brief").getAttribute("href")).toBe(`/campaigns/${live.id}/edit`);
    fireEvent.click(screen.getByTestId("rail-tab-research"));
    expect(screen.getByTestId("overview-folded")).toBeDefined();
    fireEvent.click(screen.getByTestId("overview-show"));
    expect(screen.getByTestId("overview-start-with").textContent).toContain(live.overview?.startWith?.groupName ?? "missing");
  });

  it("a finished pack with no play Relay can search needs the rep, offers no Confirm, and keeps the research readable", () => {
    const live = liveCampaign("noplay");
    expect(live.state).toBe("failed");
    expect(live.failure).toBe("no_play");
    expect(live.facts?.stage).toBe("research_needs_you");
    render(<CampaignPage campaign={live} />);

    expect(currentStep()).toBe(campaignsCopy.stepNeedsYou);
    expect(screen.queryByRole("button", { name: campaignsCopy.actionConfirm })).toBeNull();
    expect(screen.queryByRole("button", { name: campaignsCopy.actionTryAgain })).toBeNull();
    expect(screen.getByTestId("incomplete-note").textContent).toContain(campaignsCopy.failedNoPlay);
    // The card carries the reason; the line under the title steps back rather than say it twice.
    expect(screen.queryByTestId("stage-line")).toBeNull();
    expect(screen.getByTestId("edit-brief").getAttribute("href")).toBe("/campaigns/camp-noplay/edit");
    expect(screen.getByTestId("incomplete-edit").getAttribute("href")).toBe("/campaigns/camp-noplay/edit");
    expect(screen.getByTestId("incomplete-research").getAttribute("href")).toBe("/campaigns/camp-noplay/research");
  });

  it("on a partial plan that can still be confirmed, says which parts are missing, in a rep's words, beside the research", () => {
    const live = liveCampaign("partial");
    expect(live.state).toBe("planReady");
    render(<CampaignPage campaign={live} />);

    fireEvent.click(screen.getByTestId("rail-tab-research"));
    fireEvent.click(screen.getByTestId("overview-show"));
    const note = screen.getByTestId("plan-partial").textContent ?? "";
    expect(note).toContain(campaignsCopy.planPartial);
    expect(note).toContain(campaignsCopy.partNames.m14);
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

describe("the way into What Relay learned", () => {
  it("is on a real campaign's finished plan, in the rail's Research tab", () => {
    render(<CampaignPage campaign={liveCampaign("complete")} />);
    fireEvent.click(screen.getByTestId("rail-tab-research"));
    expect(screen.getByTestId("rail-research-link").getAttribute("href")).toBe("/campaigns/camp-complete/research");
  });

  it("is on no sample, and on no real campaign without a plan", () => {
    render(<CampaignPage campaign={campaign("managed-print-partners-midlands")} />);
    expect(screen.queryByTestId("rail-tab-research")).toBeNull();
    render(<CampaignPage campaign={liveCampaign("stopped")} />);
    expect(screen.queryByTestId("rail-research-link")).toBeNull();
  });
});
