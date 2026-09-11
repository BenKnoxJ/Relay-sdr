import {
  DOMAIN_CAP,
  MODULE_IDS,
  SYNTHESIS_PHASE_MODULES,
  completeModule,
  domainCounts,
  m04ScopeIssues,
  moduleItems,
  planCards,
  planCardsSchema,
  researchRawSchema,
  wideningIssue,
  type LockedScope,
  type ModuleId,
  type PackShape,
  type PageText,
} from "../../../agents/research/output.schema";
import { aboveCeiling, hostOf, monthsOld, type Item } from "../../../agents/_shared/item.schema";
import type { AgentBudget } from "@/lib/agents/definitions";
import { assertPlainWords } from "@/lib/copy/plainWords";

/**
 * The research rubric (`research.v3.signed.md` §8), the rows a machine can score.
 *
 * Rows 1, 2, 4, 5, 6, 8, 10 and 13 read the pack; 3 reads the run's
 * provenance report; 7 and 11 read the run's steps and totals; 9 is its own
 * test (`tests/worker/research.test.ts`, the replay after a kill); 12 is
 * the product owner's, read module by module against Signal's May pack. Each row
 * returns `pass`, `fail` with a reason, or `n/a` where the brief or the
 * supplied record does not exercise it.
 */

export type RubricRow = { check: number; name: string; verdict: "pass" | "fail" | "n/a"; detail: string };

/** The parts of the completion Event's `report` the rubric reads. */
export type RubricReport = {
  provenance?: Array<{ total: number; failed: unknown[] }>;
  insufficientModules?: string[];
  endings?: Array<{ ending: string; message?: string }>;
};

export type RubricInput = {
  pack: PackShape;
  /** The searches the run made, in order, with the wave each was marked as; row 7 reads them. */
  searches?: Array<{ query: string; purpose?: string }>;
  /** The run's actuals; row 11 reads them against the rails. */
  actuals?: { searches: number; fetches: number; fetchedChars?: number; seconds: number; modelSteps: number; costUsd: number };
  budget?: AgentBudget;
  /** For brief D: the seed firm names of the run it widens from. */
  priorSeedFirms?: string[];
  /** For brief C: the brief is thin and `insufficient` is the expected answer. */
  expectInsufficient?: boolean;
  /** The job's tool calls in order, across runs (row 8 reads it): which call, which module, the verdict, whether accepted. */
  record?: Array<{ run: number; name: string; module?: string; verdict?: string; accepted?: boolean }>;
  /** The locked scope, when the pack does not carry it (rows 8 and 14). */
  scope?: LockedScope;
  /** The pages the run read, for the place check (rows 8 and 14). */
  pageText?: PageText;
  /** The completion Event's report: provenance per attempt, modules stored insufficient, how each attempt ended. */
  report?: RubricReport;
  now?: Date;
};

/** Words a query uses when it is looking for the other side — the fallback when a search carries no `purpose`. */
const CONTRADICTION_MARKERS = /\b(contrar|contradict|critic|against|overstated|myth|not |no |isn't|doesn't|does not|fails|problems? with|downsides?|risks? of|backlash|disput|falling|fell|declin|improving|instead of|already|alternative)/i;

/** Every stored module's status, `missing` when absent. */
function statuses(pack: PackShape): Record<ModuleId, "complete" | "insufficient" | "missing"> {
  const modules = pack.modules as Record<ModuleId, { status?: string } | undefined>;
  return Object.fromEntries(
    MODULE_IDS.map((id) => [id, modules[id] === undefined ? "missing" : modules[id]?.status === "complete" ? "complete" : "insufficient"]),
  ) as Record<ModuleId, "complete" | "insufficient" | "missing">;
}

