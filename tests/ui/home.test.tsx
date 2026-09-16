import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CampaignRow } from "@/components/campaigns/CampaignRow";
import { Home } from "@/components/Home";
import { HomeDayOne } from "@/components/HomeDayOne";
import type { CampaignStageAttention, CampaignSummary, CampaignSummaryFacts } from "@/lib/campaigns/types";
import { campaignsCopy } from "@/lib/copy/campaigns";
import { homeCopy } from "@/lib/copy/home";

const BOTH_CONNECTED = { mailbox: true };
const NEITHER_CONNECTED = { mailbox: false };

const noop = async () => null;

describe("Home on day one", () => {
  it("greets the rep by first name, with the date beside it", () => {
    render(
      <HomeDayOne
        firstName="Ben"
        today="Mon 7 Sep"
        connections={BOTH_CONNECTED}
        startBrief={noop}
      />,
    );

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(`${homeCopy.welcome}, Ben`);
    expect(screen.getByText("Mon 7 Sep")).toBeDefined();
  });

  it("is the brief box and its question, and nothing else to click", () => {
    render(
      <HomeDayOne
        firstName="Ben"
        today="Mon 7 Sep"
        connections={BOTH_CONNECTED}
        startBrief={noop}
      />,
    );

    expect(screen.getByRole("heading", { level: 2, name: homeCopy.briefQuestion })).toBeDefined();
    expect(screen.getByText(homeCopy.briefHint)).toBeDefined();
    expect(screen.getByPlaceholderText(homeCopy.briefPlaceholder)).toBeDefined();
    expect(screen.getByText(homeCopy.briefFooter)).toBeDefined();
    // One control on the page: Start. Nothing else is clickable (§23.1a).
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([homeCopy.briefStart]);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("prompts for the mailbox while it is not connected, and says nothing about Zoho", () => {
    const { container } = render(
      <HomeDayOne
        firstName="Ben"
        today="Mon 7 Sep"
        connections={NEITHER_CONNECTED}
        startBrief={noop}
      />,
    );

    expect(screen.getByText(homeCopy.connectMailbox)).toBeDefined();
    // Zoho is the admin's, not the rep's: a prompt they cannot act on is not a step.
    expect(container.textContent).not.toMatch(/zoho/i);
  });

  it("prompts for nothing once the mailbox is connected", () => {
    render(
      <HomeDayOne
        firstName="Ben"
        today="Mon 7 Sep"
        connections={BOTH_CONNECTED}
        startBrief={noop}
      />,
    );

    expect(screen.queryByText(homeCopy.connectMailbox)).toBeNull();
  });

  it("shows what Start does today, and only after it is used", async () => {
    const startBrief = vi.fn(async () => campaignsCopy.next);

    render(
      <HomeDayOne
        firstName="Ben"
        today="Mon 7 Sep"
        connections={BOTH_CONNECTED}
        startBrief={startBrief}
      />,
    );

    expect(screen.queryByText(campaignsCopy.next)).toBeNull();

    const box = screen.getByPlaceholderText(homeCopy.briefPlaceholder) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "UK logistics firms, ops directors" } });
    fireEvent.click(screen.getByRole("button", { name: homeCopy.briefStart }));

    expect(await screen.findByText(campaignsCopy.next)).toBeDefined();
    expect(startBrief).toHaveBeenCalledTimes(1);
    // The sentence reaches the action, which is the only thing it is for.
    const [, formData] = startBrief.mock.calls[0] as unknown as [unknown, FormData];
    expect(formData.get("sentence")).toBe("UK logistics firms, ops directors");
  });

  /**
   * The rail is the widget slot: slice 1 drops its widgets in without moving
   * the card. Empty today, so the grid must not leave a signed two-column gap
   * where nothing is (the signed mock centres the day-one card).
   */
  it("leaves the rail empty and the card centred on day one", () => {
    render(
      <HomeDayOne
        firstName="Ben"
        today="Mon 7 Sep"
        connections={BOTH_CONNECTED}
        startBrief={noop}
      />,
    );

    const grid = screen.getByTestId("home-grid");
    expect(grid.className).not.toContain("grid-cols-home");
    expect(screen.queryByTestId("home-rail")).toBeNull();
  });

  /**
   * WCAG 2.4.7. The input paints no ring of its own — it is borderless inside
   * the pill, and a ring drawn on it would sit inside the pill's own border.
   * The ring belongs to the pill, which is the control a rep sees.
   */
  it("rings the whole pill when the box has focus", () => {
    render(
      <HomeDayOne
        firstName="Ben"
        today="Mon 7 Sep"
        connections={BOTH_CONNECTED}
        startBrief={noop}
      />,
    );

    expect(screen.getByTestId("brief-pill").className).toContain("focus-within:ring-2");
  });

  /**
   * The disabled Start button guards the mouse and nothing else. Enter goes
   * straight to `requestSubmit`, so a rep leaning on it fired the action once
   * per press — harmless against today's stub, a duplicate campaign in slice 1.
   */
  it("does not fire the action again on Enter while one is already in flight", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const startBrief = vi.fn(async () => {
      await held;
      return campaignsCopy.next;
    });

    render(
      <HomeDayOne
        firstName="Ben"
        today="Mon 7 Sep"
        connections={BOTH_CONNECTED}
        startBrief={startBrief}
      />,
    );

    const box = screen.getByPlaceholderText(homeCopy.briefPlaceholder) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "UK logistics firms, ops directors" } });

    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.keyDown(box, { key: "Enter" });

    release();
    expect(await screen.findByText(campaignsCopy.next)).toBeDefined();
    expect(startBrief).toHaveBeenCalledTimes(1);
  });

  /**
   * The box is a textarea so the signed two-line example fits (mock 1b), which
   * hands Enter back its newline. A brief is one sentence and the mock draws
   * one button: Enter has to keep submitting, or the control the rep reaches
   * for silently changes meaning.
   */
  it("submits on Enter and takes a newline on Shift+Enter", async () => {
    const startBrief = vi.fn(async () => campaignsCopy.next);

    render(
      <HomeDayOne
        firstName="Ben"
        today="Mon 7 Sep"
        connections={BOTH_CONNECTED}
        startBrief={startBrief}
      />,
    );

    const box = screen.getByPlaceholderText(homeCopy.briefPlaceholder) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "UK logistics firms, ops directors" } });

    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(startBrief).not.toHaveBeenCalled();

    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByText(campaignsCopy.next)).toBeDefined();
    expect(startBrief).toHaveBeenCalledTimes(1);
  });

  /**
   * An IME composing Japanese or Chinese ends a candidate with Enter. Reading
   * that as submit sends a half-typed brief, so the box waits for the key that
   * is not part of the composition.
   */
  it("does not submit on the Enter that closes an IME candidate", () => {
    const startBrief = vi.fn(async () => campaignsCopy.next);

    render(
      <HomeDayOne
        firstName="Ben"
        today="Mon 7 Sep"
        connections={BOTH_CONNECTED}
        startBrief={startBrief}
      />,
    );

    const box = screen.getByPlaceholderText(homeCopy.briefPlaceholder) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "\u3042" } });
    fireEvent.keyDown(box, { key: "Enter", isComposing: true });

    expect(startBrief).not.toHaveBeenCalled();
  });

  /** The mock draws the example over two lines; one line clips two of its three clauses. */
  it("gives the box the two lines the signed example needs", () => {
    render(
      <HomeDayOne
        firstName="Ben"
        today="Mon 7 Sep"
        connections={BOTH_CONNECTED}
        startBrief={noop}
      />,
    );

    const box = screen.getByPlaceholderText(homeCopy.briefPlaceholder);
    expect(box.tagName).toBe("TEXTAREA");
    expect(box.getAttribute("rows")).toBe("2");
    expect(box.className).toContain("resize-none");
  });

  it("puts the rail beside the card once there is a widget for it", () => {
    render(
      <HomeDayOne
        firstName="Ben"
        today="Mon 7 Sep"
        connections={BOTH_CONNECTED}
        startBrief={noop}
        rail={<p>a widget</p>}
      />,
    );

    expect(screen.getByTestId("home-grid").className).toContain("grid-cols-home");
    expect(screen.getByTestId("home-rail").textContent).toBe("a widget");
  });
});

