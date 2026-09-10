import { z } from "zod";

import { demoteStale } from "../../../agents/_shared/item.schema";
import type { ProductFacts } from "../../../agents/research/input.schema";
import { completeModule, researchOutputSchema, type PackShape, type ResearchPack } from "../../../agents/research/output.schema";
import { liveFactIds } from "@/lib/facts/schema";

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
 */

export type ValidateContext = {
  facts: ProductFacts;
  channels: string[];
  priorPackIds: string[];
  now?: Date;
};

export type ValidateResult =
  | { ok: true; pack: ResearchPack; demoted: string[] }
  | { ok: false; issues: string[] };

export function validatePack(raw: unknown, context: ValidateContext): ValidateResult {
  const now = context.now ?? new Date();
  const demoted: string[] = [];
  const edited = demoteStaleItems(raw, now, demoted);
  const parsed = researchOutputSchema.safeParse(edited);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map(describe) };
  const pack = parsed.data;
  const issues: string[] = [];

  // Live facts only, wherever the pack cites a fact id (§3 rules).
  const live = liveFactIds(context.facts);
  const check = (ids: string[], where: string): void => {
    const dead = ids.filter((id) => !live.has(id));
    if (dead.length > 0) {
      issues.push(`${where}: ${dead.map((id) => JSON.stringify(id)).join(", ")} ${dead.length === 1 ? "is" : "are"} not live in the facts file`);
    }
  };
  const m00 = completeModule(pack, "m00");
  if (m00) check(m00.offerHook, "m00.offerHook");
  const m03 = completeModule(pack, "m03");
  if (m03) m03.archetypes.forEach((a, i) => check(a.dealEconomics.factIds, `m03.archetypes.${i}.dealEconomics.factIds`));
  const m07 = completeModule(pack, "m07");
  if (m07) m07.mappings.forEach((m, i) => check(m.factIds, `m07.mappings.${i}.factIds`));
  const m11 = completeModule(pack, "m11");
  if (m11) m11.perArchetype.forEach((p, i) => p.objections.forEach((o, j) => check(o.factIds, `m11.perArchetype.${i}.objections.${j}.factIds`)));
  const m15 = completeModule(pack, "m15");
  if (m15) check(m15.proof.map((p) => p.factId), "m15.proof");

  // Contact rules cover every channel on the card (§3 m12 floor).
  const m12 = completeModule(pack, "m12");
  if (m12) {
    const covered = new Set(m12.rules.map((r) => r.channel.toLowerCase()));
    for (const channel of context.channels) {
      if (!covered.has(channel.toLowerCase())) issues.push(`m12: no contact rule for the channel ${JSON.stringify(channel)}`);
    }
  }

  // Changes since the last pack, when there was one (§3 m14).
  const m14 = completeModule(pack, "m14");
  if (m14 && context.priorPackIds.length > 0) {
    if (!m14.applicable) issues.push("m14: a prior pack was read but the module says it does not apply");
    for (const change of m14.changes) {
      if (!context.priorPackIds.includes(change.priorPackId)) issues.push(`m14: change cites prior pack ${change.priorPackId}, which this run did not read`);
    }
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, pack, demoted };
}

function describe(issue: z.ZodIssue): string {
  return `${issue.path.join(".") || "$"}: ${issue.message}`;
}

type DatedItem = { id?: string; publishedAt?: string; confidence: "strong" | "moderate" | "weak" | "speculative" };
type Loose = Record<string, unknown>;

/**
 * `demoteStale` over the dated kinds, on a copy of the raw object, so the
 * strict parse sees the edit and a reader of `demoted` sees what changed.
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
