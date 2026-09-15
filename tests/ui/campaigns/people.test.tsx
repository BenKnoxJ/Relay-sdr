import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CampaignPerson, Event, Job } from "@prisma/client";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CampaignPage } from "@/components/campaigns/CampaignPage";
import { toResearchBrief } from "@/lib/campaigns/brief";
import { buildLeadGenHandoff } from "@/lib/campaigns/leadgenHandoff";
import type { Campaign } from "@/lib/campaigns/types";
import { toCampaign, type LeadGenOptions } from "@/lib/campaigns/view";
import { campaignsCopy } from "@/lib/copy/campaigns";
import { NO_CRM } from "@/lib/leadgen/crm";
import { FakeLeadGenProvider } from "@/lib/leadgen/fakeProvider";
import { findPeople } from "@/lib/leadgen/findPeople";
import type { RevealCounts } from "@/lib/leadgen/reveal";
import type { LeadGenRecord, RevealConfirmed } from "@/lib/repo/leadgen";
import type { CampaignRecord } from "@/lib/repo/campaigns";
import type { LeadGenHandoffV2 } from "../../../agents/leadgen/input.schema";
import type { Pick } from "../../../agents/leadgen/output.schema";

import { briefFields, completePack } from "../../lib/campaignPacks";
import { NO_WAIT, ROLE_TITLES, VOCABULARY, candidate } from "../../leadgen/harness";

/**
 * The campaign page through Confirm plan, Finding people, People found and
 * its Needs you, drawn from records shaped as the router reads them. The
 * people are a real `findPeople` result on a scripted provider; nothing is
 * revealed and nothing reaches a provider.
 */

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ usePathname: () => "/campaigns", useRouter: () => ({ push, refresh }) }));

beforeEach(() => {
  push.mockClear();
  refresh.mockClear();
});

const AT = new Date("2026-09-14T12:00:00Z");
const AVAILABLE: LeadGenOptions = { available: true, searchCreditCap: 40, sample: true };
const OFF: LeadGenOptions = { available: false, searchCreditCap: null, sample: false };

let handoff: LeadGenHandoffV2;
let full: Pick;
let partial: Pick;

beforeAll(async () => {
  const brief = toResearchBrief(briefFields());
  const built = buildLeadGenHandoff({
    campaign: { id: "camp-people", orgId: "org_ui", ownerUserId: "user_ui", briefVersion: 1 },
    brief,
    research: { jobId: "job-research", eventId: "event-research", pack: completePack() },
    confirmRequestId: "req-confirm",
    spend: { searchCreditCap: 40, balanceSnapshot: { remaining: 100, readAt: AT.toISOString() }, pricingAssumptions: "lusha-public-docs-2026-09-14-unverified" },
    lawfulBasis: { text: campaignsCopy.lawfulBasis, confirmedByUserId: "user_ui", confirmedAt: AT.toISOString(), briefVersion: 1 },
  });
  if (!built.ok) throw new Error(built.refusal);
  handoff = built.handoff;
  const found = async (count: number) => {
    // Candidate 2 shares the first person's firm, so one account has two people: who runs it and who signs it off.
    const people = Array.from({ length: count }, (_, index) =>
      index === 1 ? candidate(2, { title: "Head of Claims", company: "Firm 1", domain: "firm1.co.uk" }) : candidate(index + 1, { title: ROLE_TITLES[(index + 1) % ROLE_TITLES.length] }),
    );
    const provider = new FakeLeadGenProvider([{ candidates: people, charged: count, hasMore: false }]);
    const result = await findPeople(handoff, { provider, vocabulary: VOCABULARY, knowledge: { people: [], providerIdentities: [], suppressions: [], enrolledPersonIds: [] }, crm: NO_CRM, retry: NO_WAIT });
    if (result.output.phase !== "pick") throw new Error("tests: expected people");
    return result.output;
  };
  full = await found(12);
  partial = await found(4);
});

function rows(pick: Pick, reusedId?: string): CampaignPerson[] {
  return pick.chosen.map(
    (person) =>
      ({
        id: `cp-${person.lushaId}`,
        status: "chosen",
        rank: person.rank,
        whyPicked: person.whyPicked,
        source: person.lushaId === reusedId ? "reused" : person.source,
        companyKey: person.companyKey,
        rolePart: person.role?.part ?? null,
        roleTitle: person.role?.title ?? null,
        roleMatch: person.role?.how ?? null,
        review: "pending",
        preview: { name: person.name, title: person.title, company: person.company, city: person.city, domain: person.domain, hasEmail: person.hasEmail, emailRevealCredits: person.emailRevealCredits },
      }) as unknown as CampaignPerson,
  );
}

type Stage = {
  job?: Partial<Job> | null;
  result?: { kind: string; output: unknown } | null;
  people?: CampaignPerson[];
  spend?: { charged: number; reserved: number };
  /** Reviewing: what Reveal emails would do for the kept people. */
  revealPlan?: RevealCounts | null;
  /** Once Reveal emails is pressed: the reveal job's status, whether it recorded its result, and its spend. */
  reveal?: { status: Job["status"]; done: boolean; maxCredits: number; charged: number; reserved: number };
  /** Once Write emails is pressed (outreach v2.1): each person's first-email state. */
  outreach?: LeadGenRecord["outreach"];
};

const NO_PLAN: RevealCounts = { kept: 0, known: 0, toReveal: 0, free: 0, maxCredits: 0, noEmail: 0, unavailable: 0 };

