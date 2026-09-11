import { z } from "zod";

import { demoteStale } from "../../../agents/_shared/item.schema";
import type { ProductFacts } from "../../../agents/research/input.schema";
import {
  MODULE_IDS,
  completeModule,
  isModuleId,
  m04ScopeIssues,
  moduleFactIds,
  type LockedScope,
  type PageText,
  moduleNotYetFactIds,
  researchOutputSchema,
  type ModuleId,
  type PackShape,
  type ResearchPack,
} from "../../../agents/research/output.schema";
import { neverSayIssues, type NeverSayFile } from "@/lib/facts/neverSay";
import { liveFactIds } from "@/lib/facts/schema";

import { authoredTexts } from "./authored";

/**
 * Ingest (research v3 §7): the one entry point an assembled pack passes
 * through before anything stores or renders it.
 *
 * In order: the runtime's own edit (`demoteStale` on the dated kinds — m01
 * triggers, m02 vendor moves, m04 seed-firm signals; m13 entries carry no
 * confidence), then the strict pack schema (every §3 rule, including the check
 * that the demotion happened), then the rules that need the run's input: live
 * fact ids wherever the pack cites one, contact rules covering every channel
 * on the card, and "changes since the last pack" present when a prior pack was
 * read. The provenance check (§7) runs *before* this, in the handler, because
 * it edits confidence words too and the strict parse should see its result.
 *
 * Every issue names its module where it has one, so the handler can re-ask
 * that module alone and, on a second failure, store it `insufficient` — a
 * refused module never loses the run (§7).
 */

export type ValidateContext = {
  facts: ProductFacts;
  channels: string[];
  priorPackIds: string[];
  /** The product's never-say list (§10 note 20). Absent means not linted. */
  neverSay?: Pick<NeverSayFile, "entries">;
  /** v3.2 (§10 note 28): the locked scope m04 is held to, and the pages the place check reads. */
  scope?: LockedScope;
  pageText?: PageText;
  now?: Date;
};

export type PackIssue = { module?: ModuleId; message: string };

export type ValidateResult =
  | { ok: true; pack: ResearchPack; demoted: string[] }
  | { ok: false; issues: PackIssue[] };

export function validatePack(raw: unknown, context: ValidateContext): ValidateResult {
  const now = context.now ?? new Date();
  const demoted: string[] = [];
  const edited = demoteStaleItems(raw, now, demoted);
  const parsed = researchOutputSchema.safeParse(edited);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map(toPackIssue) };
  const pack = parsed.data;
  const issues: PackIssue[] = [];

  // Live facts only, wherever the pack cites a fact id (§3 rules).
  const live = liveFactIds(context.facts);
  for (const id of MODULE_IDS) {
    for (const { where, ids } of moduleFactIds(pack, id)) {
      const dead = ids.filter((factId) => !live.has(factId));
      if (dead.length > 0) {
        issues.push({ module: id, message: `${where}: ${dead.map((d) => JSON.stringify(d)).join(", ")} ${dead.length === 1 ? "is" : "are"} not live in the facts file` });
      }
    }
  }

  // m11 "not today" citations: in the facts file and not retired (§10 note 9).
  const known = new Set(context.facts.facts.filter((fact) => fact.status !== "retired").map((fact) => fact.id));
  for (const { where, ids } of moduleNotYetFactIds(pack, "m11")) {
    const unknown = ids.filter((factId) => !known.has(factId));
    if (unknown.length > 0) issues.push({ module: "m11", message: `${where}: ${unknown.map((d) => JSON.stringify(d)).join(", ")} not in the facts file, or retired` });
  }

  // Never-say, over what each complete module's author wrote (§10 note 20).
  if (context.neverSay !== undefined) {
    for (const id of MODULE_IDS) {
      const found = completeModule(pack, id);
      if (found === undefined) continue;
      for (const message of neverSayIssues(authoredTexts(id, found), context.neverSay)) issues.push({ module: id, message });
    }
  }

  // Contact rules cover every channel on the card (§3 m12 floor).
  const m12 = completeModule(pack, "m12");
  if (m12) {
    const covered = new Set(m12.rules.map((r) => r.channel.toLowerCase()));
    for (const channel of context.channels) {
      if (!covered.has(channel.toLowerCase())) issues.push({ module: "m12", message: `m12: no contact rule for the channel ${JSON.stringify(channel)}` });
    }
  }

  // The rep's scope on the seed firms and recipes (v3.2, §10 note 28).
  const m04 = completeModule(pack, "m04");
  if (m04 && context.scope !== undefined) for (const message of m04ScopeIssues(m04, context.scope, context.pageText)) issues.push({ module: "m04", message });

  // Changes since the last pack, when there was one (§3 m14).
  const m14 = completeModule(pack, "m14");
  if (m14 && context.priorPackIds.length > 0) {
    if (!m14.applicable) issues.push({ module: "m14", message: "m14: a prior pack was read but the module says it does not apply" });
    for (const change of m14.changes) {
      if (!context.priorPackIds.includes(change.priorPackId)) {
        issues.push({ module: "m14", message: `m14: change cites prior pack ${change.priorPackId}, which this run did not read` });
      }
    }
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, pack, demoted };
}

