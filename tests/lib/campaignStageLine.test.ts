import { describe, expect, it } from "vitest";

import { BUCKETS, bucketOf, countBuckets, countsLineOf, groupLabelOf, listSpendLineOf } from "@/lib/campaigns/stageLine";
import type { CampaignSpendView, CampaignStageAttention, CampaignSummary, CampaignSummaryFacts } from "@/lib/campaigns/types";
import { campaignsCopy } from "@/lib/copy/campaigns";

const NO_SPEND: CampaignSpendView = { search: { cap: null, charged: 0, held: 0 }, reveal: { max: null, charged: 0, held: 0 }, allVersions: { searchCharged: 0, searchHeld: 0, revealCharged: 0, revealHeld: 0 }, research: { usd: null, usdThisVersion: null } };
/** A fixture's overrides: any field, with a stage and attention that belong together. */
type FactsOver = Partial<Omit<CampaignSummaryFacts, "stage" | "attention">> & Partial<CampaignStageAttention>;
// The spread cannot carry the stage/attention pairing through to the result; `FactsOver` checks it at each call.
const facts = (over: FactsOver): CampaignSummaryFacts => ({
  id: "c",
  name: "C",
  briefVersion: 1,
  createdAt: "2026-09-14T00:00:00Z",
  updatedAt: "2026-09-14T00:00:00Z",
  stage: "researching",
  inFlight: null,
  attention: null,
  nextAction: null,
  research: null,
  confirmed: null,
  people: null,
  reveal: null,
  spend: NO_SPEND,
  ...over,
}) as CampaignSummaryFacts;
const row = (over: FactsOver): Pick<CampaignSummary, "facts" | "state"> => ({ facts: facts(over), state: "researching" });

/** One vocabulary for Home and Campaigns (final MVP pass): the group a campaign sits in is one function, and the words are one table. */
describe("one attention vocabulary", () => {
  it("puts every stage in one of five groups, attention first", () => {
    expect(bucketOf(facts({ stage: "research_needs_you", attention: { kind: "needs_you", reason: "failed", retryable: true } }))).toBe("needsYou");
    expect(bucketOf(facts({ stage: "research_stopped", attention: { kind: "stopped", reason: "insufficient", retryable: false } }))).toBe("needsYou");
    expect(bucketOf(facts({ stage: "plan_ready" }))).toBe("decide");
    expect(bucketOf(facts({ stage: "reviewing_people" }))).toBe("decide");
    expect(bucketOf(facts({ stage: "people_ready" }))).toBe("ready");
    for (const stage of ["researching", "finding_people", "revealing"] as const) expect(bucketOf(facts({ stage }))).toBe("working");
  });

  it("names the groups and counts them in the same order everywhere", () => {
    expect(BUCKETS.map(groupLabelOf)).toEqual([campaignsCopy.groupNeedsYou, campaignsCopy.groupDecide, campaignsCopy.groupReady, campaignsCopy.groupWorking, campaignsCopy.groupDone]);
    const counts = countBuckets([row({ stage: "plan_ready" }), row({ stage: "researching" }), row({ stage: "people_ready" })]);
    expect(countsLineOf(counts)).toBe(`1 ${campaignsCopy.bucketDecide}${campaignsCopy.noteJoin}1 ${campaignsCopy.bucketReady}${campaignsCopy.noteJoin}1 ${campaignsCopy.bucketWorking}`);
  });

  it("adds spend across campaigns in its own units, and says nothing while nothing was spent", () => {
    expect(listSpendLineOf([row({}), row({})])).toBeNull();
    const line = listSpendLineOf([
      row({ spend: { ...NO_SPEND, allVersions: { searchCharged: 18, searchHeld: 0, revealCharged: 3, revealHeld: 0 }, research: { usd: 16.03, usdThisVersion: 16.03 } } }),
      row({ spend: { ...NO_SPEND, allVersions: { searchCharged: 3, searchHeld: 0, revealCharged: 0, revealHeld: 0 }, research: { usd: null, usdThisVersion: null } } }),
    ]);
    expect(line).toBe(`${campaignsCopy.listSpendLead} 21 ${campaignsCopy.listSpendSearch}${campaignsCopy.noteJoin}3 ${campaignsCopy.listSpendReveal}${campaignsCopy.noteJoin}$16.03 ${campaignsCopy.listSpendResearch}`);
  });
});
