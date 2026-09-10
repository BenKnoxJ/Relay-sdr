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

export type CountedField = "searches" | "fetches" | "fetchedChars";
export type BudgetField = CountedField | "modelSteps" | "minutes" | "spend";
/** What the caller observes and the budget cannot count itself. */
export type Observed = { modelSteps: number; spendUsd?: number };

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
  /** Count one call, or `amount` units of fetched text. Throws `BudgetExceededError` when the charge would pass the rail. */
  charge(field: CountedField, amount?: number): void;
  /**
   * Fields that have newly crossed seventy percent since the last call, each
   * reported once per attempt. `modelSteps` is the caller's count; minutes are
   * read from the clock.
   */
  crossed(observed: Observed): BudgetField[];
  /** What was used, for the run report and rubric check 11. */
  actuals(): { searches: number; fetches: number; fetchedChars: number; seconds: number };
  /** The line the model reads on the next tool result after a crossing. */
  note(field: BudgetField, observed: Observed): string;
};

export function createResearchBudget(options: { limits: AgentBudget; now?: () => number }): ResearchBudget {
  const { limits } = options;
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const counts = { searches: 0, fetches: 0, fetchedChars: 0 };
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
      case "fetchedChars":
        return limits.maxFetchedChars;
      case "spend":
        return limits.maxSpendUsd;
    }
  };
  const usedOf = (field: BudgetField, observed: Observed): number => {
    switch (field) {
      case "searches":
        return counts.searches;
      case "fetches":
        return counts.fetches;
      case "modelSteps":
        return observed.modelSteps;
      case "minutes":
        return (now() - startedAt) / 60_000;
      case "fetchedChars":
        return counts.fetchedChars;
      case "spend":
        return observed.spendUsd ?? 0;
    }
  };

  return {
    limits,
    charge(field, amount = 1) {
      const limit = limitOf(field);
      // A definition with no rail on a field has no rail on it.
      if (limit !== undefined && counts[field] + amount > limit) throw new BudgetExceededError(field, limit);
      counts[field] += amount;
    },
    crossed(observed) {
      const out: BudgetField[] = [];
      for (const field of ["searches", "fetches", "fetchedChars", "modelSteps", "minutes", "spend"] as const) {
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
      return { searches: counts.searches, fetches: counts.fetches, fetchedChars: counts.fetchedChars, seconds: Math.round((now() - startedAt) / 1000) };
    },
    note(field, observed) {
      const limit = limitOf(field) ?? 0;
      const used = usedOf(field, observed);
      const shown =
        field === "minutes"
          ? `${Math.floor(used)} of ${Math.floor(limit)} minutes`
          : field === "spend"
            ? `$${used.toFixed(2)} of $${limit} spend`
            : field === "fetchedChars"
              ? `${Math.floor(used / 1000)}k of ${Math.floor(limit / 1000)}k characters of fetched text`
              : `${Math.floor(used)} of ${limit} ${field}`;
      return `Runtime checkpoint: ${shown} used. State what you still lack, then finish, or say which modules will be partial. Write every module you can now; prefer your highest-value remaining queries; do not repeat one.`;
    },
  };
}
