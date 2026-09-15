import { describe, expect, it } from "vitest";

import { leadGenRetryable, NO_LEDGER, researchRetryable, revealRecovery, type LedgerCounts } from "@/lib/campaigns/retry";
import { deriveStage, isAttention, type StageInput } from "@/lib/campaigns/stage";
import { revealLedgerOf, type LedgerGroup } from "@/lib/campaigns/summary";
import { listCounts } from "@/lib/campaigns/view";
import type { CampaignStage } from "@/lib/campaigns/types";

/**
 * One derivation for where a campaign is, what needs the rep and what the
 * server will accept (product-truth foundation), table by table: research's
 * job and result, the Confirm, the search's job and result, the reveal's job,
 * result and ledger.
 */

type Status = "queued" | "running" | "done" | "failed" | "cancelled";
const job = (status: Status, error: string | null = null) => ({ status, error });

const planned = (over: Partial<StageInput> = {}): StageInput => ({
  research: { job: job("done"), result: { readable: true, outcome: "complete", executablePlays: 3 } },
  confirmed: false,
  leadGen: null,
  reveal: null,
  revealPlan: null,
  leadGenAvailable: true,
  outreach: null,
  ...over,
});
const confirmed = (leadGen: StageInput["leadGen"], over: Partial<StageInput> = {}): StageInput => planned({ confirmed: true, leadGen, ...over });
const picked = (reveal: StageInput["reveal"], over: Partial<StageInput> = {}): StageInput => confirmed({ job: job("done"), result: { kind: "picked" } }, { reveal, ...over });
const ledger = (over: Partial<LedgerCounts>): LedgerCounts => ({ ...NO_LEDGER, ...over });

type Row = {
  name: string;
  input: StageInput;
  stage: CampaignStage;
  state: string;
  attention?: { kind: string; reason: string; retryable: boolean } | null;
  next: string | null;
  can?: Partial<Record<"widen" | "edit" | "retry" | "confirm" | "retryPeople" | "chooseIndustry" | "review" | "reveal" | "retryReveal", boolean>>;
  inFlight?: { kind: string; status: string } | null;
};

