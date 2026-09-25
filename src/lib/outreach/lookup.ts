import { createHash } from "node:crypto";

import { PRODUCT_LINES, type LookupItem, type LookupResult, type ProductLine } from "../../../agents/outreach/input.schema";
import { hostOf } from "../../../agents/_shared/item.schema";
import { domainKey } from "@/lib/leadgen/normalise";
import { capText, scrubFetched } from "@/lib/research/scrub";
import type { FetchService, PageRead, SearchHit, SearchService } from "@/lib/services";

/**
 * Outreach §4, as amended by v2.1 §3: the lookup, a tool step run by code
 * before the model.
 *
 * Person evidence first. If nothing genuinely useful, account evidence. If
 * nothing again, no further call: the role problem is used, which is the
 * normal case and a good email. Two searches and two fetches are a maximum,
 * not a quota, and the lookup stops the moment it has a usable, relevant item.
 *
 * `usable` means all of: dated within twelve months, or undated on the firm's
 * own site; from a page this lookup fetched and scanned for injection; about
 * this person (Tier 1) or their firm (Tier 2) by name; relevant to the role's
 * needs or the plan's pains; and professional, never personal life. The quote
 * is the page's own sentence, so the card shows exactly what the email rests on.
 *
 * Undated hits (trial fix 1, 25 Sep 2026). Tavily's general search dates
 * almost nothing: in the 24 Sep live trial every hit came back with no date,
 * so every hit was dropped and the lookup was empty for 7 people of 7. A hit
 * without a date is now still read when it names the person or the firm, and
 * its date is taken from the page when the page gives one. A page still
 * undated after that is used only when it is on the firm's own domain (its
 * complaints policy, say), and then only as a `weak` item. A dated item older
 * than twelve months is dropped, whether the search or the page dated it.
 *
 * The lookup also says which product lines the firm sells, when its words say
 * so (`linesOf`): the ombudsman's motor figure is no give for a travel insurer.
 */

export type LookupSubject = {
  personName: string;
  company: string;
  domain?: string;
  /** ISO-3166 alpha-2. */
  region: string;
  /** Words the evidence must touch to be relevant: the role's needs, the plan's pains and hook. */
  relevance: readonly string[];
  /** The plan's trigger words, for the account search. */
  triggers: readonly string[];
};

export type LookupDeps = {
  search: SearchService;
  fetch: FetchService;
  now?: () => Date;
  log?: (line: Record<string, unknown>) => void;
};

/** Each call the lookup made, in order, for the draft's record. */
export type LookupTrail = { kind: "search" | "fetch"; target: string; outcome: string }[];

const MAX_MONTHS = 12;

