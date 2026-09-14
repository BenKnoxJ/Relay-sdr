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
import type { LeadGenRecord } from "@/lib/repo/leadgen";
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
    const provider = new FakeLeadGenProvider([{ candidates: Array.from({ length: count }, (_, index) => candidate(index + 1, { title: ROLE_TITLES[(index + 1) % ROLE_TITLES.length] })), charged: count, hasMore: false }]);
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

type Stage = { job?: Partial<Job> | null; result?: { kind: string; output: unknown } | null; people?: CampaignPerson[]; spend?: { charged: number; reserved: number } };

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
        };
  const record = {
    campaign: { id: "camp-people", orgId: "org_ui", ownerUserId: "user_ui", name: "Claims people", briefVersion: 1, brief, startRequestId: "req", createdAt: AT, updatedAt: AT },
    job: { id: "job-research", status: "done", error: null },
    event: { id: "event-research", after: { jobId: "job-research", pack: JSON.parse(JSON.stringify(completePack())) } },
    ...(leadGen === undefined ? {} : { leadGen }),
  } as unknown as CampaignRecord;
  return toCampaign(record, options);
}

const currentStep = () => screen.getAllByTestId("state-step").find((step) => step.getAttribute("aria-current") === "step")?.textContent;

describe("Plan ready: Confirm plan", () => {
  it("shows what Confirm does and lets it be pressed where finding people is set up", async () => {
    const onConfirm = vi.fn(async () => ({ id: "camp-people" }));
    render(<CampaignPage campaign={campaign(null)} onConfirm={onConfirm} />);

    expect(screen.getByTestId("confirm-group").textContent).toBe(handoff.buyerGroup.name);
    expect(screen.getByTestId("confirm-cap").textContent).toBe(`40 ${campaignsCopy.confirmCredits}`);
    expect(screen.getByTestId("confirm-sample").textContent).toBe(campaignsCopy.confirmSample);
    expect(screen.getByTestId("confirm-lawful").textContent).toBe(campaignsCopy.lawfulBasis);
    expect(screen.getByTestId("action-note").textContent).toBe(campaignsCopy.confirmNote);

    fireEvent.click(screen.getByRole("button", { name: campaignsCopy.actionConfirm }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm).toHaveBeenCalledWith({ campaignId: "camp-people", briefVersion: 1, requestId: expect.any(String) });
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
  it("says Relay is finding people, with nothing to press", () => {
    render(<CampaignPage campaign={campaign({ job: { status: "running" } })} />);
    expect(screen.getByTestId("finding-note").textContent).toBe(campaignsCopy.findingNote);
    expect(currentStep()).toBe(campaignsCopy.stepFindingPeople);
    expect(screen.queryByRole("button", { name: campaignsCopy.actionConfirm })).toBeNull();
  });

  it("no longer says people are found after you confirm, once the plan is confirmed", () => {
    render(<CampaignPage campaign={campaign({ job: { status: "running" } })} />);
    expect(screen.getByText(campaignsCopy.peopleAfterConfirm)).toBeTruthy();
    expect(screen.queryByText(campaignsCopy.peopleBeforeConfirm)).toBeNull();
    expect(screen.getByText(campaignsCopy.groupsNoteConfirmed)).toBeTruthy();
    expect(screen.getByText(campaignsCopy.firmsNoteConfirmed)).toBeTruthy();
    expect(screen.queryByText(campaignsCopy.groupsNote)).toBeNull();
    expect(screen.queryByText(campaignsCopy.firmsNote)).toBeNull();
  });
});

describe("Plan ready keeps the notes for a plan not yet confirmed", () => {
  it("says nobody has been found yet and people come after Confirm", () => {
    render(<CampaignPage campaign={campaign(null)} />);
    expect(screen.getByText(campaignsCopy.peopleBeforeConfirm)).toBeTruthy();
    expect(screen.getByText(campaignsCopy.groupsNote)).toBeTruthy();
    expect(screen.getByText(campaignsCopy.firmsNote)).toBeTruthy();
  });
});

describe("People found", () => {
  it("lists the people found, N of N, with the spend from the ledger and Reveal emails drawn but not pressable", () => {
    render(<CampaignPage campaign={campaign({ result: { kind: "leadgen.picked", output: full }, people: rows(full), spend: { charged: 12, reserved: 0 } })} />);
    expect(screen.getByTestId("found-count").textContent).toBe(`10 ${campaignsCopy.peopleFoundOf} 10`);
    expect(screen.getAllByTestId("found-person")).toHaveLength(10);
    expect(screen.queryByTestId("shortfall")).toBeNull();
    expect(screen.getByTestId("spend-line").textContent).toBe(`${campaignsCopy.spendUsed} 12 ${campaignsCopy.spendOf} 40 ${campaignsCopy.spendCredits}`);
    expect(screen.getByTestId("spend-sample").textContent).toBe(campaignsCopy.spendSample);
    expect(screen.getByTestId("edit-warning").textContent).toBe(campaignsCopy.editWarning);
    const reveal = screen.getByRole("button", { name: campaignsCopy.actionReveal });
    expect(reveal.hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("action-note").textContent).toBe(campaignsCopy.revealLater);
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
    expect(screen.getByTestId("shortfall").textContent).toBe(campaignsCopy.shortfallNoMore);
  });

  it("marks someone Relay already knows", () => {
    render(<CampaignPage campaign={campaign({ result: { kind: "leadgen.picked", output: full }, people: rows(full, "l-001"), spend: { charged: 12, reserved: 0 } })} />);
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

  it("leads with accounts: who is at each, the roles they cover, and why the account belongs", () => {
    render(<CampaignPage campaign={found(rows(full))} onReview={vi.fn()} />);
    const accounts = screen.getAllByTestId("found-account");
    expect(accounts.length).toBeGreaterThan(1);
    expect(screen.getByTestId("accounts-summary").textContent).toContain(`10 ${campaignsCopy.accountsPeopleAt} ${accounts.length} ${campaignsCopy.accountsWord}`);
    for (const account of accounts) {
      expect(account.querySelector("[data-testid=account-fit]")?.textContent).toMatch(new RegExp(`^${campaignsCopy.accountFitSearch} United Kingdom, `));
    }
    // Every person carries the role they play, with that role's needs as why they fit.
    const chips = screen.getAllByTestId("role-chip").map((chip) => chip.textContent);
    const labels: string[] = [...Object.values(campaignsCopy.roleParts), campaignsCopy.relatedRole];
    expect(chips.every((chip) => labels.includes(chip ?? ""))).toBe(true);
    expect(screen.getAllByTestId("why-fits").some((line) => line.textContent?.includes("Less manual checking."))).toBe(true);
    expect(currentStep()).toBe(campaignsCopy.stepReviewingPeople);
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
    render(<CampaignPage campaign={found(reviewed(full, { 1: "kept", 2: "kept", 3: "dropped" }))} onReview={vi.fn()} />);
    expect(screen.getByTestId("review-counts").textContent).toBe(
      `2 ${campaignsCopy.reviewCountKept} · 1 ${campaignsCopy.reviewCountDropped} · 7 ${campaignsCopy.reviewCountPending}`,
    );
    const states = screen.getAllByTestId("found-person").map((person) => person.getAttribute("data-review"));
    expect(states.filter((state) => state === "kept")).toHaveLength(2);
    expect(states.filter((state) => state === "dropped")).toHaveLength(1);
    expect(screen.getByTestId("reveal-estimate").textContent).toBe(`${campaignsCopy.revealKeptAbout} 2 ${campaignsCopy.revealCredits}`);
    // Reveal is still not pressable.
    expect(screen.getByRole("button", { name: campaignsCopy.actionReveal }).hasAttribute("disabled")).toBe(true);
  });

  it("says nothing would be revealed while nobody is kept", () => {
    render(<CampaignPage campaign={found(rows(full))} onReview={vi.fn()} />);
    expect(screen.getByTestId("reveal-estimate").textContent).toBe(campaignsCopy.revealNoneKept);
  });

  it("shows only Found in progress until drafting, sending and replies exist", () => {
    render(<CampaignPage campaign={found(rows(full))} onReview={vi.fn()} />);
    expect(screen.getAllByTestId("progress-count")).toHaveLength(1);
    expect(screen.queryByText(campaignsCopy.progressDrafted)).toBeNull();
    expect(screen.queryByText(campaignsCopy.progressReplied)).toBeNull();
  });
});
