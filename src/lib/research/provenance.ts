import { MODULE_IDS, moduleItems, type ModuleId, type PackShape } from "../../../agents/research/output.schema";
import type { Item } from "../../../agents/_shared/item.schema";
import type { Corpus } from "@/lib/research/corpus";

/**
 * The mechanical provenance check (research v2 §7), before ingest.
 *
 * For every Item in the pack: at least one of its evidence URLs must be a page
 * or snippet the run actually stored, and that text must carry either the
 * cited number, a six-word span of the quote, or two of the item's three most
 * distinctive content words. An item that fails is not dropped — it is
 * demoted to `speculative` and says why in `inferredFrom` — and it is listed
 * in the report. A pack with more than twenty percent failures is rejected by
 * the caller and re-run once with the failures named.
 *
 * "Distinctive" is measured against the run's own corpus: of the item's
 * content words (four letters or more, not in the stoplist), the three with
 * the lowest document frequency across the stored pages, longest first on a
 * tie. A word that appears on every page proves nothing; a word that appears
 * on one page is the item's fingerprint.
 */

export const PROVENANCE_FAIL_FRACTION = 0.2;

export type ProvenanceFailure = { module: ModuleId | "insufficient"; id: string; text: string; reason: string };
export type ProvenanceReport = {
  total: number;
  passed: number;
  failed: ProvenanceFailure[];
  /** `failed.length / total`, zero for an empty pack. */
  fraction: number;
  /** At least one module is over the threshold: the caller re-asks those modules once. */
  rejected: boolean;
  modules: ModuleProvenance[];
};

export type ProvenanceResult = { pack: PackShape; report: ProvenanceReport };

const STOPWORDS = new Set(
  `about above after again against also among another any because been before being below between both
   came cannot come could does doing done down during each either else enough even ever every from further
   getting goes going gone have having here hers herself himself into itself just keep keeps kept less like
   made make makes making many might more most much must myself near need needs never next none only onto
   other ought ours ourselves over same seem seemed seems several shall should since some something still
   such than that their theirs them themselves then there these they this those through thus told took
   toward towards under until upon used using very want wants were what whatever when where whether which
   while whom whose will with within without would your yours yourself yourselves said says will year years
   month months week weeks today firm firms company companies people person business services service`
    .split(/\s+/)
    .filter((word) => word.length > 0),
);

/** Lower-case, NFKC, punctuation to spaces, one space between words. */
export function normalise(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Numbers of two or more digits, or a percentage, or a unit-suffixed figure, commas removed: `2.3m`, `48%`, `1,200`. */
export function citedNumbers(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(/\d[\d,]*(?:\.\d+)?(?:%|(?:bn|k|m)\b)?/gi)) {
    const value = match[0].replace(/,/g, "").toLowerCase();
    if (/[%a-z]$/.test(value) || value.replace(/\D/g, "").length >= 2) out.add(value);
  }
  return [...out];
}

export function contentWords(text: string): string[] {
  return normalise(text)
    .split(" ")
    .filter((word) => word.length >= 4 && !STOPWORDS.has(word) && !/^\d+$/.test(word));
}

/** Six-word windows of the normalised quote; the whole quote when it is shorter. */
export function quoteSpans(quote: string, size = 6): string[] {
  const words = normalise(quote).split(" ").filter((word) => word.length > 0);
  if (words.length <= size) return words.length === 0 ? [] : [words.join(" ")];
  const spans: string[] = [];
  for (let i = 0; i + size <= words.length; i += 1) spans.push(words.slice(i, i + size).join(" "));
  return spans;
}

type Match = { passed: true; how: string } | { passed: false; reason: string };

export function matchItem(item: Item, corpus: Corpus, distinctive: (text: string) => string[]): Match {
  const present = item.evidence.urls.filter((url) => corpus.has(url));
  if (present.length === 0) {
    return { passed: false, reason: item.evidence.urls.length === 0 ? "no evidence url" : "no evidence url was fetched or seen this run" };
  }
  const pages = present.map((url) => normalise(corpus.textFor(url)));
  const numbersNormalised = pages.map((page) => page.replace(/\s/g, ""));

  const numbers = citedNumbers(`${item.text} ${item.quote ?? ""}`);
  for (const number of numbers) {
    const needle = normalise(number).replace(/\s/g, "");
    if (needle.length > 0 && numbersNormalised.some((page) => page.includes(needle))) return { passed: true, how: `number ${number}` };
  }

  if (item.quote !== undefined) {
    for (const span of quoteSpans(item.quote)) {
      if (pages.some((page) => page.includes(span))) return { passed: true, how: `quote span "${span}"` };
    }
  }

  const words = distinctive(item.text);
  const hits = words.filter((word) => pages.some((page) => page.includes(word)));
  if (words.length >= 2 && hits.length >= 2) return { passed: true, how: `words ${hits.join(", ")}` };

  return {
    passed: false,
    reason:
      numbers.length > 0
        ? `cited number not on the page (${numbers.join(", ")})`
        : item.quote !== undefined
          ? "no six-word span of the quote on the page"
          : `fewer than two of its distinctive words on the page (${words.join(", ") || "none"})`,
  };
}