/** Personal-life words: an item that leans on them is never an opener (v2.1 §3). */
const PERSONAL = /\b(?:marathon|charity (?:run|ride|walk|climb)|wedding|married|engaged|baby|birthday|holiday|honeymoon|daughter|son|wife|husband|partner's|hobby|golf|triathlon|half-marathon|funeral|bereavement|illness|diagnosis|pregnan\w*)\b/i;

const STOP = new Set(
  "about after again against their there these those which while would could should other every where within without being having because between through during before under above using across still often really".split(" "),
);

/** The distinct relevance words: five letters or more, not stop words. */
function relevanceWords(terms: readonly string[]): Set<string> {
  return new Set(
    terms
      .flatMap((term) => term.toLowerCase().match(/[a-z]{5,}/g) ?? [])
      .filter((word) => !STOP.has(word)),
  );
}

/**
 * The two words that most say what the plan is about, for the account
 * search: six letters or more, not stop words, not the firm's own name, the
 * most repeated across the plan's triggers and the role's needs first. A
 * trigger's first words ("named in the...") say nothing a search can use.
 */
function accountWords(terms: readonly string[], company: string): string[] {
  const own = new Set(company.toLowerCase().match(/[a-z]+/g) ?? []);
  const counts = new Map<string, { word: string; count: number; first: number }>();
  let index = 0;
  for (const word of terms.flatMap((term) => term.toLowerCase().match(/[a-z]{6,}/g) ?? [])) {
    index += 1;
    if (STOP.has(word) || own.has(word)) continue;
    // "complaint" and "complaints" are one word to a search engine.
    const stem = word.replace(/s$/, "");
    if (own.has(stem)) continue;
    const seen = counts.get(stem);
    counts.set(stem, { word: seen?.word ?? word, count: (seen?.count ?? 0) + 1, first: seen?.first ?? index });
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.first - b.first)
    .slice(0, 2)
    .map((entry) => entry.word);
}

const MONTHS = "january february march april may june july august september october november december".split(" ");
const MONTH_NAMES = MONTHS.join("|");

/**
 * The date a page says it was published or updated, as `YYYY-MM-DD`, or undefined.
 *
 * A date the page labels ("Published 3 June 2026", "Last updated: 2026-06-03") wherever it sits, else a
 * bare date in the page's first 300 characters, where a byline is. Never any other date in the body: a
 * policy page that says "from 22 October 2026" is about that day, not written on it. A date after `now`
 * is not a publication date.
 */
export function pageDate(markdown: string, now: Date): string | undefined {
  const DAY_MONTH_YEAR = `(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAMES})\\s+(\\d{4})`;
  const MONTH_DAY_YEAR = `(${MONTH_NAMES})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})`;
  const ISO = "(\\d{4})-(\\d{2})-(\\d{2})";
  const DATE = `(?:${DAY_MONTH_YEAR}|${MONTH_DAY_YEAR}|${ISO})`;
  const read = (match: RegExpExecArray, offset: number): string | undefined => {
    const [dmyDay, dmyMonth, dmyYear, mdyMonth, mdyDay, mdyYear, isoYear, isoMonth, isoDay] = match.slice(offset, offset + 9);
    const iso =
      isoYear !== undefined
        ? `${isoYear}-${isoMonth}-${isoDay}`
        : dmyYear !== undefined
          ? `${dmyYear}-${String(MONTHS.indexOf(dmyMonth!.toLowerCase()) + 1).padStart(2, "0")}-${dmyDay!.padStart(2, "0")}`
          : `${mdyYear}-${String(MONTHS.indexOf(mdyMonth!.toLowerCase()) + 1).padStart(2, "0")}-${mdyDay!.padStart(2, "0")}`;
    const at = new Date(`${iso}T00:00:00Z`);
    return Number.isNaN(at.getTime()) || at.getTime() > now.getTime() ? undefined : iso;
  };
  const labelled = new RegExp(`\\b(?:published|updated|posted|last (?:updated|reviewed|modified)|date)\\b\\W{0,3}(?:on\\s+)?${DATE}`, "gi");
  for (const match of markdown.matchAll(labelled)) {
    const date = read(match, 1);
    if (date !== undefined) return date;
  }
  const byline = new RegExp(DATE, "i").exec(markdown.slice(0, 300));
  return byline === null ? undefined : read(byline, 1);
}

/**
 * The product lines a text says a firm sells, by keyword, no model (trial fix 1). A line counts when its
 * words appear at least twice: a travel insurer's page that mentions car hire once does not sell motor.
 * A word in the firm's own name counts once ("Brackenfield Legal"), so it tips a line the page also mentions but never
 * decides one alone: Legal & General sells more than legal expenses. `min` is lower for a short label.
 */
const LINE_WORDS: Record<ProductLine, RegExp> = {
  motor: /\b(?:motor|car insurance|van insurance|motorcycles?|motorbikes?|vehicle insurance)\b/gi,
  home: /\b(?:home insurance|household insurance|buildings insurance|contents insurance|home and contents|buildings and contents)\b/gi,
  travel: /\b(?:travel insurance|travel cover|holiday insurance)\b/gi,
  pet: /\b(?:pet insurance|pet cover)\b/gi,
  "legal-expenses": /\b(?:legal expenses?|legal protection|after the event insurance)\b/gi,
};

/** A line's short word in a firm's own name: "Brackenfield Legal", "Wayfarer Travel". Too loose for page text. */
const NAME_WORDS: Record<ProductLine, RegExp> = {
  motor: /\b(?:motor|car|van)\b/gi,
  home: /\bhome\b/gi,
  travel: /\b(?:travel|holidays?)\b/gi,
  pet: /\bpets?\b/gi,
  "legal-expenses": /\blegal\b/gi,
};

export function linesOf(text: string, company = "", min = 2): ProductLine[] {
  return PRODUCT_LINES.filter((line) => (text.match(LINE_WORDS[line]) ?? []).length + (company.match(NAME_WORDS[line]) ?? []).length >= min);
}

function monthsOld(published: string | undefined, now: Date): number | null {
  if (published === undefined) return null;
  const at = new Date(published.length === 4 ? `${published}-01-01` : published.length === 7 ? `${published}-01` : published);
  if (Number.isNaN(at.getTime())) return null;
  return (now.getTime() - at.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
}

function dateOf(published: string): string {
  return published.slice(0, 10);
}

function sentencesOf(markdown: string): string[] {
  return markdown
    .replace(/[#*_>`|]/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .split(/(?<=[.?!])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0);
}

/** The page's own sentence that names the subject and touches the plan, or null. */
function relevantSentence(page: string, names: readonly string[], relevance: Set<string>): string | null {
  for (const sentence of sentencesOf(page)) {
    const count = sentence.split(" ").length;
    if (count < 6 || count > 60) continue;
    const lower = sentence.toLowerCase();
    if (!names.some((name) => name.length > 0 && lower.includes(name.toLowerCase()))) continue;
    if (PERSONAL.test(sentence)) continue;
    const touched = new Set((lower.match(/[a-z]{5,}/g) ?? []).filter((word) => relevance.has(word)));
    if (touched.size >= 2) return sentence;
  }
  return null;
}

function itemId(url: string, sentence: string): string {
  return `look-${createHash("sha256").update(`${url}\n${sentence}`).digest("hex").slice(0, 12)}`;
}

/** Firecrawl, then Tavily's extract, as research's fetch cascade does (§4). */
async function read(deps: LookupDeps, url: string): Promise<PageRead> {
  const first = await deps.fetch.scrape(url);
  if (!("unreadable" in first)) return first;
  const second = await deps.search.extract(url);
  return "unreadable" in second ? { unreadable: true, reason: `${first.reason}; ${second.reason}` } : second;
}

type Step = { about: "person" | "firm"; query: string; names: string[]; mention: (hit: SearchHit) => boolean };

export async function lookupEvidence(subject: LookupSubject, deps: LookupDeps): Promise<LookupResult & { trail: LookupTrail }> {
  const now = (deps.now ?? (() => new Date()))();
  const relevance = relevanceWords(subject.relevance);
  const trail: LookupTrail = [];
  let searches = 0;
  let fetches = 0;
  const surname = subject.personName.trim().split(/\s+/).at(-1) ?? subject.personName;
  const company = subject.company.trim();
  const companyDomain = domainKey(subject.domain);
  const triggerWords = accountWords([...subject.triggers, ...subject.relevance], company);

  const steps: Step[] = [
    {
      about: "person",
      query: `"${subject.personName}" "${company}"`,
      names: [subject.personName, surname],
      mention: (hit) => `${hit.title} ${hit.snippet}`.toLowerCase().includes(surname.toLowerCase()),
    },
    {
      about: "firm",
      query: `"${company}"${triggerWords.length === 0 ? "" : ` ${triggerWords.join(" ")}`}`,
      names: [company],
      mention: (hit) => `${hit.title} ${hit.snippet}`.toLowerCase().includes(company.toLowerCase()) || (companyDomain !== undefined && domainKey(hit.url) === companyDomain),
    },
  ];

  // The firm's name as whole words: "Arc" is not in "research".
  const firmName = new RegExp(`(^|[^a-z0-9])${company.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`);
  const namesFirm = (text: string) => company !== "" && firmName.test(text.toLowerCase());
  const onFirmSite = (url: string) => companyDomain !== undefined && domainKey(url) === companyDomain;
  // What the lookup read about the firm, for its product lines: hit titles and snippets that name it, and the pages.
  const firmText: string[] = [];
  const lines = () => linesOf(firmText.join("\n"), company);

  for (const step of steps) {
    searches += 1;
    const { hits } = await deps.search.search({ query: step.query, region: subject.region, recencyMonths: MAX_MONTHS, maxResults: 5 });
    const named = hits.filter((hit) => step.mention(hit));
    firmText.push(...hits.filter((hit) => onFirmSite(hit.url) || namesFirm(`${hit.title} ${hit.snippet}`)).map((hit) => `${hit.title}\n${hit.snippet}`));
    // A dated hit must be within twelve months. An undated one is still worth a read when it names them: its date may be on the page.
    const candidates = named.filter((hit) => {
      const age = monthsOld(hit.publishedAt, now);
      return age === null || (age >= 0 && age <= MAX_MONTHS);
    });
    const dated = candidates.filter((hit) => monthsOld(hit.publishedAt, now) !== null).length;
    trail.push({ kind: "search", target: step.query, outcome: `${hits.length} results, ${candidates.length} about ${step.about === "person" ? "them" : "the firm"} and not stale (${dated} dated)` });
    // The best one to read: dated first, then the firm's own site, then the rest in the search's order.
    const rank = (hit: SearchHit) => (monthsOld(hit.publishedAt, now) !== null ? 0 : onFirmSite(hit.url) ? 1 : 2);
    const best = [...candidates].sort((a, b) => rank(a) - rank(b))[0];
    // Nothing worth reading: no fetch is spent on it, and the next step is tried.
    if (best === undefined) continue;

    fetches += 1;
    const page = await read(deps, best.url);
    if ("unreadable" in page) {
      trail.push({ kind: "fetch", target: best.url, outcome: "unreadable" });
      continue;
    }
    const { text, stripped } = scrubFetched(page.markdown);
    if (stripped.length > 0) deps.log?.({ event: "outreach.lookup.stripped", url: best.url, lines: stripped.length });
    const capped = capText(text);
    if (onFirmSite(best.url) || namesFirm(capped)) firmText.push(capped);
    const primary = onFirmSite(best.url);
    const published = monthsOld(best.publishedAt, now) === null ? pageDate(capped, now) : best.publishedAt;
    const age = monthsOld(published, now);
    if (age !== null && (age < 0 || age > MAX_MONTHS)) {
      trail.push({ kind: "fetch", target: best.url, outcome: `stale (the page is dated ${dateOf(published!)})` });
      continue;
    }
    if (published === undefined && !primary) {
      trail.push({ kind: "fetch", target: best.url, outcome: "undated, and not the firm's own site" });
      continue;
    }
    const sentence = relevantSentence(capped, step.names, relevance);
    trail.push({ kind: "fetch", target: best.url, outcome: sentence === null ? "nothing relevant" : published === undefined ? "relevant, undated on the firm's own site" : "relevant" });
    if (sentence === null) continue;

    const host = hostOf(best.url);
    const item: LookupItem = {
      id: itemId(best.url, sentence),
      text: sentence.length > 400 ? `${sentence.slice(0, 399)}…` : sentence,
      quote: sentence,
      ...(published === undefined ? {} : { publishedAt: dateOf(published) }),
      accessedAt: now.toISOString().slice(0, 10),
      evidence: { urls: [best.url], primary, domains: [host] },
      // Undated is never better than weak, even on the firm's own site: nothing says it is still true.
      confidence: primary && published !== undefined ? "strong" : "weak",
      about: step.about,
    };
    // Stop at the first usable, relevant item (v2.1 §3).
    const found = lines();
    return { items: [item], usable: true, searches, fetches, ...(found.length === 0 ? {} : { lines: found }), trail };
  }
  const found = lines();
  return { items: [], usable: false, searches, fetches, ...(found.length === 0 ? {} : { lines: found }), trail };
}
