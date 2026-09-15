import { NO_LEDGER, type LedgerCounts } from "./retry";
import { deriveStage, type StageInput, type StageResult } from "./stage";
import type { CampaignSpendView, CampaignSummaryFacts } from "./types";

/**
 * A campaign's summary facts, from the few numbers it is built on. Pure: the
 * campaign page builds these inputs from the record it has already loaded, and
 * the list builds them from grouped queries (`src/lib/repo/campaignSummary.ts`),
 * so the two cannot count differently.
 */

/** One group of a search's candidates, as a grouped query returns them (or one row, counted once). */
export type PeopleGroup = {
  status: "chosen" | "spare";
  review: "pending" | "kept" | "dropped";
  reveal: "revealed" | "known" | "no_email" | "suppressed" | "held" | "failed" | null;
  rolePart: string | null;
  companyKey: string;
  count: number;
};

/** One group of the campaign's credit ledger. */
export type LedgerGroup = {
  briefVersion: number;
  kind: "search" | "reveal";
  state: "reserved" | "reconciled" | "unreconciled" | "released";
  /** Rows in the group. */
  rows: number;
  /** Sum of `charged` (reconciled rows only carry one). */
  charged: number;
  /** Sum of `worst_case`. */
  worstCase: number;
};

/** Research's recorded model cost for one brief version, in US dollars. */
export type ResearchCost = { briefVersion: number; usd: number };

export type SummaryInput = {
  campaign: { id: string; name: string; briefVersion: number; createdAt: Date; updatedAt: Date };
  stage: StageInput;
  /** Research's result at this version, when it could be read. */
  research: { outcome: "complete" | "partial" | "insufficient"; plays: number; viablePlays: number } | null;
  confirmed: CampaignSummaryFacts["confirmed"];
  /** The latest search's candidates, when it picked people. */
  people: readonly PeopleGroup[] | null;
  spend: CampaignSpendView;
};

export function peopleCountsOf(groups: readonly PeopleGroup[]): NonNullable<CampaignSummaryFacts["people"]> {
  const chosen = groups.filter((group) => group.status === "chosen");
  const roles = new Map<string, Set<string>>();
  for (const group of chosen) {
    const parts = roles.get(group.companyKey) ?? new Set<string>();
    if (group.rolePart !== null) parts.add(group.rolePart);
    roles.set(group.companyKey, parts);
  }
  const sum = (predicate: (group: PeopleGroup) => boolean) => chosen.filter(predicate).reduce((total, group) => total + group.count, 0);
  return {
    accounts: roles.size,
    multiRoleAccounts: [...roles.values()].filter((parts) => parts.size >= 2).length,
    chosen: sum(() => true),
    pending: sum((group) => group.review === "pending"),
    kept: sum((group) => group.review === "kept"),
    dropped: sum((group) => group.review === "dropped"),
  };
}

export function revealCountsOf(groups: readonly PeopleGroup[]): NonNullable<CampaignSummaryFacts["reveal"]> {
  const sum = (reveal: PeopleGroup["reveal"]) => groups.filter((group) => group.status === "chosen" && group.reveal === reveal).reduce((total, group) => total + group.count, 0);
  const revealed = sum("revealed");
  const known = sum("known");
  return { revealed, known, noEmail: sum("no_email"), suppressed: sum("suppressed"), held: sum("held"), failed: sum("failed"), emailsReady: revealed + known };
}

/** The reveal ledger's rows at one brief version, by state: what a stopped reveal's recovery reads. */
export function revealLedgerOf(groups: readonly LedgerGroup[], briefVersion: number): LedgerCounts {
  const counts = { ...NO_LEDGER };
  for (const group of groups) if (group.kind === "reveal" && group.briefVersion === briefVersion) counts[group.state] += group.rows;
  return counts;
}

/**
 * What the campaign has cost, each kind in its own unit. Charged is what the
 * provider reported; held is what an open or unknown request may still have
 * cost, at its worst case. A released request never left Relay and counts for
 * nothing.
 */
export function spendOf(
  groups: readonly LedgerGroup[],
  costs: readonly ResearchCost[],
  current: { briefVersion: number; searchCap: number | null; revealMax: number | null },
): CampaignSpendView {
  const sum = (kind: LedgerGroup["kind"], field: "charged" | "held", version?: number) =>
    groups
      .filter((group) => group.kind === kind && (version === undefined || group.briefVersion === version))
      .reduce((total, group) => total + (field === "charged" ? (group.state === "reconciled" ? group.charged : 0) : group.state === "reserved" || group.state === "unreconciled" ? group.worstCase : 0), 0);
  const usd = (version?: number) => {
    const rows = costs.filter((cost) => version === undefined || cost.briefVersion === version);
    return rows.length === 0 ? null : Math.round(rows.reduce((total, cost) => total + cost.usd, 0) * 1_000_000) / 1_000_000;
  };
  return {
    search: { cap: current.searchCap, charged: sum("search", "charged", current.briefVersion), held: sum("search", "held", current.briefVersion) },
    reveal: { max: current.revealMax, charged: sum("reveal", "charged", current.briefVersion), held: sum("reveal", "held", current.briefVersion) },
    allVersions: { searchCharged: sum("search", "charged"), searchHeld: sum("search", "held"), revealCharged: sum("reveal", "charged"), revealHeld: sum("reveal", "held") },
    research: { usd: usd(), usdThisVersion: usd(current.briefVersion) },
  };
}

export function summaryFactsOf(input: SummaryInput): { facts: CampaignSummaryFacts; derived: StageResult } {
  const derived = deriveStage(input.stage);
  const picked = input.people !== null && (derived.stage === "reviewing_people" || derived.stage === "revealing" || derived.stage === "reveal_needs_you" || derived.stage === "people_ready");
  return {
    derived,
    facts: {
      id: input.campaign.id,
      name: input.campaign.name,
      briefVersion: input.campaign.briefVersion,
      createdAt: input.campaign.createdAt.toISOString(),
      updatedAt: input.campaign.updatedAt.toISOString(),
      stage: derived.stage,
      inFlight: derived.inFlight,
      attention: derived.attention,
      nextAction: derived.nextAction,
      research: input.research,
      confirmed: input.confirmed,
      people: picked && input.people !== null ? peopleCountsOf(input.people) : null,
      reveal: derived.stage === "people_ready" && input.people !== null ? revealCountsOf(input.people) : null,
      spend: input.spend,
    },
  };
}