/** A planned campaign, confirmed or not, as `toCampaign` reads it from the router's record. */
function campaign(stage: Stage | null, options: LeadGenOptions = AVAILABLE): Campaign {
  const brief = toResearchBrief(briefFields());
  const leadGen: LeadGenRecord | undefined =
    stage === null
      ? undefined
      : {
          confirm: { id: "event-confirm", after: { requestId: "req-confirm", briefVersion: 1, handoff: JSON.parse(JSON.stringify(handoff)), balanceSource: "sample" } } as unknown as Event,
          job: stage.job === null ? null : ({ id: "job-leadgen", status: "done", error: null, ...stage.job } as Job),
          result: stage.result == null ? null : ({ id: "event-result", kind: stage.result.kind, after: { output: stage.result.output } } as unknown as Event),
          people: stage.people ?? [],
          spend: { charged: stage.spend?.charged ?? 0, reserved: stage.spend?.reserved ?? 0, exceededDocumentedWorstCase: false },
          revealPlan: stage.reveal === undefined ? (stage.revealPlan === undefined ? NO_PLAN : stage.revealPlan) : null,
          reveal:
            stage.reveal === undefined
              ? null
              : {
                  confirm: { id: "event-reveal", after: {} } as unknown as Event,
                  after: { maxCredits: stage.reveal.maxCredits } as RevealConfirmed,
                  job: { id: "job-reveal", status: stage.reveal.status, error: null } as Job,
                  result: stage.reveal.done ? ({ id: "event-revealed", kind: "leadgen.revealed", after: {} } as unknown as Event) : null,
                  spend: { charged: stage.reveal.charged, reserved: stage.reveal.reserved, exceededDocumentedWorstCase: false },
                },
          ...(stage.outreach === undefined ? {} : { outreach: stage.outreach }),
        };
  // The credit ledger, grouped as the summary reads it: the search's charge under this Confirm, and the reveal's once pressed.
  const ledger =
    stage === null
      ? []
      : [
          ...(stage.spend === undefined ? [] : [{ briefVersion: 1, kind: "search", state: "reconciled", rows: 1, charged: stage.spend.charged, worstCase: stage.spend.charged, confirmEventId: "event-confirm" }]),
          // Reveal rows count against the reveal approval itself, so a stopped reveal's recovery reads only its own rows.
          ...(stage.reveal === undefined
            ? []
            : [
                ...(stage.reveal.charged > 0 ? [{ briefVersion: 1, kind: "reveal", state: "reconciled", rows: 1, charged: stage.reveal.charged, worstCase: stage.reveal.charged, confirmEventId: "event-reveal" }] : []),
                ...(stage.reveal.reserved > 0 ? [{ briefVersion: 1, kind: "reveal", state: "reserved", rows: 1, charged: 0, worstCase: stage.reveal.reserved, confirmEventId: "event-reveal" }] : []),
              ]),
        ];
  const record = {
    campaign: { id: "camp-people", orgId: "org_ui", ownerUserId: "user_ui", name: "Claims people", briefVersion: 1, brief, startRequestId: "req", createdAt: AT, updatedAt: AT },
    job: { id: "job-research", status: "done", error: null },
    event: { id: "event-research", after: { jobId: "job-research", pack: JSON.parse(JSON.stringify(completePack())) } },
    ledger,
    ...(leadGen === undefined ? {} : { leadGen }),
  } as unknown as CampaignRecord;
  return toCampaign(record, options);
}

const currentStep = () => screen.getAllByTestId("state-step").find((step) => step.getAttribute("aria-current") === "step")?.textContent;

