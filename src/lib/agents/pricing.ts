import { createHash } from "node:crypto";

/**
 * What a model call costs, and the table that says so.
 *
 * Proof 1 of the runtime spike (§24) is "every `AgentRunStep` row's tokens
 * equal the API's own usage, and its cost equals tokens times the pinned price
 * table". The tokens half is arithmetic the provider does for us. This file is
 * the other half, and it is only as true as the numbers in it — so the numbers
 * carry their source, the date they were read, and a hash over the table, and
 * `PRICE_TABLE_SHA256` is asserted in the test suite. A silent edit to a rate
 * fails the build rather than quietly re-pricing every row ever written.
 *
 * ## Source
 *
 * Per-million-token rates for `claude-opus-5`, `claude-sonnet-5` and
 * `claude-haiku-4-5` are the Anthropic first-party API rates, read on
 * **2026-09-09** from the bundled `claude-api` skill's current-models table
 * (cached 2026-06-24; https://www.anthropic.com/pricing is the upstream). The
 * cache multipliers are from the same skill's `shared/prompt-caching.md`
 * § Economics: a cache **read** is 0.1x the base input rate, a cache **write**
 * is 1.25x it for the five-minute TTL and 2x it for the one-hour TTL.
 *
 * Both write rates are here because both are used. The Messages API path takes
 * the default five-minute TTL. The Claude Agent SDK path (the subscription
 * transport, Task 6c) writes **one-hour** cache entries — observed on the wire
 * 2026-09-09 as `cache_creation.ephemeral_1h_input_tokens` on every turn, and
 * priced at 2x in the SDK's own cost figure — so a step records how many of its
 * cache-write tokens were one-hour ones and prices those at the higher rate. A
 * table with only the 1.25x rate under-charged every subscription run by 37.5%
 * of its cache writes, which is most of a research run's input.
 *
 * Haiku is in the table because the Agent SDK's subprocess makes a small Haiku
 * call of its own per run (observed: ~900 input tokens, ~15 output), reported
 * under `modelUsage` and nowhere else. The ledger records it as a model step so
 * the run total is the whole run; a table without it would have to drop the
 * row or refuse the run.
 *
 * ## What is billed, and what is not billed twice
 *
 * Two things in the AI SDK's usage block are sums and not addends, and pricing
 * them as addends is the obvious way to double-charge:
 *
 *   * `inputTokens` is the **total**: non-cached + cache reads + cache writes.
 *     So the three details are what gets priced, each at its own rate, and the
 *     total is priced at nothing.
 *   * `outputTokens` **includes** reasoning tokens (`outputTokenDetails.text`
 *     is the total minus them). Reasoning is billed at the ordinary output
 *     rate, so the total is priced once and `tokensReasoning` is recorded for
 *     the reader, not charged again.
 *
 * ## Arithmetic
 *
 * Integer, in micro-dollars, with `BigInt`. `agent_run_steps.cost` is
 * `Decimal(12,6)` precisely so that money added up thousands of times does not
 * drift, and computing it in a float first would hand Prisma the drift already
 * made. One micro-dollar is the column's last digit, which makes the rounding
 * question exactly "what does the sixth decimal place do" and nothing more.
 */

/** Rates in **micro-dollars per million tokens**, which is `$/MTok * 1e6`. */
export type ModelPrice = {
  /** Non-cached input tokens. */
  input: bigint;
  /** Output tokens, reasoning included. */
  output: bigint;
  /** Cached input tokens read back. 0.1x input. */
  cacheRead: bigint;
  /** Input tokens written to the cache. 1.25x input, five-minute TTL. */
  cacheWrite: bigint;
  /** Input tokens written to the cache with the one-hour TTL. 2x input. */
  cacheWrite1h: bigint;
};

/** `$/MTok` as written in the source, to micro-dollars per MTok. */
function perMTok(dollars: number): bigint {
  // Through a fixed-point string rather than `dollars * 1e6`: 0.1 * 5 * 1e6 is
  // 500000.0000000001 in binary floating point, and a rate that is wrong in its
  // last digit is a cost that is wrong in its last digit on every row.
  return BigInt(dollars.toFixed(6).replace(".", ""));
}

function ratesFor(inputDollars: number, outputDollars: number): ModelPrice {
  return {
    input: perMTok(inputDollars),
    output: perMTok(outputDollars),
    cacheRead: perMTok(inputDollars * 0.1),
    cacheWrite: perMTok(inputDollars * 1.25),
    cacheWrite1h: perMTok(inputDollars * 2),
  };
}

/**
 * The pinned table. The two §24 names, plus Haiku for the Agent SDK's own side
 * call (see the module comment); an unknown id is a throw rather than a guess —
 * a run priced at zero is worse than a run that refuses to start.
 */