/**
 * Rank an item's content words by how rare they are across the corpus.
 *
 * A word on no stored page is not distinctive, it is absent: it cannot tie
 * the item to a page, so it is left out. Of the rest, the rarest three —
 * fewest pages, longest first on a tie — are the item's fingerprint. An item
 * with fewer than two such words fails, which is what a paraphrase sharing no
 * words with its source deserves.
 */
export function distinctiveWords(corpus: Corpus): (text: string) => string[] {
  const pages = corpus.urls().map((url) => new Set(contentWords(corpus.textFor(url))));
  const frequency = (word: string): number => pages.reduce((count, page) => count + (page.has(word) ? 1 : 0), 0);
  return (text: string) => {
    const unique = [...new Set(contentWords(text))];
    return unique
      .map((word) => ({ word, df: frequency(word) }))
      .filter((entry) => entry.df > 0)
      .sort((a, b) => a.df - b.df || b.word.length - a.word.length || (a.word < b.word ? -1 : 1))
      .slice(0, 3)
      .map((entry) => entry.word);
  };
}

/** One module's report: the caller re-asks a module whose fraction is over the threshold (§7). */
export type ModuleProvenance = { module: ModuleId; total: number; passed: number; failed: ProvenanceFailure[]; fraction: number; rejected: boolean };

/**
 * Check every item, module by module; demote the failures in place on a copy;
 * report per module and for the pack.
 *
 * Research v3 §7: provenance runs per module and the handler re-asks only the
 * failing modules, never the run. `report.rejected` therefore means "at least
 * one module is over the threshold", and `modules` says which.
 */
export function checkProvenance(pack: PackShape, corpus: Corpus): ProvenanceResult {
  const copy = structuredClone(pack);
  const distinctive = distinctiveWords(corpus);
  const modules: ModuleProvenance[] = [];
  const failed: ProvenanceFailure[] = [];
  let total = 0;
  for (const id of MODULE_IDS) {
    const moduleFailed: ProvenanceFailure[] = [];
    let moduleTotal = 0;
    for (const item of moduleItems(copy, id)) {
      // A guess that says it is a guess — `speculative`, no url, and what it
      // was inferred from — has nothing to check against a page, and the
      // schema already requires exactly that of it. Counting it as a failure
      // re-asked eight honest modules on brief E (2026-09-10) and rewarded
      // deleting the guess or inventing a citation. Only a claim that cites a
      // page is checked against the pages.
      if (item.evidence.urls.length === 0 && item.confidence === "speculative" && item.inferredFrom !== undefined) continue;
      moduleTotal += 1;
      const match = matchItem(item, corpus, distinctive);
      if (match.passed) continue;
      moduleFailed.push({ module: id, id: item.id, text: item.text, reason: match.reason });
      item.confidence = "speculative";
      item.inferredFrom = `provenance: ${match.reason}`;
    }
    if (moduleTotal === 0) continue;
    const fraction = moduleFailed.length / moduleTotal;
    modules.push({ module: id, total: moduleTotal, passed: moduleTotal - moduleFailed.length, failed: moduleFailed, fraction, rejected: fraction > PROVENANCE_FAIL_FRACTION });
    total += moduleTotal;
    failed.push(...moduleFailed);
  }
  if (copy.insufficient !== undefined) {
    for (const item of copy.insufficient.found) {
      total += 1;
      const match = matchItem(item, corpus, distinctive);
      if (match.passed) continue;
      failed.push({ module: "insufficient", id: item.id, text: item.text, reason: match.reason });
      item.confidence = "speculative";
      item.inferredFrom = `provenance: ${match.reason}`;
    }
  }
  const fraction = total === 0 ? 0 : failed.length / total;
  return {
    pack: copy,
    report: { total, passed: total - failed.length, failed, fraction, rejected: modules.some((m) => m.rejected), modules },
  };
}
