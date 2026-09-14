import { describe, expect, it } from "vitest";

import { DOCUMENTED_UNVERIFIED_PRICING, SearchSpend, SpendRefused, documentedWorstCaseCharge, type SearchPricing } from "@/lib/leadgen/spend";

/** The search-spend invariant, leadgen v2.1 §6. */

const PRICING = DOCUMENTED_UNVERIFIED_PRICING;

describe("documentedWorstCaseCharge", () => {
  it("takes the most any documented model could charge for the request", () => {
    // 1 per result beats 1 per block of 25, and the minimum is 1.
    expect(documentedWorstCaseCharge(10, PRICING)).toBe(10);
    expect(documentedWorstCaseCharge(50, PRICING)).toBe(50);
    const blocks: SearchPricing = { id: "blocks", perResult: null, perBlock: { size: 25, credits: 1 }, minimumPerRequest: 1, revealPerEmail: 1 };
    expect(documentedWorstCaseCharge(26, blocks)).toBe(2);
    expect(documentedWorstCaseCharge(10, { ...blocks, minimumPerRequest: 3 })).toBe(3);
  });

  it("refuses a pricing model that would allow a free request, so the search cannot run without bound", () => {
    expect(() => documentedWorstCaseCharge(10, { id: "free", perResult: null, perBlock: null, minimumPerRequest: 0, revealPerEmail: 1 })).toThrow(/free request/);
  });
});

describe("SearchSpend", () => {
  it("reserves the worst case before a call and reconciles it to the reported charge", () => {
    const spend = new SearchSpend(40, 100, PRICING);
    spend.reserve("p0:a1", 10);
    expect(spend.remaining()).toBe(30);
    spend.reconcile("p0:a1", 2);
    expect(spend.remaining()).toBe(38);
    expect(spend.summary()).toMatchObject({ searchCreditCap: 40, charged: 2, reserved: 0, exceededDocumentedWorstCase: false });
  });

  it("adds up several calls, and refuses one whose worst case exceeds what is left", () => {
    const spend = new SearchSpend(25, 100, PRICING);
    spend.reserve("a", 10);
    spend.reconcile("a", 10);
    spend.reserve("b", 10);
    spend.reconcile("b", 9);
    expect(spend.remaining()).toBe(6);
    expect(spend.canReserve(10)).toBe(false);
    expect(() => spend.reserve("c", 10)).toThrow(SpendRefused);
    expect(spend.list()).toHaveLength(2);
  });

  it("is bounded by the balance read at Confirm when that is lower than the cap", () => {
    const spend = new SearchSpend(40, 15, PRICING);
    spend.reserve("a", 10);
    expect(spend.canReserve(10)).toBe(false);
  });

  it("keeps an unknown outcome reserved at its worst case", () => {
    const spend = new SearchSpend(40, 100, PRICING);
    spend.reserve("a", 10);
    spend.markUnknown("a");
    expect(spend.remaining()).toBe(30);
    expect(spend.summary()).toMatchObject({ charged: 0, reserved: 10 });
    expect(() => spend.reconcile("a", 1)).toThrow(/no open reservation/);
  });

  it("makes a retry reserve again, so retries cannot spend past the cap", () => {
    const spend = new SearchSpend(20, 100, PRICING);
    spend.reserve("p0:a1", 10);
    spend.markUnknown("p0:a1");
    spend.reserve("p0:a2", 10);
    spend.markUnknown("p0:a2");
    expect(spend.canReserve(10)).toBe(false);
    expect(() => spend.reserve("p0:a3", 10)).toThrow(SpendRefused);
    expect(spend.committed()).toBe(20);
  });

  it("never reserves the same request twice", () => {
    const spend = new SearchSpend(40, 100, PRICING);
    spend.reserve("a", 10);
    expect(() => spend.reserve("a", 10)).toThrow(/already reserved/);
  });

  it("records a charge above the documented worst case as it was, and flags it", () => {
    const spend = new SearchSpend(40, 100, PRICING);
    spend.reserve("a", 10);
    spend.reconcile("a", 12);
    expect(spend.summary()).toMatchObject({ charged: 12, exceededDocumentedWorstCase: true });
    expect(spend.remaining()).toBe(28);
  });
});