export const PRICES = Object.freeze({
  "claude-opus-5": ratesFor(5.0, 25.0),
  "claude-sonnet-5": ratesFor(2.0, 10.0),
  "claude-haiku-4-5": ratesFor(1.0, 5.0),
  // `satisfies`, never an annotation. `Readonly<Record<string, ModelPrice>>`
  // widens the key type to `string`, which collapses `PricedModel` below to
  // `string` as well — and then `makeModel("gpt-5")` typechecks and the only
  // thing standing between a run and an unpriced model is the run-time throw.
}) satisfies Record<string, ModelPrice>;

/** Every model id this runtime will price. */
export type PricedModel = keyof typeof PRICES;

export function isPricedModel(id: string): id is PricedModel {
  return Object.hasOwn(PRICES, id);
}

/**
 * A hash over the table, so a changed rate is a changed hash.
 *
 * Over a canonical rendering — ids sorted, every rate as a decimal string —
 * rather than over this file, which carries prose that may be edited without
 * re-pricing anything.
 */
export const PRICE_TABLE_SHA256: string = createHash("sha256")
  .update(
    JSON.stringify(
      Object.entries(PRICES)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([id, price]) => [
          id,
          price.input.toString(),
          price.output.toString(),
          price.cacheRead.toString(),
          price.cacheWrite.toString(),
          price.cacheWrite1h.toString(),
        ]),
    ),
  )
  .digest("hex");

/**
 * The token counts a step is priced from — the AI SDK's usage block, flattened,
 * with every `undefined` already resolved to a number by the caller.
 *
 * `tokensIn` is present and deliberately unused in the arithmetic: it is the
 * provider's total, recorded on the row because the rubric compares the row to
 * the response, and priced through its three parts instead. See the module
 * comment.
 */
export type StepUsage = {
  /** `usage.inputTokens` — the total. Recorded, not priced. */
  tokensIn: number;
  /** `usage.inputTokenDetails.noCacheTokens`. */
  tokensInUncached: number;
  /** `usage.inputTokenDetails.cacheReadTokens`. */
  tokensCacheRead: number;
  /** `usage.inputTokenDetails.cacheWriteTokens` — every cache write, both TTLs. */
  tokensCacheWrite: number;
  /**
   * How many of `tokensCacheWrite` were one-hour writes, from the provider's
   * `cache_creation.ephemeral_1h_input_tokens`. Zero when the provider does not
   * say, which is the five-minute default. Never more than `tokensCacheWrite`.
   */
  tokensCacheWrite1h: number;
  /** `usage.outputTokens` — the total, reasoning included. */
  tokensOut: number;
};

const MILLION = 1_000_000n;

/**
 * Round a micro-dollar quotient half-up.
 *
 * Half-up rather than banker's rounding because the comparison this has to
 * survive is "within $0.0001 of the provider's own figure", and the provider
 * rounds the way an invoice does.
 */
function divideRound(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

/** What one model call cost, in whole micro-dollars. */
export function costMicroDollars(usage: StepUsage, model: string): bigint {
  const price = (PRICES as Record<string, ModelPrice | undefined>)[model];
  if (price === undefined) {
    // Named, because the list of what is priced is short and the fix is either
    // a line in this file or a typo in a brief.
    throw new Error(
      `pricing: no pinned price for model ${JSON.stringify(model)} (priced: ${Object.keys(PRICES).sort().join(", ")})`,
    );
  }
  for (const [field, value] of Object.entries(usage)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`pricing: ${field} must be a non-negative whole number of tokens, got ${value}`);
    }
  }
  if (usage.tokensCacheWrite1h > usage.tokensCacheWrite) {
    throw new Error(
      `pricing: ${usage.tokensCacheWrite1h} one-hour cache-write tokens exceed the ${usage.tokensCacheWrite} cache-write tokens they are part of`,
    );
  }
  const cacheWrite5m = usage.tokensCacheWrite - usage.tokensCacheWrite1h;
  const micro =
    BigInt(usage.tokensInUncached) * price.input +
    BigInt(usage.tokensCacheRead) * price.cacheRead +
    BigInt(cacheWrite5m) * price.cacheWrite +
    BigInt(usage.tokensCacheWrite1h) * price.cacheWrite1h +
    BigInt(usage.tokensOut) * price.output;
  return divideRound(micro, MILLION);
}

/**
 * What one model call cost, as the string Prisma stores in a `Decimal(12,6)`.
 *
 * A string and not a `number`: the column has six decimal places and a JS
 * number has no decimal places at all, only binary ones.
 */
export function cost(usage: StepUsage, model: string): string {
  return formatMicroDollars(costMicroDollars(usage, model));
}

/** Micro-dollars to a fixed six-decimal dollar string. */
export function formatMicroDollars(micro: bigint): string {
  const negative = micro < 0n;
  const absolute = negative ? -micro : micro;
  const whole = absolute / MILLION;
  const fraction = (absolute % MILLION).toString().padStart(6, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}