const ROWS: Row[] = [
  // Research.
  { name: "no research job", input: planned({ research: { job: null, result: null } }), stage: "research_needs_you", state: "failed", attention: { kind: "needs_you", reason: "not_started", retryable: false }, next: "edit_brief", can: { retry: false, edit: true } },
  { name: "research queued", input: planned({ research: { job: job("queued"), result: null } }), stage: "researching", state: "researching", attention: null, next: null, inFlight: { kind: "research", status: "queued" }, can: { edit: false } },
  { name: "research running", input: planned({ research: { job: job("running"), result: null } }), stage: "researching", state: "researching", next: null, inFlight: { kind: "research", status: "running" }, can: { edit: false } },
  { name: "research failed", input: planned({ research: { job: job("failed", "research: took_too_long — rail"), result: null } }), stage: "research_needs_you", state: "failed", attention: { kind: "needs_you", reason: "took_too_long", retryable: true }, next: "retry_research", can: { retry: true, edit: true } },
  { name: "research cancelled", input: planned({ research: { job: job("cancelled"), result: null } }), stage: "research_needs_you", state: "failed", attention: { kind: "needs_you", reason: "failed", retryable: false }, next: "edit_brief", can: { retry: false } },
  { name: "research done with no result", input: planned({ research: { job: job("done"), result: null } }), stage: "research_needs_you", state: "failed", attention: { kind: "needs_you", reason: "bad_output", retryable: false }, next: "edit_brief" },
  { name: "research result unreadable", input: planned({ research: { job: job("done"), result: { readable: false } } }), stage: "research_needs_you", state: "failed", attention: { kind: "needs_you", reason: "bad_output", retryable: false }, next: "edit_brief" },
  { name: "a stop with options", input: planned({ research: { job: job("done"), result: { readable: true, outcome: "insufficient", usableWidenings: 2 } } }), stage: "research_stopped", state: "stopped", attention: { kind: "stopped", reason: "insufficient", retryable: false }, next: "widen", can: { widen: true, edit: true } },
  { name: "a stop with no usable option", input: planned({ research: { job: job("done"), result: { readable: true, outcome: "insufficient", usableWidenings: 0 } } }), stage: "research_stopped", state: "stopped", next: "edit_brief", can: { widen: false } },
  { name: "a partial pack with no play to search", input: planned({ research: { job: job("done"), result: { readable: true, outcome: "partial", executablePlays: 0 } } }), stage: "research_needs_you", state: "failed", attention: { kind: "needs_you", reason: "no_play", retryable: false }, next: "edit_brief", can: { confirm: false, retry: false } },
  { name: "a complete pack with no play to search", input: planned({ research: { job: job("done"), result: { readable: true, outcome: "complete", executablePlays: 0 } } }), stage: "research_needs_you", state: "failed", next: "edit_brief", can: { confirm: false } },
  { name: "a partial plan with a play", input: planned({ research: { job: job("done"), result: { readable: true, outcome: "partial", executablePlays: 1 } } }), stage: "plan_ready", state: "planReady", attention: null, next: "confirm", can: { confirm: true, edit: true } },
  { name: "a plan where finding people is not set up", input: planned({ leadGenAvailable: false }), stage: "plan_ready", state: "planReady", next: null, can: { confirm: false } },
  // Finding people.
  { name: "search queued", input: confirmed({ job: job("queued"), result: null }), stage: "finding_people", state: "findingPeople", next: null, inFlight: { kind: "lead_gen", status: "queued" }, can: { edit: false, confirm: false } },
  { name: "search running", input: confirmed({ job: job("running"), result: null }), stage: "finding_people", state: "findingPeople", next: null, inFlight: { kind: "lead_gen", status: "running" } },
  { name: "provider busy", input: confirmed({ job: job("done"), result: { kind: "halted", reason: "provider_busy", choices: 0 } }), stage: "people_needs_you", state: "peopleNeedsYou", attention: { kind: "needs_you", reason: "provider_busy", retryable: true }, next: "retry_people", can: { retryPeople: true } },
  { name: "choose an industry", input: confirmed({ job: job("done"), result: { kind: "halted", reason: "choose_industry", choices: 3 } }), stage: "people_needs_you", state: "peopleNeedsYou", next: "choose_industry", can: { retryPeople: false, chooseIndustry: true } },
  { name: "over the cap", input: confirmed({ job: job("done"), result: { kind: "halted", reason: "over_cap", choices: 0 } }), stage: "people_needs_you", state: "peopleNeedsYou", attention: { kind: "needs_you", reason: "over_cap", retryable: false }, next: "edit_brief", can: { retryPeople: false, chooseIndustry: false, edit: true } },
  { name: "search job failed", input: confirmed({ job: job("failed", "lease expired"), result: null }), stage: "people_needs_you", state: "peopleNeedsYou", attention: { kind: "needs_you", reason: "failed", retryable: true }, next: "retry_people" },
  { name: "search job cancelled", input: confirmed({ job: job("cancelled"), result: null }), stage: "people_needs_you", state: "peopleNeedsYou", attention: { kind: "needs_you", reason: "failed", retryable: true }, next: "retry_people" },
  { name: "search job failed terminally", input: confirmed({ job: job("failed", "lead gen: no people provider is set up"), result: null }), stage: "people_needs_you", state: "peopleNeedsYou", attention: { kind: "needs_you", reason: "failed", retryable: false }, next: "edit_brief", can: { retryPeople: false } },
  { name: "search done with no result", input: confirmed({ job: job("done"), result: null }), stage: "people_needs_you", state: "peopleNeedsYou", next: "edit_brief", can: { retryPeople: false } },
  { name: "confirmed with no search job", input: confirmed({ job: null, result: null }), stage: "people_needs_you", state: "peopleNeedsYou", next: "edit_brief", can: { retryPeople: false } },
  { name: "a search result Relay could not read", input: confirmed({ job: job("done"), result: { kind: "unreadable" } }), stage: "people_needs_you", state: "peopleNeedsYou", attention: { kind: "needs_you", reason: "failed", retryable: false }, next: "edit_brief" },
  // Reviewing people and Reveal.
  { name: "people found, nobody kept yet", input: picked(null), stage: "reviewing_people", state: "peopleFound", attention: null, next: "review_people", can: { review: true, reveal: false, edit: true } },
  { name: "people found, somebody kept to reveal", input: picked(null, { revealPlan: { kept: 2, toReveal: 2, known: 0 } }), stage: "reviewing_people", state: "peopleFound", next: "review_people", can: { reveal: true } },
  { name: "people found, kept but nothing to reveal", input: picked(null, { revealPlan: { kept: 2, toReveal: 0, known: 0 } }), stage: "reviewing_people", state: "peopleFound", next: "review_people", can: { reveal: false } },
  { name: "reveal queued", input: picked({ job: job("queued"), hasResult: false, ledger: NO_LEDGER }), stage: "revealing", state: "revealing", next: null, inFlight: { kind: "reveal", status: "queued" }, can: { edit: false, review: false } },
  { name: "reveal running", input: picked({ job: job("running"), hasResult: false, ledger: ledger({ reserved: 1 }) }), stage: "revealing", state: "revealing", next: null, inFlight: { kind: "reveal", status: "running" }, can: { edit: false } },
  { name: "reveal failed, nothing left Relay", input: picked({ job: job("failed", "sample: provider down"), hasResult: false, ledger: NO_LEDGER }), stage: "reveal_needs_you", state: "revealing", attention: { kind: "needs_you", reason: "reveal_failed", retryable: true }, next: "retry_reveal", can: { retryReveal: true, edit: true } },
  { name: "reveal failed, every request released", input: picked({ job: job("failed"), hasResult: false, ledger: ledger({ released: 2 }) }), stage: "reveal_needs_you", state: "revealing", next: "retry_reveal", can: { retryReveal: true } },
  { name: "reveal failed with a request unknown", input: picked({ job: job("failed"), hasResult: false, ledger: ledger({ unreconciled: 1, released: 1 }) }), stage: "reveal_needs_you", state: "revealing", attention: { kind: "needs_you", reason: "reveal_spend_unresolved", retryable: false }, next: "edit_brief", can: { retryReveal: false, edit: true } },
  { name: "reveal failed after a charge, with no result", input: picked({ job: job("failed"), hasResult: false, ledger: ledger({ reconciled: 1 }) }), stage: "reveal_needs_you", state: "revealing", attention: { kind: "needs_you", reason: "reveal_spend_unresolved", retryable: false }, next: "edit_brief" },
  { name: "reveal failed terminally", input: picked({ job: job("failed", "reveal: no people provider is set up"), hasResult: false, ledger: NO_LEDGER }), stage: "reveal_needs_you", state: "revealing", attention: { kind: "needs_you", reason: "reveal_failed_terminal", retryable: false }, next: "edit_brief" },
  { name: "reveal cancelled", input: picked({ job: job("cancelled"), hasResult: false, ledger: NO_LEDGER }), stage: "reveal_needs_you", state: "revealing", attention: { kind: "needs_you", reason: "reveal_stopped", retryable: false }, next: "edit_brief" },
  { name: "reveal done with no result", input: picked({ job: job("done"), hasResult: false, ledger: NO_LEDGER }), stage: "reveal_needs_you", state: "revealing", next: "edit_brief", can: { retryReveal: false } },
  { name: "reveal recorded", input: picked({ job: job("done"), hasResult: true, ledger: ledger({ reconciled: 2 }) }), stage: "people_ready", state: "peopleReady", attention: null, next: null, can: { edit: true, retryReveal: false, review: false } },
  // Research wins until there is a plan: a Confirm on an older reading is ignored.
  { name: "a Confirm but research now needs the rep", input: confirmed({ job: job("running"), result: null }, { research: { job: job("done"), result: { readable: false } } }), stage: "research_needs_you", state: "failed", next: "edit_brief" },
];