/**
 * Fixtures by hand: a `CampaignSummary` is a plain object, and the backend's
 * summary facts are the part Home reads. Everything else is the same for
 * every row.
 */
const NO_SPEND: CampaignSummaryFacts["spend"] = {
  search: { cap: null, charged: 0, held: 0 },
  reveal: { max: null, charged: 0, held: 0 },
  allVersions: { searchCharged: 0, searchHeld: 0, revealCharged: 0, revealHeld: 0 },
  research: { usd: null, usdThisVersion: null },
};

/** A stage and its attention, which may be left out where the stage has none. */
type CampaignStageAttentionOver = Exclude<CampaignStageAttention, { attention: null }> | { stage: Extract<CampaignStageAttention, { attention: null }>["stage"]; attention?: null };

function summary(
  id: string,
  name: string,
  facts: Partial<Omit<CampaignSummaryFacts, "stage" | "attention">> & CampaignStageAttentionOver,
  rest: Partial<Pick<CampaignSummary, "next" | "nextIsAction" | "motionLine" | "chip" | "state">> = {},
): CampaignSummary {
  return {
    id,
    name,
    motionLine: rest.motionLine ?? "Direct · call handling · 20 people over 3 weeks · email",
    state: rest.state ?? "researching",
    chip: rest.chip ?? campaignsCopy.chipResearching,
    contacted: null,
    total: 20,
    next: rest.next ?? campaignsCopy.nextResearching,
    nextIsAction: rest.nextIsAction ?? false,
    facts: {
      id,
      name,
      briefVersion: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      inFlight: null,
      attention: null,
      nextAction: null,
      research: null,
      confirmed: null,
      people: null,
      reveal: null,
      spend: NO_SPEND,
      ...facts,
      // The spread cannot carry the stage/attention pairing through; the parameter type checks it at each call.
    } as CampaignSummaryFacts,
  };
}

