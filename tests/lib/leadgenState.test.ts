import { describe, expect, it } from "vitest";

import { deriveLeadGen } from "@/lib/campaigns/derive";
import { actionFor, chipFor, nextFor, stepIndexFor, CAMPAIGN_STEPS } from "@/lib/campaigns/state";
import { campaignsCopy } from "@/lib/copy/campaigns";

/** Finding people's state, derived from the job and its result (lead gen v2.1 §11). */

const pick = {
  phase: "pick",
  chosen: [
    {
      id: "l-1",
      lushaId: "l-1",
      name: "Person 1",
      title: "Head of Claims",
      company: "Firm 1",
      country: "GB",
      hasEmail: true,
      score: 5,
      whyPicked: "Exact title match, with an email available.",
      rank: 1,
      companyKey: "firm1.co.uk",
      source: "bought",
    },
  ],
  spare: [],
  found: { n: 1, ofM: 10 },
  shortfall: "no_more_results",
  spend: { searchCreditCap: 40, charged: 1, reserved: 0, pricingAssumptions: "x", exceededDocumentedWorstCase: false },
  revealEstimate: { toBuy: 1, reused: 0, credits: 1 },
  holdsApplied: [],
};
const halt = (reason: string, extra: Record<string, unknown> = {}) => ({
  kind: "leadgen.halted",
  after: { output: { phase: "needs_you", reason, ...extra, spend: pick.spend } },
});

describe("deriveLeadGen", () => {
  it("is finding people while the job is queued or running, with no result", () => {
    expect(deriveLeadGen({ status: "queued", error: null }, null)).toEqual({ state: "findingPeople" });
    expect(deriveLeadGen({ status: "running", error: null }, null)).toEqual({ state: "findingPeople" });
  });

  it("is People found once the job recorded people, whatever the job says", () => {
    const state = deriveLeadGen({ status: "running", error: null }, { kind: "leadgen.picked", after: { output: pick } });
    expect(state.state).toBe("peopleFound");
  });

  it("offers Try again for a busy provider, a timeout or a failed job, and a choice for choose_industry", () => {
    expect(deriveLeadGen({ status: "done", error: null }, halt("provider_busy"))).toMatchObject({ state: "peopleNeedsYou", retryable: true, choosable: false });
    expect(deriveLeadGen({ status: "done", error: null }, halt("took_too_long"))).toMatchObject({ retryable: true });
    expect(deriveLeadGen({ status: "failed", error: "lead gen: took_too_long" }, null)).toMatchObject({ state: "peopleNeedsYou", reason: "took_too_long", retryable: true });
    expect(deriveLeadGen({ status: "failed", error: "boom" }, null)).toMatchObject({ reason: "failed", retryable: true });
    expect(deriveLeadGen({ status: "done", error: null }, halt("choose_industry", { term: "Insurance", choices: ["Insurance Brokers"] }))).toMatchObject({
      reason: "choose_industry",
      choosable: true,
      choices: ["Insurance Brokers"],
    });
  });

  it("sends the rest to Edit brief: nothing to try again", () => {
    for (const reason of ["no_candidates", "unmappable", "would_widen", "over_cap"]) {
      expect(deriveLeadGen({ status: "done", error: null }, halt(reason))).toMatchObject({ retryable: false, choosable: false });
    }
    expect(deriveLeadGen({ status: "done", error: null }, null)).toMatchObject({ reason: "failed", retryable: false });
    expect(deriveLeadGen({ status: "done", error: null }, { kind: "leadgen.picked", after: { output: { phase: "pick" } } })).toMatchObject({ reason: "failed" });
  });
});

describe("the new states on the line", () => {
  it("marks Finding people for People found and for its Needs you, and names each", () => {
    expect(stepIndexFor("peopleFound")).toBe(CAMPAIGN_STEPS.indexOf("findingPeople"));
    expect(stepIndexFor("peopleNeedsYou")).toBe(CAMPAIGN_STEPS.indexOf("findingPeople"));
    expect(chipFor("peopleFound")).toBe(campaignsCopy.chipPeopleFound);
    expect(chipFor("peopleNeedsYou")).toBe(campaignsCopy.chipNeedsYou);
  });

  it("draws Reveal emails and never lets it be pressed yet", () => {
    expect(actionFor("peopleFound", true)).toMatchObject({ kind: "reveal", disabled: true, note: campaignsCopy.revealLater });
  });

  it("lets Confirm be pressed only where finding people is set up", () => {
    expect(actionFor("planReady", true, false, { confirm: true })).toMatchObject({ kind: "confirm", note: campaignsCopy.confirmNote });
    expect(actionFor("planReady", true, false, { confirm: true })?.disabled).toBeUndefined();
    expect(actionFor("planReady", true)).toMatchObject({ kind: "confirm", disabled: true, note: campaignsCopy.confirmLater });
    expect(actionFor("peopleNeedsYou", true, false, { retryPeople: true })).toMatchObject({ kind: "retryPeople" });
    expect(actionFor("peopleNeedsYou", true)).toBeNull();
  });

  it("says where the campaign is on the list", () => {
    const counts = { progress: null, outcomes: null, draftsDueToday: 0, nextBatch: null, credits: null, live: true };
    expect(nextFor("findingPeople", counts).next).toBe(campaignsCopy.nextFindingPeopleLive);
    expect(nextFor("peopleFound", counts)).toEqual({ next: campaignsCopy.nextPeopleFound, nextIsAction: false });
    expect(nextFor("peopleNeedsYou", counts)).toEqual({ next: campaignsCopy.nextPeopleNeedsYou, nextIsAction: true });
  });
});
