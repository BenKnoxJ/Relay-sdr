import { describe, expect, it } from "vitest";

import { responseDigest } from "@/worker/digest";
import { RETRY_BASE_MS, RETRY_MAX_MS, retryDelayMs } from "@/worker/retry";

/**
 * `responseDigest` runs on the success path, after the handler has already
 * done whatever it does to the outside world. A throw there exits the worker
 * with the job still `running` on a live lease and its side effects spent —
 * and because it would be deterministic in the result value, every restart
 * would re-claim the job and die the same way. So the contract is that there
 * is no value it throws on, and these are the values that used to.
 */

describe("responseDigest", () => {
  it("is stable under key order", () => {
    expect(responseDigest({ a: 1, b: { c: 2, d: 3 } })).toBe(
      responseDigest({ b: { d: 3, c: 2 }, a: 1 }),
    );
  });

  it("tells different results apart", () => {
    expect(responseDigest({ ok: true })).not.toBe(responseDigest({ ok: false }));
  });

  it.each([
    ["undefined", undefined],
    ["a function", () => undefined],
    ["a symbol", Symbol("x")],
    ["a bigint", { count: 1n }],
    ["a nested function", { fn: () => undefined }],
    ["an array", [1, "two", null]],
  ])("never throws on %s", (_name, value) => {
    expect(responseDigest(value)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never throws on a cycle", () => {
    const cyclic: Record<string, unknown> = { ok: true };
    cyclic.self = cyclic;
    expect(responseDigest(cyclic)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("retryDelayMs", () => {
  it("backs off from the base and stops at the cap", () => {
    expect(retryDelayMs(1)).toBe(RETRY_BASE_MS);
    expect(retryDelayMs(2)).toBe(RETRY_BASE_MS * 2);
    expect(retryDelayMs(3)).toBe(RETRY_BASE_MS * 4);
    expect(retryDelayMs(100)).toBe(RETRY_MAX_MS);
  });

  it("never returns a negative delay for an attempt count it should never see", () => {
    expect(retryDelayMs(0)).toBe(RETRY_BASE_MS);
  });
});
