import { createHash } from "node:crypto";

/**
 * `Job.responseDigest`: a fingerprint of what a handler returned.
 *
 * It lives in its own module for a blunt reason — `src/worker/main.ts` calls
 * `main()` as it loads, so anything exported from there cannot be imported by
 * a test without starting a worker. A function whose whole contract is "never
 * throws, on any value" has to be testable on its own.
 */

/**
 * A digest of what the handler returned, for `Job.responseDigest`.
 *
 * Keys are sorted before hashing, because `{a, b}` and `{b, a}` are the same
 * result and a digest that disagreed would make the column useless for the one
 * thing it is for: telling two attempts' outputs apart.
 */
export function responseDigest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

/**
 * Total by construction: there is no handler result this can throw on.
 *
 * That is a requirement and not a nicety. This runs on the success path, after
 * the handler has already done whatever it does to the outside world, and a
 * throw here would take the worker out with the job still `running` on a live
 * lease and its side effects already spent. `JSON.stringify` alone throws on a
 * BigInt and on a cycle, and returns `undefined` for a bare function — all
 * three deterministic in the value, so every restart would re-claim the job
 * and die again.
 *
 * Shared references are recorded as `[circular]` the second time they are
 * seen, which is a real inaccuracy and an acceptable one: the digest has to be
 * stable for the same result, not reversible.
 */
function canonical(value: unknown): string {
  const seen = new WeakSet<object>();
  const text = JSON.stringify(value, (_key, raw: unknown) => {
    if (typeof raw === "bigint") return raw.toString();
    if (typeof raw === "function" || typeof raw === "symbol") return null;
    if (raw === null || typeof raw !== "object") return raw;
    // Added before the copy below is returned: the copy's members are the
    // original's, so a cycle comes back through here and is caught.
    if (seen.has(raw)) return "[circular]";
    seen.add(raw);
    if (Array.isArray(raw)) return raw;
    const source = raw as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = source[key];
    return sorted;
  });
  return text ?? "null";
}