describe("deriveStage", () => {
  it.each(ROWS)("$name", (row) => {
    const result = deriveStage(row.input);
    expect(result.stage).toBe(row.stage);
    expect(result.state).toBe(row.state);
    expect(result.nextAction).toBe(row.next);
    if (row.attention !== undefined) expect(result.attention).toEqual(row.attention);
    if (row.inFlight !== undefined) expect(result.inFlight).toEqual(row.inFlight);
    if (row.can !== undefined) expect(result.can).toMatchObject(row.can);
  });

  it("never offers an action whose stage does not have it", () => {
    for (const row of ROWS) {
      const { can, stage, attention } = deriveStage(row.input);
      if (can.retry) expect(stage).toBe("research_needs_you");
      if (can.widen) expect(stage).toBe("research_stopped");
      if (can.confirm) expect(stage).toBe("plan_ready");
      if (can.retryPeople || can.chooseIndustry) expect(stage).toBe("people_needs_you");
      if (can.review || can.reveal) expect(stage).toBe("reviewing_people");
      if (can.retryReveal) expect(stage).toBe("reveal_needs_you");
      // Nothing in flight can be edited under it.
      if (stage === "researching" || stage === "finding_people" || stage === "revealing") expect(can.edit).toBe(false);
      // Needing the rep and being in flight never coincide.
      expect(attention !== null && isAttention(stage)).toBe(attention !== null);
    }
  });
});

