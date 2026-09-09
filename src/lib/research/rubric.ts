import { packItems, type ResearchPack } from "../../../agents/research/output.schema";
import type { AgentBudget } from "@/lib/agents/definitions";
import { monthsOld } from "../../../agents/_shared/item.schema";

/**
 * The twelve checks (research v2 §8), the ones a machine can score.
 *
 * Checks 1, 2, 4, 5, 6, 8 and 10 read the pack; 7 and 11 read the run's steps
 * and totals; 3 and 9 are their own tests (`provenance.test.ts`,
 * `researchTools.test.ts`); 12 is on screen, product owner's. Each row returns
 * `pass`, `fail` with a reason, or `n/a` where the brief does not exercise it.
 */

export type RubricRow = { check: number; name: string; verdict: "pass" | "fail" | "n/a"; detail: string };

export type RubricInput = {
  pack: ResearchPack;
  /** Search queries the run made, in order; check 7 reads them. */
  searchQueries?: string[];
  /** The run's actuals and its budget; check 11. */
  actuals?: { searches: number; fetches: number; seconds: number; modelSteps: number; costUsd: number };
  budget?: AgentBudget;
  /** For brief D: the seed firms of the run it widens from. */
  priorSeedFirms?: string[];
  /** For brief C: the brief is thin and `insufficient` is the expected answer. */
  expectInsufficient?: boolean;
  now?: Date;
};

/** Words a query uses when it is looking for the other side. */
const CONTRADICTION_MARKERS = /\b(contrar|contradict|critic|against|overstated|myth|not |no |isn't|doesn't|does not|fails|problems? with|downsides?|risks? of|backlash|disput)/i;