/** A zod issue as a pack issue: the module is the path's second segment under `modules`. */
export function toPackIssue(issue: z.ZodIssue): PackIssue {
  const message = `${issue.path.join(".") || "$"}: ${issue.message}`;
  const [head, second] = issue.path;
  if (head === "modules" && typeof second === "string" && isModuleId(second)) return { module: second, message };
  if (head === "missingModules" || head === "partial") return { message };
  return { message };
}

/** One line per issue, for errors and reports. */
export function describeIssues(issues: PackIssue[]): string[] {
  return issues.map((issue) => issue.message);
}

type DatedItem = { id?: string; publishedAt?: string; confidence: "strong" | "moderate" | "weak" | "speculative" };
type Loose = Record<string, unknown>;

/**
 * `demoteStale` over the dated kinds, on a copy of the raw object, so the
 * strict parse sees the edit and a reader of `demoted` sees what changed.
 * Works on a whole pack or on a pack holding one module (the write check).
 */
export function demoteStaleItems(raw: unknown, now: Date, demoted: string[]): unknown {
  if (raw === null || typeof raw !== "object") return raw;
  const copy = structuredClone(raw) as Partial<PackShape>;
  const apply = (item: unknown, label: string): unknown => {
    if (item === null || typeof item !== "object" || typeof (item as DatedItem).confidence !== "string") return item;
    const before = item as DatedItem;
    const after = demoteStale(before, now);
    if (after.confidence !== before.confidence) demoted.push(`${label} (${before.id ?? "?"}): ${before.confidence} → ${after.confidence}`);
    return after;
  };
  const modules = copy.modules as Record<string, Loose | undefined> | undefined;
  if (modules === undefined) return copy;
  const m01 = modules.m01;
  if (m01?.status === "complete" && Array.isArray(m01.triggers)) {
    m01.triggers = m01.triggers.map((t, i) => apply(t, `m01.triggers.${i}`));
  }
  const m02 = modules.m02;
  if (m02?.status === "complete" && Array.isArray(m02.competitors)) {
    m02.competitors = m02.competitors.map((c: unknown, i) => {
      if (c === null || typeof c !== "object" || !Array.isArray((c as Loose).recentMoves)) return c;
      return { ...(c as Loose), recentMoves: ((c as Loose).recentMoves as unknown[]).map((m, j) => apply(m, `m02.competitors.${i}.recentMoves.${j}`)) };
    });
  }
  const m04 = modules.m04;
  if (m04?.status === "complete" && Array.isArray(m04.perArchetype)) {
    m04.perArchetype = m04.perArchetype.map((t: unknown, i) => {
      if (t === null || typeof t !== "object" || !Array.isArray((t as Loose).seedFirms)) return t;
      const seedFirms = ((t as Loose).seedFirms as unknown[]).map((f, j) =>
        f !== null && typeof f === "object" ? { ...(f as Loose), signal: apply((f as Loose).signal, `m04.perArchetype.${i}.seedFirms.${j}.signal`) } : f,
      );
      return { ...(t as Loose), seedFirms };
    });
  }
  return copy;
}