describe("Plan ready: Confirm plan", () => {
  it("shows what Confirm does and lets it be pressed where finding people is set up", async () => {
    const onConfirm = vi.fn(async () => ({ id: "camp-people" }));
    render(<CampaignPage campaign={campaign(null)} onConfirm={onConfirm} />);

    expect(screen.getByTestId("confirm-starts-with").textContent).toContain(handoff.buyerGroup.name);
    expect(screen.getByTestId("confirm-cap").textContent).toBe(`${campaignsCopy.confirmDoesSearch} 40 ${campaignsCopy.confirmCredits}.`);
    expect(screen.getByTestId("confirm-sample").textContent).toBe(campaignsCopy.confirmSample);
    expect(screen.getByTestId("confirm-lawful").textContent).toBe(campaignsCopy.lawfulBasis);
    expect(screen.getByTestId("action-note").textContent).toBe(campaignsCopy.confirmNote);

    fireEvent.click(screen.getByRole("button", { name: campaignsCopy.actionConfirm }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    // Confirm names the play it starts with: the recommended one until the rep picks another (lead gen v2.3).
    expect(onConfirm).toHaveBeenCalledWith({ campaignId: "camp-people", briefVersion: 1, requestId: expect.any(String), candidateId: handoff.play.id });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/campaigns/camp-people?confirmed=1"));
  });

  it("draws Confirm but will not press it where finding people is not set up, and shows no limit", () => {
    const onConfirm = vi.fn();
    render(<CampaignPage campaign={campaign(null, OFF)} onConfirm={onConfirm} />);
    const button = screen.getByRole("button", { name: campaignsCopy.actionConfirm });
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByTestId("action-note").textContent).toBe(campaignsCopy.confirmLater);
    expect(screen.queryByTestId("confirm-cap")).toBeNull();
    expect(screen.queryByTestId("confirm-sample")).toBeNull();
  });
});

describe("Finding people", () => {
  it("says the search is running, accounts first, with the frozen search, its limit and nothing to press", () => {
    render(<CampaignPage campaign={campaign({ job: { status: "running", createdAt: AT } })} />);
    expect(screen.getByTestId("finding-note").textContent).toContain(campaignsCopy.findingRunning);
    expect(screen.getByTestId("finding-note").textContent).toContain(handoff.buyerGroup.name);
    expect(screen.getByTestId("finding-steps").querySelectorAll("li")).toHaveLength(campaignsCopy.findingSteps.length);
    expect(document.body.textContent).toContain(`${campaignsCopy.findingCap}: 40 ${campaignsCopy.confirmCredits}`);
    // The search as Confirm froze it: countries, kinds of organisation, size, the roles, and the firms it starts from. No bar.
    const search = screen.getByTestId("finding-search").textContent ?? "";
    expect(search).toContain("United Kingdom");
    expect(search).toContain(campaignsCopy.findingRolesLead);
    for (const role of handoff.buyerRoles) expect(search).toContain(role.title);
    expect(search).toContain(`${handoff.seedFirms.length} ${campaignsCopy.findingSeedsMany}`);
    expect(screen.getByTestId("finding-started").textContent).toContain(campaignsCopy.findingStartedLead);
    expect(document.querySelector("progress")).toBeNull();
    expect(document.querySelector("[role=progressbar]")).toBeNull();
    expect(currentStep()).toBe(campaignsCopy.stepFindingPeople);
    expect(screen.queryByRole("button", { name: campaignsCopy.actionConfirm })).toBeNull();
  });

  it("says a queued search is waiting, never searching", () => {
    render(<CampaignPage campaign={campaign({ job: { status: "queued" } })} />);
    expect(screen.getByTestId("finding-note").textContent).toContain(campaignsCopy.findingWaiting);
    expect(screen.getByTestId("stage-line").textContent).toBe(campaignsCopy.summaryWaiting);
    expect(screen.queryByTestId("stage-activity")).toBeNull();
  });

  it("no longer says nobody has been found, once the plan is confirmed", () => {
    render(<CampaignPage campaign={campaign({ job: { status: "running" } })} />);
    fireEvent.click(screen.getByTestId("rail-tab-research"));
    fireEvent.click(screen.getByTestId("overview-show"));
    expect(screen.getByText(campaignsCopy.groupsNoteConfirmed)).toBeTruthy();
    expect(screen.getByText(campaignsCopy.firmsNoteConfirmed)).toBeTruthy();
    expect(screen.queryByText(campaignsCopy.groupsNote)).toBeNull();
    expect(screen.queryByText(campaignsCopy.firmsNote)).toBeNull();
  });
});

describe("Plan ready keeps the notes for a plan not yet confirmed", () => {
  it("says nobody has been found yet and people come after Confirm", () => {
    render(<CampaignPage campaign={campaign(null)} />);
    fireEvent.click(screen.getByTestId("rail-tab-research"));
    fireEvent.click(screen.getByTestId("overview-show"));
    expect(screen.getByText(campaignsCopy.groupsNote)).toBeTruthy();
    expect(screen.getByText(campaignsCopy.firmsNote)).toBeTruthy();
  });
});

describe("People found", () => {
  it("lists the people found, N of N, with the spend from the ledger, and Reveal emails not pressable while nobody is kept", () => {
    render(<CampaignPage campaign={campaign({ result: { kind: "leadgen.picked", output: full }, people: rows(full), spend: { charged: 12, reserved: 0 } })} />);
    expect(screen.getByTestId("found-count").textContent).toBe(`10 ${campaignsCopy.peopleFoundOf} 10`);
    fireEvent.click(screen.getByTestId("expand-all"));
    expect(screen.getAllByTestId("found-person")).toHaveLength(10);
    expect(screen.queryByTestId("shortfall")).toBeNull();
    expect(screen.getByTestId("spend-line").textContent).toBe(`${campaignsCopy.spendUsed} 12 ${campaignsCopy.spendOf} 40 ${campaignsCopy.spendCredits} ${campaignsCopy.spendSample}`);
    expect(screen.getByTestId("edit-warning").textContent).toBe(campaignsCopy.editWarning);
    // The rail's Spend tab says the same from the ledger, and marks sample credits.
    fireEvent.click(screen.getByTestId("rail-tab-spend"));
    expect(screen.getByTestId("spend-search").textContent).toBe(`12 ${campaignsCopy.spendCreditsOf} 40 ${campaignsCopy.spendCreditsWord}`);
    expect(screen.getByTestId("spend-sample").textContent).toBe(campaignsCopy.spendSample);
    fireEvent.click(screen.getByTestId("rail-tab-research"));
    const reveal = screen.getByRole("button", { name: campaignsCopy.actionReveal });
    expect(reveal.hasAttribute("disabled")).toBe(true);
    // Unmistakably not pressable: announced as disabled, and never drawn as the filled primary action.
    expect(reveal.getAttribute("aria-disabled")).toBe("true");
    expect(reveal.className).not.toMatch(/\bbg-action\b/);
    expect(reveal.className).toMatch(/\bcursor-not-allowed\b/);
    // It says what the rep needs to do first.
    expect(screen.getByTestId("action-note").textContent).toBe(campaignsCopy.revealKeepFirst);
    expect(currentStep()).toBe(campaignsCopy.stepReviewingPeople);
    // The research folds away once there are accounts to review, one press from open.
    expect(screen.getByTestId("overview-folded")).toBeTruthy();
    expect(screen.queryByTestId("overview")).toBeNull();
    fireEvent.click(screen.getByTestId("overview-show"));
    // Beside "10 of 10", the plan does not also say nobody has been found.
    expect(screen.queryByText(campaignsCopy.groupsNote)).toBeNull();
    expect(screen.getByText(campaignsCopy.groupsNoteConfirmed)).toBeTruthy();
  });

  it("shows a partial result as X of N, and why it ended short", () => {
    render(<CampaignPage campaign={campaign({ result: { kind: "leadgen.picked", output: partial }, people: rows(partial), spend: { charged: 4, reserved: 0 } })} />);
    expect(screen.getByTestId("found-count").textContent).toBe(`4 ${campaignsCopy.peopleFoundOf} 10`);
    expect(screen.getByTestId("shortfall").textContent).toBe(campaignsCopy.shortfallFewerStrong);
  });

  it("marks someone Relay already knows", () => {
    render(<CampaignPage campaign={campaign({ result: { kind: "leadgen.picked", output: full }, people: rows(full, "l-001"), spend: { charged: 12, reserved: 0 } })} />);
    fireEvent.click(screen.getByTestId("expand-all"));
    expect(screen.getAllByText(campaignsCopy.peopleReusedChip)).toHaveLength(1);
  });
});

describe("Finding people needs you", () => {
  const spend = { searchCreditCap: 40, charged: 0, reserved: 0, pricingAssumptions: "x", exceededDocumentedWorstCase: false };

  it("offers the closest industries as words, and searches with the one chosen", async () => {
    const onChooseIndustry = vi.fn(async () => ({ id: "camp-people" }));
    render(
      <CampaignPage
        campaign={campaign({ result: { kind: "leadgen.halted", output: { phase: "needs_you", reason: "choose_industry", field: "industry", term: "Insurance", choices: ["Insurance Brokers", "Reinsurance"], spend } } })}
        onChooseIndustry={onChooseIndustry}
      />,
    );
    expect(screen.getByTestId("people-reason").textContent).toBe(`${campaignsCopy.haltChooseIndustry} Insurance`);
    expect(currentStep()).toBe(campaignsCopy.stepFindingNeedsYou);
    fireEvent.click(screen.getByLabelText("Reinsurance"));
    fireEvent.click(screen.getByRole("button", { name: campaignsCopy.actionSearchWith }));
    await waitFor(() => expect(onChooseIndustry).toHaveBeenCalledTimes(1));
    expect(onChooseIndustry).toHaveBeenCalledWith({ campaignId: "camp-people", briefVersion: 1, requestId: expect.any(String), term: "Insurance", label: "Reinsurance" });
  });

  it("offers Try again after a busy provider", async () => {
    const onRetryPeople = vi.fn(async () => ({ id: "camp-people" }));
    render(
      <CampaignPage campaign={campaign({ result: { kind: "leadgen.halted", output: { phase: "needs_you", reason: "provider_busy", spend } } })} onRetryPeople={onRetryPeople} />,
    );
    expect(screen.getByTestId("people-reason").textContent).toBe(campaignsCopy.haltBusy);
    fireEvent.click(screen.getByRole("button", { name: campaignsCopy.actionTryAgain }));
    await waitFor(() => expect(onRetryPeople).toHaveBeenCalledTimes(1));
  });

  it("sends a search that cannot be run as planned to Edit brief, with no Try again", () => {
    render(<CampaignPage campaign={campaign({ result: { kind: "leadgen.halted", output: { phase: "needs_you", reason: "no_candidates", spend } } })} />);
    expect(screen.getByTestId("people-reason").textContent).toBe(campaignsCopy.haltNoCandidates);
    expect(screen.queryByRole("button", { name: campaignsCopy.actionTryAgain })).toBeNull();
    expect(screen.getByTestId("edit-brief").getAttribute("href")).toBe("/campaigns/camp-people/edit");
  });
});

describe("Reviewing people, accounts first (v2.2 §9a)", () => {
  const reviewed = (pick: Pick, reviews: Record<number, "kept" | "dropped">) =>
    rows(pick).map((row) => ({ ...row, review: reviews[row.rank] ?? "pending" }) as CampaignPerson);
  const found = (people: CampaignPerson[]) => campaign({ result: { kind: "leadgen.picked", output: full }, people, spend: { charged: 12, reserved: 0 } });

  it("leads with accounts, says the plan's search once, and each role's needs once", () => {
    render(<CampaignPage campaign={found(rows(full))} onReview={vi.fn()} />);
    const accounts = screen.getAllByTestId("found-account");
    // One compact row per account; nobody is expanded until asked. Expand all opens the page.
    expect(screen.queryAllByTestId("found-person")).toHaveLength(0);
    fireEvent.click(screen.getByTestId("expand-all"));
    expect(accounts.length).toBeGreaterThan(1);
    expect(screen.getByTestId("accounts-summary").textContent).toContain(`10 ${campaignsCopy.accountsPeopleAt} ${accounts.length} ${campaignsCopy.accountsWord}`);
    // The plan's search, once, above the accounts; never repeated on a card.
    expect(screen.getAllByTestId("search-line")).toHaveLength(1);
    expect(screen.getByTestId("search-line").textContent).toMatch(new RegExp(`^${campaignsCopy.accountFitSearch} United Kingdom, `));
    expect(document.body.textContent?.split(campaignsCopy.accountFitSearch).length).toBe(2);
    // Each role's needs appear exactly once, in the buyer roles summary.
    expect(screen.getByTestId("buyer-roles").textContent).toContain(campaignsCopy.buyerRolesLabel);
    expect(document.body.textContent?.split("Less manual checking.").length).toBe(2);
    // Every person carries the role they play, as a word rather than a chip.
    const chips = screen.getAllByTestId("role-chip").map((chip) => chip.textContent);
    const labels: string[] = [...Object.values(campaignsCopy.roleParts), campaignsCopy.relatedRole];
    expect(chips.every((chip) => labels.includes(chip ?? ""))).toBe(true);
    // Every person carries what Relay actually has on them, never a line that reads the same for everyone.
    const evidence: string[] = [campaignsCopy.evidenceExactTitle, campaignsCopy.evidenceCloseTitle, campaignsCopy.evidenceEmail, campaignsCopy.evidenceNoEmail, campaignsCopy.evidenceSeed, campaignsCopy.evidenceReused];
    const cities = new Set(full.chosen.map((person) => person.city).filter((city): city is string => typeof city === "string"));
    const lines = screen.getAllByTestId("why-fits").map((line) => line.textContent ?? "");
    expect(lines.every((line) => line.split(campaignsCopy.noteJoin).every((part) => evidence.includes(part) || cities.has(part)))).toBe(true);
    expect(lines.some((line) => line.includes(campaignsCopy.evidenceExactTitle))).toBe(true);
    expect(currentStep()).toBe(campaignsCopy.stepReviewingPeople);
  });

  it("offers Drop account only where an account has more than one person", () => {
    render(<CampaignPage campaign={found(rows(full))} onReview={vi.fn()} />);
    fireEvent.click(screen.getByTestId("expand-all"));
    for (const account of screen.getAllByTestId("found-account")) {
      const people = account.querySelectorAll("[data-testid=found-person]").length;
      expect(account.querySelector("[data-testid=drop-account]") !== null).toBe(people > 1);
    }
    expect(screen.getAllByTestId("drop-account").length).toBeGreaterThan(0);
  });

  it("shows no email and no provider id anywhere", () => {
    render(<CampaignPage campaign={found(rows(full))} onReview={vi.fn()} />);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/@/);
    expect(text).not.toMatch(/\bl-0\d\d\b/);
    expect(text).not.toMatch(/company-id:/);
  });

  it("@proof keeps or drops one person, or a whole account, through the server and redraws from it", async () => {
    const onReview = vi.fn(async () => ({ id: "camp-people" }));
    render(<CampaignPage campaign={found(rows(full))} onReview={onReview} />);
    const firstAccount = screen.getAllByTestId("found-account")[0]!;
    // Opened in place: the people and their evidence appear under the account row.
    fireEvent.click(firstAccount.querySelector("[data-testid=account-toggle]")!);
    const firstPerson = firstAccount.querySelector("[data-testid=found-person]")!;
    fireEvent.click(firstPerson.querySelector("[data-testid=keep]")!);
    await waitFor(() => expect(onReview).toHaveBeenCalledTimes(1));
    expect(onReview).toHaveBeenLastCalledWith({ campaignId: "camp-people", briefVersion: 1, personId: expect.stringMatching(/^cp-/), scope: "person", decision: "kept" });
    await waitFor(() => expect(refresh).toHaveBeenCalled());

    fireEvent.click(firstAccount.querySelector("[data-testid=drop-account]")!);
    await waitFor(() => expect(onReview).toHaveBeenCalledTimes(2));
    expect(onReview).toHaveBeenLastCalledWith(expect.objectContaining({ scope: "account", decision: "dropped" }));
  });

  it("shows each decision, counts them, and estimates a reveal for the kept people only", () => {
    const people = reviewed(full, { 1: "kept", 2: "kept", 3: "dropped" });
    render(
      <CampaignPage
        campaign={campaign({ result: { kind: "leadgen.picked", output: full }, people, spend: { charged: 12, reserved: 0 }, revealPlan: { ...NO_PLAN, kept: 2, toReveal: 2, maxCredits: 2 } })}
        onReview={vi.fn()}
      />,
    );
    expect(screen.getByTestId("review-counts").textContent).toContain(
      `2 ${campaignsCopy.reviewCountKept} · 1 ${campaignsCopy.reviewCountDropped} · 7 ${campaignsCopy.reviewCountPending}`,
    );
    // The views count accounts: To review is the default, Kept and Dropped are a press away.
    fireEvent.click(screen.getByTestId("review-view-all"));
    fireEvent.click(screen.getByTestId("expand-all"));
    const states = screen.getAllByTestId("found-person").map((person) => person.getAttribute("data-review"));
    expect(states.filter((state) => state === "kept")).toHaveLength(2);
    expect(states.filter((state) => state === "dropped")).toHaveLength(1);
    expect(screen.getByTestId("reveal-estimate").textContent).toBe(`${campaignsCopy.revealKeptAbout} 2 ${campaignsCopy.revealCredits}`);
    // Reveal emails is pressable only where the page was given a way to send it.
    expect(screen.getByRole("button", { name: campaignsCopy.actionReveal }).hasAttribute("disabled")).toBe(true);
  });

  it("says nothing would be revealed while nobody is kept", () => {
    render(<CampaignPage campaign={found(rows(full))} onReview={vi.fn()} />);
    expect(screen.getByTestId("reveal-estimate").textContent).toBe(campaignsCopy.revealNoneKept);
  });

  it("draws no progress counters: the stage summary says what exists, and nothing downstream", () => {
    render(<CampaignPage campaign={found(rows(full))} onReview={vi.fn()} />);
    expect(screen.queryAllByTestId("progress-count")).toHaveLength(0);
    expect(screen.queryByText(campaignsCopy.progressDrafted)).toBeNull();
    expect(screen.queryByText(campaignsCopy.progressReplied)).toBeNull();
    expect(screen.getByTestId("stage-line").textContent).toContain(`10 ${campaignsCopy.summaryPeople} ${campaignsCopy.summaryAt}`);
    expect(screen.getByTestId("stage-line").textContent).toContain(`10 ${campaignsCopy.summaryToReview}`);
  });

  it("opens on To review, keeps decided accounts in their own views, and counts each view by account", () => {
    const people = reviewed(full, { 1: "kept", 2: "kept", 3: "dropped" });
    const accountsWith = (review: string) => new Set(people.filter((row) => row.review === review).map((row) => row.companyKey)).size;
    render(<CampaignPage campaign={campaign({ result: { kind: "leadgen.picked", output: full }, people, spend: { charged: 12, reserved: 0 } })} onReview={vi.fn()} />);
    const total = new Set(people.map((row) => row.companyKey)).size;
    expect(screen.getAllByTestId("found-account")).toHaveLength(accountsWith("pending"));
    expect(screen.getAllByTestId("found-account").every((account) => ["pending", "mixed"].includes(account.getAttribute("data-state") ?? ""))).toBe(true);
    fireEvent.click(screen.getByTestId("review-view-kept"));
    expect(screen.getAllByTestId("found-account")).toHaveLength(accountsWith("kept"));
    fireEvent.click(screen.getByTestId("review-view-dropped"));
    expect(screen.getAllByTestId("found-account")).toHaveLength(accountsWith("dropped"));
    fireEvent.click(screen.getByTestId("review-view-all"));
    expect(screen.getAllByTestId("found-account")).toHaveLength(total);
  });

  it("searches accounts and people, filters by role and email, and says when nothing matches", () => {
    render(<CampaignPage campaign={found(rows(full))} onReview={vi.fn()} />);
    const total = screen.getAllByTestId("found-account").length;
    fireEvent.change(screen.getByTestId("review-search"), { target: { value: "Firm 7" } });
    expect(screen.getAllByTestId("found-account")).toHaveLength(1);
    fireEvent.change(screen.getByTestId("review-search"), { target: { value: "nobody-by-this-name" } });
    expect(screen.queryAllByTestId("found-account")).toHaveLength(0);
    expect(screen.getByTestId("review-empty").textContent).toBe(campaignsCopy.reviewNoMatch);
    fireEvent.click(screen.getByTestId("review-clear"));
    expect(screen.getAllByTestId("found-account")).toHaveLength(total);
    fireEvent.click(screen.getByTestId("review-role-signs"));
    const signs = screen.getAllByTestId("found-account");
    expect(signs.length).toBeLessThan(total);
    expect(signs.every((account) => account.querySelector("[data-testid=account-coverage]")?.textContent?.includes(campaignsCopy.roleParts.signs))).toBe(true);
    fireEvent.click(screen.getByTestId("review-role-signs"));
    fireEvent.click(screen.getByTestId("review-email"));
    expect(screen.getAllByTestId("found-account").every((account) => account.querySelector("[data-testid=account-coverage]")?.textContent?.includes(campaignsCopy.reviewWithEmail))).toBe(true);
  });

  it("@proof keeps or drops the ticked people in one change, across accounts, then clears the selection", async () => {
    const onReview = vi.fn(async () => ({ id: "camp-people" }));
    render(<CampaignPage campaign={found(rows(full))} onReview={onReview} />);
    expect(screen.queryByTestId("keep-selected")).toBeNull();
    const [first, second] = screen.getAllByTestId("select-account");
    fireEvent.click(first!);
    fireEvent.click(second!);
    const ticked = Number(screen.getByTestId("selection-count").textContent?.replace(/\D/g, ""));
    expect(ticked).toBeGreaterThanOrEqual(2);
    fireEvent.click(screen.getByTestId("keep-selected"));
    await waitFor(() => expect(onReview).toHaveBeenCalledTimes(1));
    const call = (onReview.mock.calls as unknown as [{ scope: string; decision: string; personIds: string[] }][])[0]![0];
    expect(call.scope).toBe("selected");
    expect(call.decision).toBe("kept");
    expect(call.personIds).toHaveLength(ticked);
    await waitFor(() => expect(screen.getByTestId("selection-count").textContent).toContain("0"));
    // Reveal is untouched by selection: still the header's own gate.
    expect(screen.getByRole("button", { name: campaignsCopy.actionReveal })).toBeDefined();
  });

  it("pages by account, twenty to a page, and never splits one", () => {
    const many = Array.from({ length: 50 }, (_, index) => {
      const base = rows(full)[index % 10]!;
      return { ...base, id: `cp-many-${index}`, rank: index + 1, companyKey: `key-${Math.floor(index / 2)}`, preview: { ...(base.preview as object), company: `Account ${Math.floor(index / 2)}`, name: `Person ${index}` } } as CampaignPerson;
    });
    render(<CampaignPage campaign={campaign({ result: { kind: "leadgen.picked", output: full }, people: many, spend: { charged: 12, reserved: 0 } })} onReview={vi.fn()} />);
    expect(screen.getAllByTestId("found-account")).toHaveLength(20);
    expect(screen.getAllByTestId("found-account").every((account) => account.querySelector("[data-testid=account-coverage]")?.textContent?.startsWith(`2 ${campaignsCopy.accountPeople}`))).toBe(true);
    fireEvent.click(screen.getAllByTestId("page-next")[0]!);
    expect(screen.getAllByTestId("found-account")).toHaveLength(5);
    expect(screen.getAllByTestId("found-account")[0]?.textContent).toContain("Account 20");
  });

  it("keeps Keep and Drop quiet until one is chosen", () => {
    render(<CampaignPage campaign={found(rows(full))} onReview={vi.fn()} />);
    fireEvent.click(screen.getByTestId("expand-all"));
    for (const button of screen.getAllByTestId("keep")) expect(button.className).not.toMatch(/\bbg-action\b/);
  });

  it("offers Keep account beside Drop account, only where an account has more than one person", async () => {
    const onReview = vi.fn(async () => ({ id: "camp-people" }));
    render(<CampaignPage campaign={found(rows(full))} onReview={onReview} />);
    fireEvent.click(screen.getByTestId("expand-all"));
    for (const account of screen.getAllByTestId("found-account")) {
      const people = account.querySelectorAll("[data-testid=found-person]").length;
      expect(account.querySelector("[data-testid=keep-account]") !== null).toBe(people > 1);
    }
    fireEvent.click(screen.getAllByTestId("keep-account")[0]!);
    await waitFor(() => expect(onReview).toHaveBeenCalledWith(expect.objectContaining({ scope: "account", decision: "kept" })));
  });
});

