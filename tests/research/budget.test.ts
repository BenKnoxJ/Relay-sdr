import { describe, expect, it } from "vitest";

import { BudgetExceededError, createResearchBudget } from "@/lib/research/budget";

const LIMITS = { maxModelSteps: 10, maxSearches: 10, maxFetches: 4, maxSeconds: 600 };

describe("the research budget", () => {
  it("counts searches and fetches, and refuses the call past the cap", () => {
    const budget = createResearchBudget({ limits: LIMITS });
    for (let i = 0; i < 4; i += 1) budget.charge("fetches");
    expect(() => budget.charge("fetches")).toThrow(BudgetExceededError);
    try {
      budget.charge("fetches");
    } catch (error) {
      expect(error).toMatchObject({ field: "fetches", limit: 4, unspent: true });
      expect((error as Error).message).toMatch(/^cap:fetches/);
    }
    expect(budget.actuals()).toMatchObject({ searches: 0, fetches: 4 });
  });

  it("reports each seventy-percent crossing once", () => {
    const budget = createResearchBudget({ limits: LIMITS });
    for (let i = 0; i < 6; i += 1) budget.charge("searches");
    expect(budget.crossed({ modelSteps: 0 })).toEqual([]);
    budget.charge("searches");
    expect(budget.crossed({ modelSteps: 0 })).toEqual(["searches"]);
    expect(budget.crossed({ modelSteps: 0 })).toEqual([]);
    expect(budget.crossed({ modelSteps: 7 })).toEqual(["modelSteps"]);
    expect(budget.note("searches", { modelSteps: 7 })).toMatch(/7 of 10 searches used/);
  });

  it("reads minutes from the clock", () => {
    let clock = 0;
    const budget = createResearchBudget({ limits: LIMITS, now: () => clock });
    clock = 7 * 60_000;
    expect(budget.crossed({ modelSteps: 0 })).toEqual(["minutes"]);
    expect(budget.actuals().seconds).toBe(420);
    expect(budget.note("minutes", { modelSteps: 0 })).toMatch(/7 of 10 minutes/);
  });

  it("has no cap on a field the definition leaves unset", () => {
    const budget = createResearchBudget({ limits: { maxModelSteps: 3 } });
    for (let i = 0; i < 100; i += 1) budget.charge("searches");
    expect(budget.crossed({ modelSteps: 100 })).toEqual(["modelSteps"]);
  });
});
