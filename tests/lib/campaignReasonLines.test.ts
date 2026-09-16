import { describe, expect, it } from "vitest";

import { HALT_REASONS } from "../../agents/leadgen/output.schema";
import { haltLine, revealStoppedLine } from "@/lib/campaigns/state";
import { reasonLineOf } from "@/lib/campaigns/stageLine";
import type { CampaignSpendView, CampaignSummaryFacts, PeopleReason, RevealStopReason } from "@/lib/campaigns/types";
import { campaignsCopy as c } from "@/lib/copy/campaigns";

/**
 * The reason-to-copy tables (PR #36 fix round 1): every reason the backend can
 * send maps to one exact line, and a reason outside the contract still reads
 * as the generic line.
 */

const HALT_LINES: [PeopleReason, string][] = [
  ["no_candidates", c.haltNoCandidates],
  ["unmappable", c.haltUnmappable],
  ["would_widen", c.haltWouldWiden],
  ["choose_industry", c.haltChooseIndustry],
  ["over_cap", c.haltOverCap],
  ["balance_unavailable", c.haltBalance],
  ["provider_busy", c.haltBusy],
  ["took_too_long", c.haltTooLong],
  ["failed", c.haltFailed],
];

const REVEAL_LINES: [RevealStopReason, string][] = [
  ["reveal_failed", c.revealStoppedRetry],
  ["reveal_spend_unresolved", c.revealStoppedHeld],
  ["reveal_failed_terminal", c.revealStoppedFailed],
  ["reveal_stopped", c.revealStopped],
];

describe("haltLine", () => {
  it.each(HALT_LINES)("says %s as its own line", (reason, line) => {
    expect(haltLine(reason)).toBe(line);
  });

  it("covers every halt reason the lead gen contract names, and failed", () => {
    expect(HALT_LINES.map(([reason]) => reason).sort()).toEqual([...HALT_REASONS, "failed"].sort());
  });

  it("adds the term only where the line names one", () => {
    expect(haltLine("unmappable", "Atlantis")).toBe(`${c.haltUnmappable} Atlantis`);
    expect(haltLine("choose_industry", "Legal")).toBe(`${c.haltChooseIndustry} Legal`);
    expect(haltLine("unmappable", null)).toBe(c.haltUnmappable);
    expect(haltLine("over_cap", "Legal")).toBe(c.haltOverCap);
  });

  it("reads a reason outside the contract as the generic line", () => {
    expect(haltLine("a_new_reason" as never)).toBe(c.haltFailed);
  });
});

describe("revealStoppedLine", () => {
  it.each(REVEAL_LINES)("says %s as its own line", (reason, line) => {
    expect(revealStoppedLine(reason)).toBe(line);
  });

  it("reads no reason, or one outside the contract, as the generic line", () => {
    expect(revealStoppedLine(null)).toBe(c.revealStopped);
    expect(revealStoppedLine(undefined)).toBe(c.revealStopped);
    expect(revealStoppedLine("reveal_new" as never)).toBe(c.revealStopped);
  });
});

const NO_SPEND: CampaignSpendView = { search: { cap: null, charged: 0, held: 0 }, reveal: { max: null, charged: 0, held: 0 }, allVersions: { searchCharged: 0, searchHeld: 0, revealCharged: 0, revealHeld: 0 }, research: { usd: null, usdThisVersion: null } };
const BASE = { id: "c", name: "C", briefVersion: 1, createdAt: "2026-09-16T00:00:00Z", updatedAt: "2026-09-16T00:00:00Z", inFlight: null, nextAction: null, research: null, confirmed: null, people: null, reveal: null, spend: NO_SPEND } as const;

describe("reasonLineOf", () => {
  it("reads each stage's reason with that stage's line", () => {
    const research: CampaignSummaryFacts = { ...BASE, stage: "research_needs_you", attention: { kind: "needs_you", reason: "no_play", retryable: false } };
    const stopped: CampaignSummaryFacts = { ...BASE, stage: "research_stopped", attention: { kind: "stopped", reason: "insufficient", retryable: false } };
    const people: CampaignSummaryFacts = { ...BASE, stage: "people_needs_you", attention: { kind: "needs_you", reason: "over_cap", retryable: false } };
    const reveal: CampaignSummaryFacts = { ...BASE, stage: "reveal_needs_you", attention: { kind: "needs_you", reason: "reveal_spend_unresolved", retryable: false } };
    expect(reasonLineOf(research)).toBe(c.failedNoPlay);
    expect(reasonLineOf(stopped)).toBe(c.stopBanner);
    expect(reasonLineOf(people)).toBe(c.haltOverCap);
    expect(reasonLineOf(reveal)).toBe(c.revealStoppedHeld);
  });

  it("has nothing to say for a stage that does not need the rep", () => {
    expect(reasonLineOf({ ...BASE, stage: "finding_people", attention: null })).toBeNull();
  });
});
