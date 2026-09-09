/**
 * The run's page corpus (research v2 §4, §7).
 *
 * Every page the run fetched and every search snippet it saw, keyed by
 * normalised URL. The provenance check reads it: an item's evidence has to be
 * a URL the run actually stored, and the page has to carry the number, the
 * quote or the words the item rests on. It is filled by the tool wrapper
 * *outside* `withReplay`, so a replayed call fills it exactly as a live one
 * did, and it is scoped to one handler attempt so the automatic re-run shares
 * the first attempt's pages.
 */

export type CorpusEntry = {
  url: string;
  text: string;
  snippets: string[];
};

export type Corpus = {
  addPage(url: string, text: string): void;
  addSnippet(url: string, snippet: string): void;
  markUnreadable(url: string): void;
  has(url: string): boolean;
  /** Page text and snippets joined, for matching. Empty string when unknown. */
  textFor(url: string): string;
  urls(): string[];
  readonly unreadable: ReadonlySet<string>;
  size(): number;
};

/** Lower-case host, no `www.`, no fragment, no trailing slash, no default port. */
export function normaliseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return raw.trim().toLowerCase();
  }
  url.hash = "";
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const port = url.port === "" || url.port === "80" || url.port === "443" ? "" : `:${url.port}`;
  const path = url.pathname.replace(/\/+$/, "") || "";
  return `${url.protocol}//${host}${port}${path}${url.search}`;
}

export function createCorpus(): Corpus {
  const pages = new Map<string, CorpusEntry>();
  const unreadable = new Set<string>();
  const entry = (url: string): CorpusEntry => {
    const key = normaliseUrl(url);
    let found = pages.get(key);
    if (found === undefined) {
      found = { url: key, text: "", snippets: [] };
      pages.set(key, found);
    }
    return found;
  };
  return {
    addPage(url, text) {
      entry(url).text = text;
    },
    addSnippet(url, snippet) {
      const found = entry(url);
      if (!found.snippets.includes(snippet)) found.snippets.push(snippet);
    },
    markUnreadable(url) {
      unreadable.add(normaliseUrl(url));
    },
    has(url) {
      const found = pages.get(normaliseUrl(url));
      return found !== undefined && (found.text.length > 0 || found.snippets.length > 0);
    },
    textFor(url) {
      const found = pages.get(normaliseUrl(url));
      if (found === undefined) return "";
      return [found.text, ...found.snippets].filter((part) => part.length > 0).join("\n");
    },
    urls() {
      return [...pages.keys()];
    },
    unreadable,
    size() {
      return pages.size;
    },
  };
}