describe("Reveal emails (lead gen v2.1 §6, v2.2 §9a)", () => {
  const PLAN: RevealCounts = { kept: 4, known: 1, toReveal: 2, free: 1, maxCredits: 2, noEmail: 1, unavailable: 0 };
  const keptRows = () => rows(full).map((row) => ({ ...row, review: row.rank <= 4 ? "kept" : row.rank === 5 ? "dropped" : "pending" }) as CampaignPerson);
  const reviewing = (plan: RevealCounts) => campaign({ result: { kind: "leadgen.picked", output: full }, people: keptRows(), spend: { charged: 12, reserved: 0 }, revealPlan: plan });

  it("@proof shows who will be bought and the most it can cost, and sends one approval with exactly those figures", async () => {
    const onReveal = vi.fn(async () => ({ id: "camp-people" }));
    render(<CampaignPage campaign={reviewing(PLAN)} onReview={vi.fn()} onReveal={onReveal} />);
    const button = screen.getByRole("button", { name: campaignsCopy.actionReveal });
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(screen.getByTestId("action-note").textContent).toBe(campaignsCopy.revealNote);
    // Pressing Reveal emails buys nothing: it opens the figures.
    fireEvent.click(button);
    expect(onReveal).not.toHaveBeenCalled();
    expect(screen.getByTestId("reveal-kept").textContent).toBe("4");
    expect(screen.getByTestId("reveal-known").textContent).toBe(`1 · ${campaignsCopy.revealNoCredits}`);
    expect(screen.getByTestId("reveal-to-reveal").textContent).toBe(`2 · ${campaignsCopy.revealUpTo} 2 ${campaignsCopy.revealCreditMany}`);
    expect(screen.getByTestId("reveal-no-email").textContent).toBe("1");
    expect(screen.queryByTestId("reveal-unavailable")).toBeNull();
    expect(screen.getByTestId("reveal-free").textContent).toBe(`1 ${campaignsCopy.revealFreeTail}`);
    expect(screen.getByText(campaignsCopy.revealEmailsOnly)).toBeTruthy();

    const confirm = screen.getByTestId("reveal-confirm");
    expect(confirm.textContent).toBe(`${campaignsCopy.revealButtonReveal} 2 ${campaignsCopy.revealButtonEmailMany} ${campaignsCopy.revealUpTo} 2 ${campaignsCopy.revealCreditMany}`);
    fireEvent.click(confirm);
    await waitFor(() => expect(onReveal).toHaveBeenCalledTimes(1));
    expect(onReveal).toHaveBeenCalledWith({ campaignId: "camp-people", briefVersion: 1, requestId: expect.any(String), expected: { toReveal: 2, known: 1, maxCredits: 2 } });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/campaigns/camp-people?revealing=1"));
  });

  it("closes without sending anything, and shows a refusal where the figures changed", async () => {
    const onReveal = vi.fn(async () => ({ error: campaignsCopy.revealChanged }));
    render(<CampaignPage campaign={reviewing(PLAN)} onReview={vi.fn()} onReveal={onReveal} />);
    fireEvent.click(screen.getByRole("button", { name: campaignsCopy.actionReveal }));
    fireEvent.click(screen.getByTestId("reveal-cancel"));
    expect(screen.queryByTestId("reveal-card")).toBeNull();
    expect(onReveal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: campaignsCopy.actionReveal }));
    fireEvent.click(screen.getByTestId("reveal-confirm"));
    await waitFor(() => expect(screen.getByTestId("reveal-error").textContent).toBe(campaignsCopy.revealChanged));
    expect(push).not.toHaveBeenCalled();
  });

  it("says the known-only reveal costs nothing, and says why Reveal cannot be pressed when nothing kept can be revealed", () => {
    const { unmount } = render(<CampaignPage campaign={reviewing({ ...NO_PLAN, kept: 1, known: 1 })} onReview={vi.fn()} onReveal={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: campaignsCopy.actionReveal }));
    expect(screen.getByTestId("reveal-confirm").textContent).toBe(`${campaignsCopy.revealButtonAdd} 1 ${campaignsCopy.revealButtonKnownOne} ${campaignsCopy.revealNoCredits}`);
    unmount();
    render(<CampaignPage campaign={reviewing({ ...NO_PLAN, kept: 2, noEmail: 2 })} onReview={vi.fn()} onReveal={vi.fn()} />);
    expect(screen.getByRole("button", { name: campaignsCopy.actionReveal }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("action-note").textContent).toBe(campaignsCopy.revealNothingToReveal);
  });

  it("while revealing: says so, lists the kept people only, and offers no keep, drop or action", () => {
    render(<CampaignPage campaign={campaign({ result: { kind: "leadgen.picked", output: full }, people: keptRows(), reveal: { status: "running", done: false, maxCredits: 2, charged: 0, reserved: 2 } })} onReview={vi.fn()} onReveal={vi.fn()} />);
    expect(screen.getByTestId("revealing-note").textContent).toBe(campaignsCopy.revealingNote);
    expect(currentStep()).toBe(campaignsCopy.stepRevealing);
    expect(screen.getAllByTestId("found-person")).toHaveLength(4);
    expect(screen.queryByTestId("keep")).toBeNull();
    expect(screen.queryByRole("button", { name: campaignsCopy.actionReveal })).toBeNull();
    expect(screen.getByTestId("reveal-spend").textContent).toBe(`${campaignsCopy.revealUsed} 0 ${campaignsCopy.revealUsedOf} 2 ${campaignsCopy.spendCredits} 2 ${campaignsCopy.spendHeld}`);
  });

  it("@proof once ready: shows each usable email, says plainly why the others have none, and points to outreach without pretending it works", () => {
    const outcomes: Record<number, { reveal: CampaignPerson["reveal"]; revealHold?: string; email?: string }> = {
      1: { reveal: "revealed", email: "person1@firm1.example" },
      2: { reveal: "known", email: "person2@firm2.example" },
      3: { reveal: "no_email", revealHold: "no_email" },
      4: { reveal: "suppressed", revealHold: "opted_out", email: "hidden@firm4.example" },
    };
    const people = keptRows().map((row) => {
      const outcome = outcomes[row.rank];
      return (outcome === undefined ? row : { ...row, reveal: outcome.reveal, revealHold: outcome.revealHold ?? null, person: outcome.email === undefined ? null : { email: outcome.email } }) as CampaignPerson;
    });
    render(<CampaignPage campaign={campaign({ result: { kind: "leadgen.picked", output: full }, people, reveal: { status: "done", done: true, maxCredits: 2, charged: 1, reserved: 0 } })} onReview={vi.fn()} onReveal={vi.fn()} />);

    expect(currentStep()).toBe(campaignsCopy.stepPeopleReady);
    expect(screen.getByTestId("ready-counts").textContent).toBe(`2 ${campaignsCopy.readyEmails} · 2 ${campaignsCopy.readyWithout}`);
    expect(screen.getByTestId("reveal-spend").textContent).toBe(`${campaignsCopy.revealUsed} 1 ${campaignsCopy.revealUsedOf} 2 ${campaignsCopy.spendCredits}`);
    expect(screen.getByTestId("not-kept").textContent).toBe(`6 ${campaignsCopy.accountPeople} ${campaignsCopy.notKept}`);
    expect(screen.getAllByTestId("person-email").map((email) => email.textContent)).toEqual(["person1@firm1.example", "person2@firm2.example"]);
    // A narrow screen may break an address at the @ and nowhere else, and one press selects all of it.
    const email = screen.getAllByTestId("person-email")[0]!;
    expect(email.innerHTML).toBe("person1<wbr>@firm1.example");
    expect(email.className).toMatch(/\bselect-all\b/);
    // An opted-out person's address is never shown, even though Relay holds it.
    expect(document.body.textContent).not.toContain("hidden@firm4.example");
    expect(screen.getAllByTestId("reveal-chip").map((chip) => chip.textContent)).toEqual([
      campaignsCopy.revealChip.revealed,
      campaignsCopy.revealChip.known,
      campaignsCopy.revealChip.no_email,
      campaignsCopy.revealChip.suppressed,
    ]);
    expect(screen.getAllByTestId("reveal-why").map((line) => line.textContent)).toEqual([campaignsCopy.revealWhy.no_email, campaignsCopy.revealWhy.opted_out]);
    // Accounts with an email to write to come first; the rest are folded, a press away.
    expect(screen.getByTestId("ready-accounts").textContent).toContain("person1@firm1.example");
    expect(screen.getByTestId("not-ready").textContent).toContain(campaignsCopy.revealWhy.no_email);
    expect(screen.getByTestId("not-ready").textContent).not.toContain("@");
    expect(screen.queryByTestId("keep")).toBeNull();
    expect(screen.queryByTestId("why-fits")).toBeNull();
    // Outreach is obviously next, and obviously not built.
    expect(screen.getByTestId("outreach-next").textContent).toContain(campaignsCopy.outreachNextLabel);
    const write = screen.getByRole("button", { name: campaignsCopy.actionWriteEmails });
    expect(write.hasAttribute("disabled")).toBe(true);
    expect(write.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByTestId("action-note").textContent).toBe(campaignsCopy.outreachLater);
    // No drafting, sending or reply counters come back; the rail says what the reveal cost.
    expect(screen.queryAllByTestId("progress-count")).toHaveLength(0);
    fireEvent.click(screen.getByTestId("rail-tab-spend"));
    expect(screen.getByTestId("spend-reveal").textContent).toBe(`1 ${campaignsCopy.spendCreditsOf} 2 ${campaignsCopy.spendCreditsWord}`);
    expect(document.body.textContent).not.toMatch(/phone|mobile/i);
  });

  it("says when a reveal stopped, why, in the backend's words, and offers Try again only where nothing left Relay", async () => {
    const onRetryReveal = vi.fn(async () => ({ id: "camp-people" }));
    const stopped = campaign({ result: { kind: "leadgen.picked", output: full }, people: keptRows(), reveal: { status: "failed", done: false, maxCredits: 2, charged: 0, reserved: 0 } });
    expect(stopped.facts?.stage).toBe("reveal_needs_you");
    render(<CampaignPage campaign={stopped} onRetryReveal={onRetryReveal} />);
    // Never drawn as live work: the stage line and the card both say it stopped, and why.
    expect(screen.getByTestId("reveal-stopped").textContent).toBe(campaignsCopy.revealStoppedRetry);
    expect(screen.queryByTestId("stage-line")).toBeNull();
    expect(screen.queryByTestId("revealing-note")).toBeNull();
    expect(screen.queryByTestId("ready-counts")).toBeNull();
    expect(currentStep()).toBe(campaignsCopy.stepRevealNeedsYou);
    fireEvent.click(screen.getByRole("button", { name: campaignsCopy.actionTryAgain }));
    await waitFor(() => expect(onRetryReveal).toHaveBeenCalledTimes(1));
  });

  it("a reveal that stopped with a request unaccounted for is never an ordinary retry", () => {
    const stopped = campaign({ result: { kind: "leadgen.picked", output: full }, people: keptRows(), reveal: { status: "failed", done: false, maxCredits: 2, charged: 0, reserved: 2 } });
    expect(stopped.facts?.attention?.reason).toBe("reveal_spend_unresolved");
    render(<CampaignPage campaign={stopped} onRetryReveal={vi.fn()} />);
    expect(screen.getByTestId("reveal-stopped").textContent).toBe(campaignsCopy.revealStoppedHeld);
    expect(screen.queryByRole("button", { name: campaignsCopy.actionTryAgain })).toBeNull();
    expect(screen.getByText(campaignsCopy.revealNeedsYouNoRetry)).toBeTruthy();
    expect(screen.getByTestId("reveal-edit")).toBeTruthy();
    // The step row says it is stuck too, as the banner does.
    const step = screen.getAllByTestId("state-step").find((item) => item.getAttribute("aria-current") === "step")!;
    expect(step.className).toMatch(/\bbg-warn-bg\b/);
  });
});