const FAILED = summary(
  "camp-failed",
  "UK logistics ops",
  { stage: "research_needs_you", attention: { kind: "needs_you", reason: "took_too_long", retryable: true }, nextAction: "retry_research" },
  { next: campaignsCopy.nextFailed, nextIsAction: true, chip: campaignsCopy.chipNeedsYou, state: "failed" },
);
const TO_DECIDE = summary(
  "camp-plan",
  "Care homes in the North West",
  { stage: "plan_ready", research: { outcome: "complete", plays: 4, viablePlays: 4 }, nextAction: "confirm" },
  { next: campaignsCopy.nextPlanReady, nextIsAction: true, chip: campaignsCopy.chipPlanReady, state: "planReady" },
);
const READY = summary(
  "camp-ready",
  "Dental groups",
  {
    stage: "people_ready",
    people: { accounts: 8, multiRoleAccounts: 1, chosen: 12, pending: 0, kept: 9, dropped: 3 },
    reveal: { revealed: 8, known: 1, noEmail: 0, suppressed: 0, held: 0, failed: 0, emailsReady: 9 },
  },
  { next: campaignsCopy.nextPeopleReady, nextIsAction: false, chip: campaignsCopy.chipPeopleReady, state: "peopleReady" },
);
const QUEUED = summary("camp-queued", "Insurers opening claims teams", { stage: "researching", inFlight: { kind: "research", status: "queued" } });
const READING = summary("camp-reading", "Housing associations", { stage: "researching", inFlight: { kind: "research", status: "running" } });
/** A row with no facts is a sample, and Home does not draw it. */
const SAMPLE: CampaignSummary = { id: "camp-sample", name: "Accountancy firms", motionLine: "Direct", state: "done", chip: campaignsCopy.chipDone, contacted: 30, total: 30, next: "", nextIsAction: false };
const DONE = SAMPLE;