describe("the shared retry rules", () => {
  it("retries research only as a failed job with no result: what reopenFailed accepts", () => {
    expect(researchRetryable({ status: "failed" }, false)).toBe(true);
    expect(researchRetryable({ status: "failed" }, true)).toBe(false);
    expect(researchRetryable({ status: "cancelled" }, false)).toBe(false);
    expect(researchRetryable({ status: "done" }, false)).toBe(false);
    expect(researchRetryable(null, false)).toBe(false);
  });

  it("retries a search that could come out differently, never one that failed on its own terms", () => {
    expect(leadGenRetryable({ status: "failed", error: "lease expired" }, null)).toBe(true);
    expect(leadGenRetryable({ status: "cancelled", error: null }, null)).toBe(true);
    for (const error of ["lead gen: bad input", "lead gen: the frozen handoff does not parse", "lead gen: the handoff does not belong to this job", "lead gen: the pricing model is not the one Confirm froze", "lead gen: no people provider is set up"]) {
      expect(leadGenRetryable({ status: "failed", error }, null)).toBe(false);
    }
    expect(leadGenRetryable({ status: "done", error: null }, null)).toBe(false);
    expect(leadGenRetryable({ status: "done", error: null }, { kind: "halted", reason: "took_too_long" })).toBe(true);
    expect(leadGenRetryable({ status: "done", error: null }, { kind: "halted", reason: "would_widen" })).toBe(false);
    expect(leadGenRetryable({ status: "done", error: null }, { kind: "picked" })).toBe(false);
  });

  it("retries a reveal only when nothing can have been charged", () => {
    expect(revealRecovery({ status: "failed", error: null }, NO_LEDGER)).toEqual({ reason: "failed", retryable: true });
    expect(revealRecovery({ status: "failed", error: null }, ledger({ released: 3 }))).toEqual({ reason: "failed", retryable: true });
    expect(revealRecovery({ status: "failed", error: null }, ledger({ reserved: 1 }))).toEqual({ reason: "spend_unresolved", retryable: false });
    expect(revealRecovery({ status: "failed", error: null }, ledger({ unreconciled: 1 }))).toEqual({ reason: "spend_unresolved", retryable: false });
    expect(revealRecovery({ status: "failed", error: null }, ledger({ reconciled: 1 }))).toEqual({ reason: "spend_unresolved", retryable: false });
    expect(revealRecovery({ status: "cancelled", error: null }, NO_LEDGER)).toEqual({ reason: "stopped", retryable: false });
    expect(revealRecovery(null, NO_LEDGER)).toEqual({ reason: "stopped", retryable: false });
  });
});

describe("a reveal's ledger, for its recovery", () => {
  it("counts one reveal approval's rows only, never another approval's at the same version", () => {
    const group = (confirmEventId: string, kind: LedgerGroup["kind"], state: LedgerGroup["state"], rows: number): LedgerGroup => ({ briefVersion: 1, confirmEventId, kind, state, rows, charged: 0, worstCase: rows });
    const groups = [group("reveal-a", "reveal", "released", 2), group("reveal-b", "reveal", "unreconciled", 1), group("confirm-a", "search", "unreconciled", 3)];
    expect(revealLedgerOf(groups, "reveal-a")).toEqual({ ...NO_LEDGER, released: 2 });
    expect(revealRecovery({ status: "failed", error: null }, revealLedgerOf(groups, "reveal-a")).retryable).toBe(true);
    expect(revealRecovery({ status: "failed", error: null }, revealLedgerOf(groups, "reveal-b")).retryable).toBe(false);
  });
});

describe("the list's header counts", () => {
  it("never counts a campaign that needs the rep as running", () => {
    const summary = (stage: CampaignStage, state = "researching") => ({ state: state as never, facts: { stage } as never });
    const counts = listCounts([
      summary("researching"),
      summary("finding_people", "findingPeople"),
      summary("research_needs_you", "failed"),
      summary("research_stopped", "stopped"),
      summary("people_needs_you", "peopleNeedsYou"),
      summary("reveal_needs_you", "revealing"),
      summary("people_ready", "peopleReady"),
    ]);
    expect(counts).toEqual({ running: 3, needsYou: 4, done: 0 });
  });
});
