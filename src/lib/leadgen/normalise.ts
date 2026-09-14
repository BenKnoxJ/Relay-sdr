import { getDomain } from "tldts";

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
 * The registrable domain (leadgen v2.1 §8): the one canonical domain every
 * lead gen rule compares — the per-company cap, the seed match, firm
 * exclusions, domain suppressions, the CRM company check and the reveal's
 * domain check.
 *
 * Public-suffix aware, through `tldts` (the Public Suffix List):
 * `sales.example.com`, `support.example.com` and `www.example.com` are all
 * `example.com`, and `sales.example.co.uk` is `example.co.uk`, never `co.uk`.
 * Private suffixes count as suffixes, so two sites on one shared hosting
 * domain (`a.github.io`, `b.github.io`) stay two companies.
 *
 * A host the list cannot place (an IP address, a single label) keys as the
 * cleaned host itself.
 */
export function domainKey(value: string | undefined | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  let host = value.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  host = host.split(/[/?#]/)[0] ?? "";
  host = host.replace(/^[^@]*@/, "");
  host = host.split(":")[0] ?? "";
  host = host.replace(/\.$/, "").replace(/^www\./, "");
  if (host === "") return undefined;
  return getDomain(host, { allowPrivateDomains: true }) ?? host;
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