describe("Home with campaigns", () => {
  it("greets the rep, and lists what needs them with the one thing to do on each", () => {
    render(
      <Home
        firstName="Ben"
        today="Mon 7 Sep"
        connections={BOTH_CONNECTED}
        campaigns={[READING, DONE, FAILED, TO_DECIDE, READY, QUEUED]}
        startBrief={noop}
      />,
    );

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(`${homeCopy.welcome}, Ben`);
    expect(screen.getByRole("heading", { level: 2, name: homeCopy.needsYouLabel })).toBeDefined();
    expect(screen.getByRole("heading", { level: 2, name: homeCopy.decideLabel })).toBeDefined();
    expect(screen.getByRole("heading", { level: 2, name: homeCopy.readyLabel })).toBeDefined();

    // The same three words the Campaigns list groups by: what needs the rep, what is theirs to decide, what is ready.
    const rows = [...screen.getAllByTestId("home-needs-you-row"), ...screen.getAllByTestId("home-decide-row"), ...screen.getAllByTestId("home-ready-row")];
    expect(rows.map((row) => row.getAttribute("href"))).toEqual(["/campaigns/camp-failed", "/campaigns/camp-plan", "/campaigns/camp-ready"]);

    // The name, the reason, and the campaign's own next sentence, without "Next:".
    expect(rows[0]?.textContent).toContain("UK logistics ops");
    expect(rows[0]?.textContent).toContain(campaignsCopy.failedTookTooLong);
    expect(rows[0]?.textContent).toContain(campaignsCopy.nextFailed);
    expect(rows[0]?.textContent).not.toContain(campaignsCopy.nextPrefix);
    // A decision with no reason shows its line instead.
    expect(rows[1]?.textContent).toContain(`4 ${campaignsCopy.summaryPlays}`);
    expect(rows[2]?.textContent).toContain(`9 ${campaignsCopy.summaryEmailsReady}`);
    expect(rows[1]?.textContent).toContain(campaignsCopy.nextPlanReady);
    // Ready sits with the decisions: outreach is the rep's call.
    expect(rows[2]?.textContent).toContain(campaignsCopy.nextPeopleReady);
  });

  it("says what Relay is doing: waiting for a queued job, the stage word for a running one", () => {
    render(
      <Home
        firstName="Ben"
        today="Mon 7 Sep"
        connections={BOTH_CONNECTED}
        campaigns={[READING, DONE, FAILED, TO_DECIDE, READY, QUEUED]}
        startBrief={noop}
      />,
    );

    expect(screen.getByRole("heading", { level: 2, name: homeCopy.workingLabel })).toBeDefined();
    const rows = screen.getAllByTestId("home-working-row");
    expect(rows).toHaveLength(2);

    const queued = rows.find((row) => row.getAttribute("href") === "/campaigns/camp-queued");
    const reading = rows.find((row) => row.getAttribute("href") === "/campaigns/camp-reading");
    expect(queued?.textContent).toContain("Insurers opening claims teams");
    expect(queued?.textContent).toContain(campaignsCopy.summaryWaiting);
    expect(queued?.textContent).not.toContain(campaignsCopy.chipResearching);
    expect(reading?.textContent).toContain(campaignsCopy.summaryResearching);
    expect(reading?.textContent).toContain(campaignsCopy.chipResearching);
  });

  it("gives a working campaign's chip the same tone on Home as on the Campaigns list", () => {
    const chipOf = (row: HTMLElement) => row.querySelector(".rounded-pill")?.className;
    for (const campaign of [READING, QUEUED]) {
      const home = render(<Home firstName="Ben" today="Mon 7 Sep" connections={BOTH_CONNECTED} campaigns={[campaign]} startBrief={noop} />);
      const onHome = chipOf(screen.getByTestId("home-working-row"));
      home.unmount();
      const list = render(<CampaignRow campaign={campaign} />);
      const onList = chipOf(screen.getByTestId("campaign-row"));
      list.unmount();
      expect(onHome).toBeDefined();
      expect(onList).toBe(onHome);
    }
  });

  it("carries the brief box, and leaves done campaigns to the list", () => {
    render(
      <Home
        firstName="Ben"
        today="Mon 7 Sep"
        connections={NEITHER_CONNECTED}
        campaigns={[READING, DONE, FAILED]}
        startBrief={noop}
      />,
    );

    expect(screen.getByRole("heading", { level: 2, name: homeCopy.startLabel })).toBeDefined();
    expect(screen.getByPlaceholderText(homeCopy.briefPlaceholder)).toBeDefined();
    expect(screen.getByRole("button", { name: homeCopy.briefStart })).toBeDefined();
    expect(screen.getByText(homeCopy.briefFooter)).toBeDefined();
    expect(screen.getByText(homeCopy.connectMailbox)).toBeDefined();
    expect(screen.getByTestId("brief-pill").className).toContain("focus-within:ring-2");

    // A row without the backend's facts is not Home's to draw.
    expect(screen.queryByText("Accountancy firms")).toBeNull();
    // No analytics: the only numbers are the counts beside the headings.
    expect(screen.getAllByText("1", { selector: ".type-mono" })).toHaveLength(2);
    expect(screen.queryByText(campaignsCopy.of)).toBeNull();
  });

  it("says so when a block has nothing in it", () => {
    render(
      <Home
        firstName="Ben"
        today="Mon 7 Sep"
        connections={BOTH_CONNECTED}
        campaigns={[DONE]}
        startBrief={noop}
      />,
    );

    expect(screen.getByText(homeCopy.needsYouEmpty)).toBeDefined();
    expect(screen.getByText(homeCopy.workingEmpty)).toBeDefined();
    expect(screen.queryAllByTestId("home-needs-you-row")).toHaveLength(0);
    expect(screen.queryAllByTestId("home-decide-row")).toHaveLength(0);
    expect(screen.queryAllByTestId("home-ready-row")).toHaveLength(0);
    expect(screen.queryAllByTestId("home-working-row")).toHaveLength(0);
  });
});
