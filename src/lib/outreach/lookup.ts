import { createHash } from "node:crypto";

import type { LookupItem, LookupResult } from "../../../agents/outreach/input.schema";
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
 * `usable` means all of: dated within twelve months; from a page this lookup
 * fetched and scanned for injection; about this person (Tier 1) or their firm
 * (Tier 2) by name; relevant to the role's needs or the plan's pains; and
 * professional, never personal life. The quote is the page's own sentence, so
 * the card shows exactly what the email rests on.
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

  for (const step of steps) {
    searches += 1;
    const { hits } = await deps.search.search({ query: step.query, region: subject.region, recencyMonths: MAX_MONTHS, maxResults: 5 });
    const fresh = hits.filter((hit) => {
      const age = monthsOld(hit.publishedAt, now);
      return age !== null && age >= 0 && age <= MAX_MONTHS && step.mention(hit);
    });
    trail.push({ kind: "search", target: step.query, outcome: `${hits.length} results, ${fresh.length} dated and about ${step.about === "person" ? "them" : "the firm"}` });
    const best = fresh[0];
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
    const sentence = relevantSentence(capText(text), step.names, relevance);
    trail.push({ kind: "fetch", target: best.url, outcome: sentence === null ? "nothing relevant" : "relevant" });
    if (sentence === null) continue;

    const host = hostOf(best.url);
    const primary = companyDomain !== undefined && domainKey(best.url) === companyDomain;
    const item: LookupItem = {
      id: itemId(best.url, sentence),
      text: sentence.length > 400 ? `${sentence.slice(0, 399)}…` : sentence,
      quote: sentence,
      ...(best.publishedAt === undefined ? {} : { publishedAt: dateOf(best.publishedAt) }),
      accessedAt: now.toISOString().slice(0, 10),
      evidence: { urls: [best.url], primary, domains: [host] },
      confidence: primary ? "strong" : "weak",
      about: step.about,
    };
    // Stop at the first usable, relevant item (v2.1 §3).
    return { items: [item], usable: true, searches, fetches, trail };
  }
  return { items: [], usable: false, searches, fetches, trail };
}