export function scoreRubric(input: RubricInput): RubricRow[] {
  const { pack } = input;
  const now = input.now ?? new Date();
  const items: Item[] = MODULE_IDS.flatMap((id) => moduleItems(pack, id));
  const stopped = pack.insufficient !== undefined;
  const state = statuses(pack);
  const archetypes = completeModule(pack, "m03")?.archetypes ?? [];
  const m04 = completeModule(pack, "m04");
  const rows: RubricRow[] = [];

  // 1 — schema and derived confidence.
  const parsed = researchRawSchema.safeParse(pack);
  const over = items.filter((i) => aboveCeiling(i.confidence, i.evidence));
  rows.push({
    check: 1,
    name: "Schema and derived confidence",
    verdict: parsed.success && over.length === 0 ? "pass" : "fail",
    detail: !parsed.success
      ? `${parsed.error.issues.length} schema issue(s): ${parsed.error.issues.slice(0, 2).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
      : over.length > 0
        ? `${over.length} item(s) above their ceiling`
        : `${items.length} items parsed; none above its ceiling`,
  });

  // 2 — coverage: every module present and complete, floors met.
  if (stopped) {
    rows.push({ check: 2, name: "Coverage", verdict: "n/a", detail: "the pack stopped as insufficient" });
  } else {
    const missing = MODULE_IDS.filter((id) => state[id] === "missing");
    const thin = MODULE_IDS.filter((id) => state[id] === "insufficient");
    const problems: string[] = [];
    if (pack.partial) problems.push("partial");
    if (missing.length > 0) problems.push(`missing ${missing.join(", ")}`);
    if (thin.length > 0) problems.push(`insufficient ${thin.join(", ")}`);
    rows.push({ check: 2, name: "Coverage", verdict: problems.length === 0 ? "pass" : "fail", detail: problems.join("; ") || `${MODULE_IDS.length} modules complete, ${archetypes.length} kinds of buyer` });
  }

  // 3 — provenance, from the last attempt's report.
  const last = input.report?.provenance?.at(-1);
  if (last === undefined) {
    rows.push({ check: 3, name: "Provenance", verdict: "n/a", detail: "no provenance report supplied (the five hand spot-checks are the product owner's)" });
  } else {
    const fraction = last.total === 0 ? 0 : last.failed.length / last.total;
    rows.push({ check: 3, name: "Provenance", verdict: fraction <= 0.1 ? "pass" : "fail", detail: `${last.failed.length} of ${last.total} claims demoted (${Math.round(fraction * 100)}%); the cap is 10%` });
  }

  // 4 — buyer words, over m06.
  const phrases = completeModule(pack, "m06")?.perArchetype.flatMap((p) => p.phrases) ?? [];
  if (phrases.length === 0) {
    rows.push({ check: 4, name: "Buyer words", verdict: stopped ? "n/a" : "fail", detail: "no buyer phrases" });
  } else {
    const buyer = phrases.filter((p) => p.notBuyer === false && p.role !== undefined).length;
    const share = buyer / phrases.length;
    rows.push({ check: 4, name: "Buyer words", verdict: share >= 0.6 ? "pass" : "fail", detail: `${Math.round(share * 100)}% of ${phrases.length} phrases are buyer words with a role` });
  }

  // 5 — recency, on the four dated kinds that carry a confidence.
  const dated: Item[] = [
    ...(completeModule(pack, "m01")?.triggers ?? []),
    ...(completeModule(pack, "m02")?.competitors.flatMap((c) => c.recentMoves) ?? []),
    ...(m04?.perArchetype.flatMap((t) => t.seedFirms.map((f) => f.signal)) ?? []),
  ];
  const stale = dated.filter((i) => {
    const age = monthsOld(i, now);
    return age !== null && age > 12 && i.confidence === "strong";
  });
  rows.push({ check: 5, name: "Recency", verdict: stale.length === 0 ? "pass" : "fail", detail: stale.length === 0 ? `no strong dated claim older than twelve months (${dated.length} checked)` : `${stale.length} strong claim(s) older than twelve months` });

  // 6 — domain spread: the per-module cap, two domains for moderate and above, seed firms from two sources.
  const overCap: string[] = [];
  for (const id of MODULE_IDS) for (const [host, n] of domainCounts(pack, id)) if (n > DOMAIN_CAP) overCap.push(`${id} ${host}×${n}`);
  const narrow = items.filter((i) => (i.confidence === "strong" || i.confidence === "moderate") && !i.evidence.primary && new Set(i.evidence.urls.map(hostOf)).size < 2);
  const oneSource = (m04?.perArchetype ?? []).filter((t) => new Set(t.seedFirms.flatMap((f) => f.signal.evidence.urls.map(hostOf))).size < 2).map((t) => t.archetypeId);
  rows.push({
    check: 6,
    name: "Domain spread",
    verdict: overCap.length === 0 && narrow.length === 0 && oneSource.length === 0 ? "pass" : "fail",
    detail:
      [
        overCap.length > 0 ? `over the cap: ${overCap.join(", ")}` : "",
        narrow.length > 0 ? `${narrow.length} moderate+ item(s) on one domain` : "",
        oneSource.length > 0 ? `seed firms from one source for ${oneSource.join(", ")}` : "",
      ]
        .filter((s) => s.length > 0)
        .join("; ") || "every module inside the cap; seed firms from two or more sources",
  });

  // 7 — contradictions: one contradiction search per kind of buyer, and m17 written.
  if (input.searches === undefined) {
    rows.push({ check: 7, name: "Contradictions", verdict: "n/a", detail: "no step record supplied" });
  } else if (stopped) {
    rows.push({ check: 7, name: "Contradictions", verdict: "n/a", detail: "the pack stopped as insufficient" });
  } else {
    const contra = input.searches.filter((s) => (s.purpose === undefined ? CONTRADICTION_MARKERS.test(s.query) : s.purpose === "contradiction")).length;
    const needed = archetypes.length;
    const written = state.m17 === "complete";
    rows.push({
      check: 7,
      name: "Contradictions",
      verdict: needed > 0 && contra >= needed && written ? "pass" : "fail",
      detail: `${contra} contradiction search(es) for ${needed} kind(s) of buyer; m17 ${written ? `written (${completeModule(pack, "m17")?.entries.length ?? 0} entries)` : state.m17}`,
    });
  }

  // 8 — the insufficient path (v3.2, §10 note 28): a persisted stop, nothing after it, no padding.
  if (input.expectInsufficient === true) {
    const problems = insufficientPathProblems(input);
    rows.push({
      check: 8,
      name: "Insufficient path",
      verdict: problems.length === 0 ? "pass" : "fail",
      detail: problems.length === 0 ? `stopped; widen by ${pack.insufficient!.widenings.map((w) => w.dimension).join(", ")}; ${pack.insufficient!.evidenceIds.length} piece(s) of in-scope evidence` : problems.join("; "),
    });
  } else {
    rows.push({ check: 8, name: "Insufficient path", verdict: "n/a", detail: "not a thin brief" });
  }

  // 9 — replay: its own test.
  rows.push({ check: 9, name: "Replay", verdict: "n/a", detail: "its own test: tests/worker/research.test.ts (a kill mid-run replays every stored call)" });

  // 10 — widening.
  if (input.priorSeedFirms === undefined) {
    rows.push({ check: 10, name: "Widening", verdict: "n/a", detail: "not a re-run" });
  } else {
    const prior = new Set(input.priorSeedFirms.map((n) => n.trim().toLowerCase()));
    const firms = m04?.perArchetype.flatMap((t) => t.seedFirms) ?? [];
    const repeated = firms.filter((f) => prior.has(f.name.trim().toLowerCase()));
    rows.push({ check: 10, name: "Widening", verdict: repeated.length === 0 ? "pass" : "fail", detail: repeated.length === 0 ? `${firms.length} new firm(s)` : `repeats ${repeated.map((f) => f.name).join(", ")}` });
  }

  // 11 — cost and time, inside every rail.
  if (input.actuals === undefined || input.budget === undefined) {
    rows.push({ check: 11, name: "Cost and time", verdict: "n/a", detail: "no actuals supplied" });
  } else {
    const a = input.actuals;
    const b = input.budget;
    const breaches: string[] = [];
    if (a.modelSteps > b.maxModelSteps) breaches.push(`steps ${a.modelSteps}/${b.maxModelSteps}`);
    if (b.maxSearches !== undefined && a.searches > b.maxSearches) breaches.push(`searches ${a.searches}/${b.maxSearches}`);
    if (b.maxFetches !== undefined && a.fetches > b.maxFetches) breaches.push(`fetches ${a.fetches}/${b.maxFetches}`);
    if (b.maxFetchedChars !== undefined && (a.fetchedChars ?? 0) > b.maxFetchedChars) breaches.push(`fetched text ${a.fetchedChars}/${b.maxFetchedChars}`);
    if (b.maxSeconds !== undefined && a.seconds > b.maxSeconds) breaches.push(`seconds ${a.seconds}/${b.maxSeconds}`);
    if (b.maxSpendUsd !== undefined && a.costUsd > b.maxSpendUsd) breaches.push(`spend $${a.costUsd.toFixed(2)}/$${b.maxSpendUsd}`);
    rows.push({
      check: 11,
      name: "Cost and time",
      verdict: breaches.length === 0 ? "pass" : "fail",
      detail: `${a.searches} searches, ${a.fetches} fetches, ${Math.round((a.fetchedChars ?? 0) / 1000)}k chars, ${a.modelSteps} steps, ${a.seconds}s, $${a.costUsd.toFixed(4)}${breaches.length > 0 ? `; over: ${breaches.join(", ")}` : ""}`,
    });
  }

  // 12 — depth against the bar: the product owner's.
  rows.push({ check: 12, name: "Depth against the bar", verdict: "n/a", detail: "The product owner reads brief A against Signal's May insurance pack and brief E against the legal exemplar" });

  // 13 — the plan-card view renders, in rep words.
  const cards = planCardsSchema.safeParse(planCards(pack));
  let words: string | null = null;
  if (cards.success) {
    try {
      assertPlainWords(cards.data.summary);
    } catch (error) {
      words = error instanceof Error ? error.message : "machine word in the summary";
    }
  }
  rows.push({
    check: 13,
    name: "Plan-card view",
    verdict: cards.success && words === null ? "pass" : "fail",
    detail: !cards.success ? `planCards does not parse: ${cards.error.issues[0]?.message ?? ""}` : (words ?? `${cards.data.archetypes.length} kind(s) of buyer, ${cards.data.seedFirms.length} firm(s) on the cards`),
  });

  // 14 — scope held (v3.2): the seed firms and recipes lead gen works from stay inside the rep's scope.
  const scope = input.scope ?? pack.scope;
  if (scope === undefined) {
    rows.push({ check: 14, name: "Scope held", verdict: "n/a", detail: "no locked scope recorded (a pack from before v3.2)" });
  } else {
    const issues = m04 === undefined ? [] : m04ScopeIssues(m04, scope, input.pageText);
    const firms = m04?.perArchetype.flatMap((t) => t.seedFirms).length ?? 0;
    rows.push({
      check: 14,
      name: "Scope held",
      verdict: issues.length === 0 ? "pass" : "fail",
      detail: issues.length === 0 ? `${firms} seed firm(s) and ${m04?.perArchetype.length ?? 0} recipe(s) inside the scope (${scope.supplied.join(", ")})` : `${issues.length} issue(s): ${issues.slice(0, 4).join("; ")}`,
    });
  }

  return rows.sort((x, y) => x.check - y.check);
}

/** The research calls a stop ends (v3.2). */
const RESEARCH_CALLS = new Set(["search", "fetch", "writeModule", "decideScope"]);

/** Why a thin brief's run is not a valid insufficient outcome (row 8); empty when it is. */
export function insufficientPathProblems(input: RubricInput): string[] {
  const { pack } = input;
  const problems: string[] = [];
  const record = input.record;
  if (record === undefined) problems.push("no step record supplied");
  const stopAt = record?.findIndex((s) => s.name === "decideScope" && s.accepted === true && s.verdict === "stop") ?? -1;
  if (record !== undefined && stopAt < 0) problems.push("no persisted stop (decideScope)");
  if (record !== undefined && stopAt >= 0) {
    const after = record.slice(stopAt + 1).filter((s) => RESEARCH_CALLS.has(s.name));
    if (after.length > 0) problems.push(`${after.length} research call(s) after the stop`);
  }
  const written = new Set([
    ...(record ?? []).filter((s) => s.name === "writeModule" && s.accepted === true && s.module !== undefined).map((s) => s.module!),
    ...MODULE_IDS.filter((id) => (pack.modules as Record<string, unknown>)[id] !== undefined),
  ]);
  const synthesised = SYNTHESIS_PHASE_MODULES.filter((id) => written.has(id));
  if (synthesised.length > 0) problems.push(`synthesis wrote ${synthesised.join(", ")}`);
  if (pack.outcome !== "insufficient" || pack.insufficient === undefined) problems.push("the outcome is not insufficient");
  for (const id of ["m00", "m01"] as const) if (completeModule(pack, id) === undefined) problems.push(`${id} was not kept`);
  const scope = input.scope ?? pack.scope;
  if (scope === undefined) problems.push("no locked scope recorded");
  if (pack.insufficient !== undefined) {
    const known = new Set([...moduleItems(pack, "m00"), ...moduleItems(pack, "m01")].map((item) => item.id));
    const loose = pack.insufficient.evidenceIds.filter((id) => !known.has(id));
    if (loose.length > 0) problems.push(`evidence ${loose.join(", ")} is not in m00 or m01`);
    const count = pack.insufficient.widenings.length;
    if (count < 1 || count > 3) problems.push(`${count} widening options; one to three`);
    if (scope !== undefined) {
      for (const widening of pack.insufficient.widenings) {
        const why = wideningIssue(scope, widening);
        if (why !== null) problems.push(why);
      }
    }
  }
  const m04 = completeModule(pack, "m04");
  if (m04 !== undefined && scope !== undefined) {
    const outside = m04ScopeIssues(m04, scope, input.pageText);
    if (outside.length > 0) problems.push(`${outside.length} seed firm or recipe issue(s) outside the scope, e.g. ${outside[0]}`);
  }
  return problems;
}
