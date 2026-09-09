import { describe, expect, it } from "vitest";

import {
  cost,
  costMicroDollars,
  formatMicroDollars,
  isPricedModel,
  PRICE_TABLE_SHA256,
  PRICES,
} from "@/lib/agents/pricing";

/**
 * The pinned price table, and the arithmetic over it.
 *
 * Cost is the number every later decision rests on — the per-campaign ceiling,
 * the credit display, the bench's verdict on whether research is affordable. The
 * table is only as true as its source, so the hash below is the pin: change a
 * rate and this test fails, which is the point. Re-baselining it is a decision
 * and a line in `pricing.ts` saying where the new number came from, not a fix.
 */

const NO_TOKENS = {
  tokensIn: 0,
  tokensInUncached: 0,
  tokensCacheRead: 0,
  tokensCacheWrite: 0,
  tokensCacheWrite1h: 0,
  tokensOut: 0,
};

describe("the price table", () => {
  it("is the table that was reviewed", () => {
    // Read 2026-09-09 from the bundled `claude-api` skill: Opus 5 at $5/$25 per
    // MTok, Sonnet 5 at $2/$10, Haiku 4.5 at $1/$5, cache reads at 0.1x input,
    // cache writes at 1.25x for the five-minute TTL and 2x for the one-hour TTL.
    //
    // Re-baselined 2026-09-09 (Task 6c) from
    // 32912205516964a6210a49d3d2d81c3fbee9a309a92ee0be46b615523e790004: the
    // one-hour write rate and Haiku were added because the Agent SDK transport
    // uses both — see the module comment in `pricing.ts`. No existing rate
    // changed.
    expect(PRICE_TABLE_SHA256).toBe("3bd4560412337aab6074e784be3c67171cc52969a7c36d8316ddc957b6be4e1d");
  });

  it("prices the two models §24 pins and the SDK's Haiku side call, and refuses anything else", () => {
    expect(Object.keys(PRICES).sort()).toEqual(["claude-haiku-4-5", "claude-opus-5", "claude-sonnet-5"]);
    expect(isPricedModel("claude-opus-5")).toBe(true);
    expect(isPricedModel("claude-opus-4-8")).toBe(false);
    // A run that cannot be costed must not happen at all, so an unknown id is a
    // throw rather than a zero.
    expect(() => cost(NO_TOKENS, "claude-opus-4-8")).toThrow(/no pinned price/);
  });

  it("holds the cache multipliers as ratios, not as typed-in numbers", () => {
    for (const [id, price] of Object.entries(PRICES)) {
      expect(price.cacheRead * 10n, id).toBe(price.input);
      expect(price.cacheWrite * 4n, id).toBe(price.input * 5n);
      expect(price.cacheWrite1h, id).toBe(price.input * 2n);
    }
  });
});

describe("cost", () => {
  it("is exact at a million tokens of each kind", () => {
    expect(cost({ ...NO_TOKENS, tokensInUncached: 1_000_000 }, "claude-opus-5")).toBe("5.000000");
    expect(cost({ ...NO_TOKENS, tokensOut: 1_000_000 }, "claude-opus-5")).toBe("25.000000");
    expect(cost({ ...NO_TOKENS, tokensCacheRead: 1_000_000 }, "claude-opus-5")).toBe("0.500000");
    expect(cost({ ...NO_TOKENS, tokensCacheWrite: 1_000_000 }, "claude-opus-5")).toBe("6.250000");
    // A one-hour write is 2x input, and it is a share of the cache writes, not
    // an addition to them: a million writes of which a million are one-hour
    // ones is ten dollars, not sixteen and a quarter.
    expect(cost({ ...NO_TOKENS, tokensCacheWrite: 1_000_000, tokensCacheWrite1h: 1_000_000 }, "claude-opus-5")).toBe("10.000000");
    expect(cost({ ...NO_TOKENS, tokensCacheWrite: 1_000_000, tokensCacheWrite1h: 400_000 }, "claude-opus-5")).toBe("7.750000");
    expect(cost({ ...NO_TOKENS, tokensInUncached: 1_000_000 }, "claude-haiku-4-5")).toBe("1.000000");
    expect(cost({ ...NO_TOKENS, tokensInUncached: 1_000_000 }, "claude-sonnet-5")).toBe("2.000000");
  });

  it("does not price the input total, which already contains the cache figures", () => {
    // The AI SDK's `inputTokens` is the sum of the three details, so pricing it
    // as well as them would charge cached tokens twice. `tokensIn` is recorded
    // because the rubric compares the row to the response, and priced at nothing.
    const withTotal = cost(
      { tokensIn: 999_999, tokensInUncached: 1_000, tokensCacheRead: 0, tokensCacheWrite: 0, tokensCacheWrite1h: 0, tokensOut: 0 },
      "claude-opus-5",
    );
    const withoutTotal = cost({ ...NO_TOKENS, tokensInUncached: 1_000 }, "claude-opus-5");
    expect(withTotal).toBe(withoutTotal);
  });

  it("rounds the sixth decimal place half-up", () => {
    // One token of Opus input is 5 micro-dollars exactly; the rounding only shows
    // at a count whose product is not a whole micro-dollar. Sonnet's cache read
    // is 0.2 micro-dollars a token, so two tokens is 0.4 and rounds down, three
    // is 0.6 and rounds up.
    expect(costMicroDollars({ ...NO_TOKENS, tokensCacheRead: 2 }, "claude-sonnet-5")).toBe(0n);
    expect(costMicroDollars({ ...NO_TOKENS, tokensCacheRead: 3 }, "claude-sonnet-5")).toBe(1n);
    // And the midpoint goes up, the way an invoice rounds.
    expect(costMicroDollars({ ...NO_TOKENS, tokensCacheRead: 5 }, "claude-sonnet-5")).toBe(1n);
  });

  it("adds up without drifting", () => {
    // The reason the column is Decimal and the arithmetic is integer: a thousand
    // steps of the same size must sum to exactly a thousand times one of them,
    // which is not true of binary floating point.
    const one = costMicroDollars({ ...NO_TOKENS, tokensInUncached: 333, tokensOut: 77 }, "claude-opus-5");
    let total = 0n;
    for (let i = 0; i < 1_000; i += 1) total += one;
    expect(total).toBe(one * 1_000n);
    expect(formatMicroDollars(total)).toBe(formatMicroDollars(one * 1_000n));
  });

  it("refuses more one-hour writes than there are writes", () => {
    expect(() => cost({ ...NO_TOKENS, tokensCacheWrite: 10, tokensCacheWrite1h: 11 }, "claude-opus-5")).toThrow(/exceed/);
  });

  it("refuses a token count that is not a whole non-negative number", () => {
    expect(() => cost({ ...NO_TOKENS, tokensOut: -1 }, "claude-opus-5")).toThrow(/non-negative whole number/);
    expect(() => cost({ ...NO_TOKENS, tokensOut: 1.5 }, "claude-opus-5")).toThrow(/non-negative whole number/);
  });

  it("formats to the column's six places", () => {
    expect(formatMicroDollars(0n)).toBe("0.000000");
    expect(formatMicroDollars(1n)).toBe("0.000001");
    expect(formatMicroDollars(1_000_000n)).toBe("1.000000");
    expect(formatMicroDollars(1_234_567n)).toBe("1.234567");
  });
});
