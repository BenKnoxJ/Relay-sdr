import { z } from "zod";

import { demoteStale } from "../../../agents/_shared/item.schema";
import type { ProductFacts } from "../../../agents/research/input.schema";
import { researchOutputSchema, type ResearchPack } from "../../../agents/research/output.schema";
import { liveFactIds } from "@/lib/facts/schema";

/**
 * Ingest (research v2 §3): the one entry point a pack passes through before
 * anything stores or renders it.
 *
 * In order: the runtime's own edits (`demoteStale` on `whyNow` and every
 * seed-firm signal — "drop to `weak` automatically"), then the strict schema
 * (everything §3 says, including the check that the demotion happened), then
 * the rule that needs the facts file: `hook.answeredBy` names live facts only.
 * The provenance check (§7) runs *before* this, in the handler, because it
 * edits confidence words too and the strict parse should see its result.
 */

export type ValidateResult =
  | { ok: true; pack: ResearchPack; demoted: string[] }
  | { ok: false; issues: string[] };

export function validatePack(raw: unknown, options: { facts: ProductFacts; now?: Date }): ValidateResult {
  const now = options.now ?? new Date();
  const first = researchOutputSchema.safeParse(raw);
  // Demote on the raw object rather than on a parsed one: the strict parse is
  // what refuses an over-claimed stale item, so it has to see the demotion.
  const demoted: string[] = [];
  const input = first.success ? first.data : (raw as Record<string, unknown>);
  const edited = demoteStaleItems(input, now, demoted);
  const parsed = researchOutputSchema.safeParse(edited);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map(describe) };

  const live = liveFactIds(options.facts);
  const dead = parsed.data.hook.answeredBy.filter((id) => !live.has(id));
  if (dead.length > 0) {
    return { ok: false, issues: [`hook.answeredBy: ${dead.map((id) => JSON.stringify(id)).join(", ")} ${dead.length === 1 ? "is" : "are"} not live in the facts file`] };
  }
  return { ok: true, pack: parsed.data, demoted };
}

function describe(issue: z.ZodIssue): string {
  return `${issue.path.join(".") || "$"}: ${issue.message}`;
}

type DatedItem = { id?: string; publishedAt?: string; confidence: "strong" | "moderate" | "weak" | "speculative" };

function demoteStaleItems(pack: unknown, now: Date, demoted: string[]): unknown {
  if (pack === null || typeof pack !== "object") return pack;
  const copy = structuredClone(pack) as { hook?: { whyNow?: DatedItem }; seedFirms?: Array<{ signal?: DatedItem }> };
  const apply = (item: DatedItem | undefined, label: string): DatedItem | undefined => {
    if (item === undefined || typeof item !== "object" || typeof item.confidence !== "string") return item;
    const after = demoteStale(item, now);
    if (after.confidence !== item.confidence) demoted.push(`${label} (${item.id ?? "?"}): ${item.confidence} → ${after.confidence}`);
    return after;
  };
  if (copy.hook !== undefined && typeof copy.hook === "object") copy.hook.whyNow = apply(copy.hook.whyNow, "hook.whyNow");
  if (Array.isArray(copy.seedFirms)) {
    copy.seedFirms = copy.seedFirms.map((firm, index) =>
      firm !== null && typeof firm === "object" ? { ...firm, signal: apply(firm.signal, `seedFirms.${index}.signal`) } : firm,
    );
  }
  return copy;
}
