import type { AgentBudget } from "@/lib/agents/definitions";

/**
 * The research budget, enforced (research v2 §6).
 *
 * Four caps per breadth: searches, fetches, model steps, minutes. Model steps
 * are the runtime's (`maxTurns` on the Agent SDK, `stepCountIs` on the Messages
 * API) and minutes are a timer on the run's controller; the two tool caps are
 * this object's, charged from inside the tool's own `execute` so that a
 * **replayed** call costs nothing — a retry after a kill, and the automatic
 * provenance re-run, must reach the first attempt's depth and then continue,
 * and neither spends a credit to get there.
 *
 * At seventy percent of any cap the definition asks for one re-plan step. The
 * loop runs inside the SDK's subprocess on the subscription transport, so
 * there is no seam to inject a message; the note rides on the next tool result
 * instead — Signal's hook does the same, and it is the one mechanism with a
 * track record. Once per field per attempt: each crossing is a distinct thing
 * the model should hear about, and four notes in a run is the most it can be.
 *
 * A hard cap is a typed error. `withReplay` treats it as *unspent* (the row is
 * kept, the key is released) and the recorder aborts the run with `cap` naming
 * the field, so a capped run has no answer — the rule `cap.test.ts` pins.
 */

export const SOFT_FRACTION = 0.7;

export type CountedField = "searches" | "fetches";
export type BudgetField = CountedField | "modelSteps" | "minutes";

export class BudgetExceededError extends Error {
  readonly unspent = true as const;
  constructor(
    readonly field: BudgetField,
    readonly limit: number,
  ) {
    super(`cap:${field}: the ${field} cap (${limit}) was reached`);
    this.name = "BudgetExceededError";
  }
}

export type ResearchBudget = {
  readonly limits: AgentBudget;
  /** Count one call. Throws `BudgetExceededError` when the call would pass the cap. */
  charge(field: CountedField): void;
  /**
   * Fields that have newly crossed seventy percent since the last call, each
   * reported once per attempt. `modelSteps` is the caller's count; minutes are
   * read from the clock.
   */
  crossed(observed: { modelSteps: number }): BudgetField[];
  /** What was used, for the run report and rubric check 11. */
  actuals(): { searches: number; fetches: number; seconds: number };
  /** The line the model reads on the next tool result after a crossing. */
  note(field: BudgetField, observed: { modelSteps: number }): string;
};

export function createResearchBudget(options: { limits: AgentBudget; now?: () => number }): ResearchBudget {
  const { limits } = options;
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const counts = { searches: 0, fetches: 0 };
  const noted = new Set<BudgetField>();

  const limitOf = (field: BudgetField): number | undefined => {
    switch (field) {
      case "searches":
        return limits.maxSearches;
      case "fetches":
        return limits.maxFetches;
      case "modelSteps":
        return limits.maxModelSteps;
      case "minutes":
        return limits.maxSeconds === undefined ? undefined : limits.maxSeconds / 60;
    }
  };
  const usedOf = (field: BudgetField, observed: { modelSteps: number }): number => {
    switch (field) {
      case "searches":
        return counts.searches;
      case "fetches":
        return counts.fetches;
      case "modelSteps":
        return observed.modelSteps;
      case "minutes":
        return (now() - startedAt) / 60_000;
    }
  };

  return {
    limits,
    charge(field) {
      const limit = limitOf(field);
      // A definition with no cap on a field has no cap on it.
      if (limit !== undefined && counts[field] + 1 > limit) throw new BudgetExceededError(field, limit);
      counts[field] += 1;
    },
    crossed(observed) {
      const out: BudgetField[] = [];
      for (const field of ["searches", "fetches", "modelSteps", "minutes"] as const) {
        const limit = limitOf(field);
        if (limit === undefined || noted.has(field)) continue;
        if (usedOf(field, observed) >= limit * SOFT_FRACTION) {
          noted.add(field);
          out.push(field);
        }
      }
      return out;
    },
    actuals() {
      return { searches: counts.searches, fetches: counts.fetches, seconds: Math.round((now() - startedAt) / 1000) };
    },
    note(field, observed) {
      const limit = limitOf(field) ?? 0;
      const used = usedOf(field, observed);
      const shown = field === "minutes" ? `${Math.floor(used)} of ${Math.floor(limit)} minutes` : `${Math.floor(used)} of ${limit} ${field}`;
      return `Runtime checkpoint: ${shown} used. State what you still lack and either finish or narrow. Prefer your highest-value remaining queries; do not repeat one.`;
    },
  };
}
