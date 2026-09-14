/**
 * The normalisations leadgen v2.1 §8 names, in one place so that ranking,
 * holds and translation compare strings the same way.
 */

/** v2.1 §8 `norm(s)`: NFKC, lower case, "&" as "and", punctuation stripped, whitespace collapsed. */
export function norm(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * A domain as the per-company cap, the seed match and the firm exclusions
 * compare it: lower case, no scheme, path or port, no leading `www.`.
 *
 * v2.1 §8 says "registrable domain". This is the host with `www.` removed, not
 * a public-suffix calculation: `uk.acme.com` and `acme.com` are two keys. It
 * never merges two companies that are different, which is the direction that
 * matters for a cap; it may treat one company's two hosts as two.
 */
export function domainKey(value: string | undefined | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  let host = value.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  host = host.split(/[/?#]/)[0] ?? "";
  host = host.split(":")[0] ?? "";
  host = host.replace(/\.$/, "").replace(/^www\./, "");
  return host === "" ? undefined : host;
}

const LEGAL_SUFFIXES = new Set(["ltd", "limited", "plc", "llp", "llc", "inc"]);

/** v2.1 §8: a firm's name for matching, with one trailing legal suffix removed. */
export function firmNameKey(name: string): string {
  const words = norm(name).split(" ");
  if (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1] ?? "")) words.pop();
  return words.join(" ");
}

/** True when `phrase` appears in `text` as whole words, after `norm`. */
export function containsPhrase(text: string, phrase: string): boolean {
  const needle = norm(phrase);
  return needle !== "" && ` ${norm(text)} `.includes(` ${needle} `);
}

/** Plain string order, the same on every machine: never locale-dependent. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