describe("People ready: Write emails (outreach v2.1)", () => {
  const keptRows = () => rows(full).map((row) => ({ ...row, review: row.rank <= 4 ? "kept" : "pending" }) as CampaignPerson);
  /** Ranks 1 and 2 have a usable email; 3 has none. */
  const readyRows = () =>
    keptRows().map((row) =>
      row.rank === 1
        ? ({ ...row, reveal: "revealed", person: { email: "person1@firm1.example" } } as CampaignPerson)
        : row.rank === 2
          ? ({ ...row, reveal: "known", person: { email: "person2@firm2.example" } } as CampaignPerson)
          : row.rank === 3
            ? ({ ...row, reveal: "no_email", revealHold: "no_email", person: null } as unknown as CampaignPerson)
            : row,
    );
  const ready = (outreach?: LeadGenRecord["outreach"]) =>
    campaign({ result: { kind: "leadgen.picked", output: full }, people: readyRows(), reveal: { status: "done", done: true, maxCredits: 2, charged: 1, reserved: 0 }, ...(outreach === undefined ? {} : { outreach }) });

  it("@proof says what Write emails does before it runs, and sends one press with the version on screen", async () => {
    const onWriteEmails = vi.fn<(submission: { campaignId: string; briefVersion: number; requestId: string }) => Promise<{ id: string }>>(async () => ({ id: "camp-people" }));
    render(<CampaignPage campaign={ready()} onReview={vi.fn()} onReveal={vi.fn()} onWriteEmails={onWriteEmails} />);

    const write = screen.getByRole("button", { name: campaignsCopy.actionWriteEmailsLive });
    expect(write.hasAttribute("disabled")).toBe(false);
    fireEvent.click(write);

    // The card: how many, what it costs at most, and that nothing is sent.
    expect(screen.getByTestId("write-lead").textContent).toBe(`${campaignsCopy.writeLead} 2 ${campaignsCopy.writePeople}`);
    expect(screen.getByTestId("write-cost").textContent).toBe(`${campaignsCopy.writeCost} $10 ${campaignsCopy.writeCostTail}`);
    expect(onWriteEmails).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("write-confirm"));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/campaigns/camp-people?writing=1"));
    expect(onWriteEmails).toHaveBeenCalledTimes(1);
    expect(onWriteEmails.mock.calls[0]![0]).toMatchObject({ campaignId: "camp-people", briefVersion: 1, requestId: expect.any(String) });
  });

  it("closes the card without writing anything", () => {
    const onWriteEmails = vi.fn();
    render(<CampaignPage campaign={ready()} onReview={vi.fn()} onReveal={vi.fn()} onWriteEmails={onWriteEmails} />);
    fireEvent.click(screen.getByRole("button", { name: campaignsCopy.actionWriteEmailsLive }));
    fireEvent.click(screen.getByTestId("write-cancel"));
    expect(screen.queryByTestId("write-card")).toBeNull();
    expect(onWriteEmails).not.toHaveBeenCalled();
  });

  it("@proof while drafting: counts the first emails by where they are, marks each person, and points to the Inbox", () => {
    const [first, second] = readyRows();
    render(<CampaignPage campaign={ready({ requested: true, byPerson: { [first!.id]: "writing", [second!.id]: "to_review" }, jobs: { queued: 1, running: 0 } })} onReview={vi.fn()} onReveal={vi.fn()} onWriteEmails={vi.fn()} />);

    expect(screen.getByTestId("drafts-counts").textContent).toBe(`${campaignsCopy.summaryWriting} 1 ${campaignsCopy.summaryEmail} · 1 ${campaignsCopy.summaryDraftsToReview}`);
    // The same words on the stage line under the title: one vocabulary for the page, the list and Home.
    expect(screen.getByTestId("stage-line").textContent).toBe(`${campaignsCopy.summaryWriting} 1 ${campaignsCopy.summaryEmail} · 1 ${campaignsCopy.summaryDraftsToReview}`);
    expect(screen.getByTestId("drafts-review").getAttribute("href")).toBe("/inbox");
    expect(screen.getByTestId("drafts-note").textContent).toBe(campaignsCopy.draftingNote);
    expect(screen.getByText(campaignsCopy.draftsNothingSent)).toBeDefined();
    expect(screen.getAllByTestId("draft-chip").map((chip) => chip.textContent).sort()).toEqual([campaignsCopy.draftChip.to_review, campaignsCopy.draftChip.writing].sort());
    // Pressed once per version: no second Write emails, and no "later" placeholder.
    expect(screen.queryByRole("button", { name: campaignsCopy.actionWriteEmailsLive })).toBeNull();
    expect(screen.queryByTestId("outreach-next")).toBeNull();
  });
});