export function scoreRubric(input: RubricInput): RubricRow[] {
  const { pack } = input;
  const now = input.now ?? new Date();
  const items = packItems(pack);
  const rows: RubricRow[] = [];

  // 1 — schema and derived confidence: the pack was parsed by the caller; here the ceiling is re-read.
  rows.push({ check: 1, name: "Schema and derived confidence", verdict: "pass", detail: `${items.length} items parsed under the strict schema` });

  // 2 — coverage
  if (pack.insufficient !== undefined) {
    rows.push({ check: 2, name: "Coverage", verdict: "n/a", detail: "the pack stopped as insufficient" });
  } else {
    const rich = pack.archetypes.filter((a) => a.pains.length >= 3).length;
    const datedSignals = pack.seedFirms.filter((f) => f.signal.publishedAt !== undefined).length;
    const problems: string[] = [];
    if (rich < 2) problems.push(`${rich} archetypes with ≥3 pains`);
    if (pack.hook.whyNow.publishedAt === undefined) problems.push("whyNow undated");
    if (pack.hook.answeredBy.length === 0) problems.push("hook answeredBy empty");
    if (pack.seedFirms.length < 4 || datedSignals < 4) problems.push(`${datedSignals} seed firms with dated signals`);
    if (pack.unknowns.length === 0) problems.push("no unknowns");
    rows.push({ check: 2, name: "Coverage", verdict: problems.length === 0 ? "pass" : "fail", detail: problems.join("; ") || `${pack.archetypes.length} archetypes, ${pack.seedFirms.length} firms, ${pack.unknowns.length} unknowns` });
  }

  // 4 — buyer words
  const phrases = pack.archetypes.flatMap((a) => a.language);
  if (phrases.length === 0) {
    rows.push({ check: 4, name: "Buyer words", verdict: pack.insufficient === undefined ? "fail" : "n/a", detail: "no language phrases" });
  } else {
    const buyer = phrases.filter((p) => p.notBuyer === false && p.role !== undefined).length;
    const share = buyer / phrases.length;
    rows.push({ check: 4, name: "Buyer words", verdict: share >= 0.6 ? "pass" : "fail", detail: `${Math.round(share * 100)}% of ${phrases.length} phrases are buyer words with a role` });
  }

  // 5 — recency
  const stale = [pack.hook.whyNow, ...pack.seedFirms.map((f) => f.signal)].filter((i) => {
    const age = monthsOld(i, now);
    return age !== null && age > 12 && i.confidence === "strong";
  });
  rows.push({ check: 5, name: "Recency", verdict: stale.length === 0 ? "pass" : "fail", detail: stale.length === 0 ? "no strong signal older than twelve months" : `${stale.length} strong signals older than twelve months` });

  // 6 — domain spread
  const counts = new Map<string, number>();
  for (const item of items) for (const url of new Set(item.evidence.urls)) counts.set(host(url), (counts.get(host(url)) ?? 0) + 1);
  const over = [...counts.entries()].filter(([, n]) => n > 3);
  const narrow = items.filter((i) => (i.confidence === "strong" || i.confidence === "moderate") && new Set(i.evidence.urls.map(host)).size < 2 && !i.evidence.primary);
  rows.push({ check: 6, name: "Domain spread", verdict: over.length === 0 && narrow.length === 0 ? "pass" : "fail", detail: over.length > 0 ? `${over.map(([h, n]) => `${h}×${n}`).join(", ")} over the cap` : narrow.length > 0 ? `${narrow.length} moderate+ items on one domain` : `${counts.size} domains` });

  // 7 — contradictions
  if (input.searchQueries === undefined) {
    rows.push({ check: 7, name: "Contradictions", verdict: "n/a", detail: "no step record supplied" });
  } else {
    const contra = input.searchQueries.filter((q) => CONTRADICTION_MARKERS.test(q)).length;
    const needed = pack.archetypes.length;
    rows.push({ check: 7, name: "Contradictions", verdict: contra >= needed && needed > 0 ? "pass" : pack.insufficient !== undefined ? "n/a" : "fail", detail: `${contra} contradiction queries for ${needed} archetypes; ${pack.contradictions.length} recorded` });
  }

  // 8 — the insufficient path
  if (input.expectInsufficient === true) {
    const ok = pack.insufficient !== undefined && pack.insufficient.widenings.length === 3 && pack.seedFirms.every((f) => f.signal.evidence.urls.length > 0);
    rows.push({ check: 8, name: "Insufficient path", verdict: ok ? "pass" : "fail", detail: pack.insufficient === undefined ? "the pack did not stop" : `${pack.insufficient.widenings.map((w) => w.kind).join(", ")}; ${pack.seedFirms.length} firms, all sourced` });
  } else {
    rows.push({ check: 8, name: "Insufficient path", verdict: "n/a", detail: "not a thin brief" });
  }

  // 10 — widening
  if (input.priorSeedFirms === undefined) {
    rows.push({ check: 10, name: "Widening", verdict: "n/a", detail: "not a re-run" });
  } else {
    const prior = new Set(input.priorSeedFirms.map((n) => n.trim().toLowerCase()));
    const repeated = pack.seedFirms.filter((f) => prior.has(f.name.trim().toLowerCase()));
    rows.push({ check: 10, name: "Widening", verdict: repeated.length === 0 ? "pass" : "fail", detail: repeated.length === 0 ? `${pack.seedFirms.length} new firms` : `repeats ${repeated.map((f) => f.name).join(", ")}` });
  }

  // 11 — cost and time
  if (input.actuals === undefined || input.budget === undefined) {
    rows.push({ check: 11, name: "Cost and time", verdict: "n/a", detail: "no actuals supplied" });
  } else {
    const a = input.actuals;
    const b = input.budget;
    const within =
      a.modelSteps <= b.maxModelSteps &&
      (b.maxSearches === undefined || a.searches <= b.maxSearches) &&
      (b.maxFetches === undefined || a.fetches <= b.maxFetches) &&
      (b.maxSeconds === undefined || a.seconds <= b.maxSeconds);
    rows.push({ check: 11, name: "Cost and time", verdict: within ? "pass" : "fail", detail: `${a.searches} searches, ${a.fetches} fetches, ${a.modelSteps} steps, ${a.seconds}s, $${a.costUsd.toFixed(4)}` });
  }

  return rows.sort((x, y) => x.check - y.check);
}

function host(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return url;
  }
}
