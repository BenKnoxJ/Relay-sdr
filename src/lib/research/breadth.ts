import type { AgentBudget } from "@/lib/agents/definitions";
import { RESEARCH_BREADTH_BUDGETS } from "@/lib/agents/definitions";
import type { ResearchInput } from "../../../agents/research/input.schema";

/**
 * Breadth from the brief (research v2 §6, "inferred from"): runtime-set, never
 * model-chosen.
 *
 * The table says narrow is "one sector, one region, ≤20 people", standard is
 * "one sector, national, or channel motion", wide is "multi-sector or a
 * widen-the-brief re-run". The brief carries a country code and a free-text
 * `who`, so the sector count and the sub-national region are not knowable
 * from it; what is knowable decides: a re-run is wide, a channel motion is
 * standard, twenty people or fewer is narrow, and the rest is standard. An
 * explicit `breadth` on the job wins, which is how the bench runs a brief at
 * a breadth of its choosing.
 */
export type Breadth = ResearchInput["breadth"];

export function deriveBreadth(input: { brief: Pick<ResearchInput["brief"], "motion" | "howMany">; priorRun?: unknown }): Breadth {
  if (input.priorRun !== undefined) return "wide";
  if (input.brief.motion === "channel") return "standard";
  if (input.brief.howMany <= 20) return "narrow";
  return "standard";
}

export function budgetFor(breadth: Breadth): AgentBudget {
  return RESEARCH_BREADTH_BUDGETS[breadth];
}
