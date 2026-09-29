import { createHash } from "node:crypto";

import { generateText, type LanguageModel } from "ai";
import { z } from "zod";

import type { LookupItem, LookupResult } from "../../../agents/outreach/input.schema";
import { hostOf } from "../../../agents/_shared/item.schema";
import { domainKey } from "@/lib/leadgen/normalise";
import { scrubFetched } from "@/lib/research/scrub";

/**
 * The trigger search (28 Sep): before drafting, one web search pass on the person and their firm, looking for
 * something real to tailor the sequence to: a buying signal or trigger (news, a launch or expansion, a new
 * role, a talk or article, the firm's published complaints data, a change in the business) and what the firm
 * actually sells. It replaces the Tavily lookup, which found nothing usable for 13 of 13 people.
 *
 * The model searches; code decides what may be used. A finding is kept only when it has a real source URL, is
 * about this person at this firm or about this firm, is dated within twelve months (an undated page counts only
 * on the firm's own site, for what the firm does), and says nothing personal. Nothing found is a normal result:
 * the drafter then writes to the role and the plan.
 */

export type TriggerSubject = { personName: string; title: string; company: string; domain?: string; country: string };

const findingSchema = z.object({
  about: z.enum(["person", "firm"]),
  text: z.string().min(1).max(600),
  quote: z.string().min(1).max(600).optional(),
  url: z.string().min(1).max(2000),
  date: z.string().max(40).optional(),
});
const answerSchema = z.object({
  lines: z.array(z.string().min(1).max(60)).max(10).default([]),
  findings: z.array(findingSchema).max(8).default([]),
});
export type TriggerAnswer = z.infer<typeof answerSchema>;

/** `seen` is every URL the search's own results contained: a finding whose URL is not among them is not kept. */
export type TriggerSearchResult = { answer: TriggerAnswer; costUsd: number; searches: number; seen: readonly string[] };
export type TriggerSearch = (subject: TriggerSubject) => Promise<TriggerSearchResult>;

const MAX_MONTHS = 12;
/** Personal-life words: a finding about the person that leans on them is never kept. Firm news is not read for them ("holiday" is a travel insurer's business). */
const PERSONAL = /\b(?:marathon|charity (?:run|ride|walk|climb)|wedding|married|baby|birthday|honeymoon|daughter|son|wife|husband|hobby|golf|triathlon|funeral|bereavement|illness|diagnosis|pregnan\w*)\b/i;
const SEARCH_TIMEOUT_MS = 150_000;

export function triggerPrompt(subject: TriggerSubject): string {
  const site = subject.domain === undefined ? "" : ` (${subject.domain})`;
  return [
    `Research one B2B sales prospect with web search. Person: ${subject.personName}, ${subject.title} at ${subject.company}${site}, ${subject.country}.`,
    "Find, from the last 12 months only:",
    "1. What the firm sells and to whom, in its own words, preferably from its own website: its lines of business.",
    "2. Triggers or buying signals about the firm: news, a launch, an expansion, an acquisition, a new senior hire, a restructure, its published complaints or service data, an award, a regulatory event naming it.",
    "3. Anything public this person said or did professionally: an interview, a talk, an article, a quote in the press, a new role.",
    "Rules: every finding must come from a page you actually found, with its URL and publication date. Only this person at this firm, never someone with the same name elsewhere. Nothing personal. If you find nothing, return empty lists: that is a normal answer.",
    "Search at most three times. Reply with JSON only, no prose:",
    '{"lines": ["travel insurance", "..."], "findings": [{"about": "person" | "firm", "text": "one plain sentence saying what happened", "quote": "the page\'s own words, if short", "url": "https://...", "date": "YYYY-MM-DD"}]}',
  ].join("\n");
}

/** The live search: the SDK's own web search on the subscription (`makeWebSearchModel`). */
export type SearchObserver = { onCost: (usd: number, turns: number) => void; onUrls: (urls: readonly string[]) => void };

export function webTriggerSearch(model: (observe: SearchObserver) => LanguageModel | null): TriggerSearch {
  return async (subject) => {
    let costUsd = 0;
    let searches = 0;
    const seen = new Set<string>();
    const handle = model({
      onCost: (usd, turns) => {
        costUsd = usd;
        searches = Math.max(0, Math.min(3, turns - 1));
      },
      onUrls: (urls) => urls.forEach((url) => seen.add(normaliseUrl(url))),
    });
    if (handle === null) return { answer: { lines: [], findings: [] }, costUsd: 0, searches: 0, seen: [] };
    const { text } = await generateText({ model: handle, prompt: triggerPrompt(subject), abortSignal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
    return { answer: parseAnswer(text), costUsd, searches, seen: [...seen] };
  };
}

/** Every URL in a block of text (a search tool's result). */
export function urlsIn(text: string): string[] {
  return text.match(/https?:\/\/[^\s"'<>)\]\\]+/g) ?? [];
}

/** A URL as compared: no fragment, no trailing slash or punctuation, lower-case host. */
export function normaliseUrl(raw: string): string {
  try {
    const url = new URL(raw.replace(/[.,;:]+$/, ""));
    url.hash = "";
    const path = url.pathname.replace(/\/+$/, "");
    let decoded = path;
    try {
      // "£" and "%C2%A3" are one character: compare the decoded path.
      decoded = decodeURI(path);
    } catch {
      decoded = path;
    }
    return `${url.protocol}//${url.host.toLowerCase()}${decoded}${url.search}`;
  } catch {
    return raw;
  }
}

/** The model's JSON, or nothing: an answer that does not parse is "nothing found", never a guess. */
export function parseAnswer(text: string): TriggerAnswer {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return { lines: [], findings: [] };
  try {
    const parsed = answerSchema.safeParse(JSON.parse(text.slice(start, end + 1)));
    return parsed.success ? parsed.data : { lines: [], findings: [] };
  } catch {
    return { lines: [], findings: [] };
  }
}

/** A finding's date as `YYYY-MM-DD`, or undefined when it is not a date ("March 2026" reads as 1 March 2026). */
export function isoDate(date: string | undefined): string | undefined {
  if (date === undefined) return undefined;
  const trimmed = date.trim();
  const partial = /^\d{4}(?:-\d{2})?$/.test(trimmed) ? (trimmed.length === 4 ? `${trimmed}-01-01` : `${trimmed}-01`) : trimmed;
  const at = new Date(/^\d{4}-\d{2}-\d{2}/.test(partial) ? `${partial.slice(0, 10)}T00:00:00Z` : `${partial} UTC`);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString().slice(0, 10);
}

function monthsAgo(date: string, now: Date): number {
  return (now.getTime() - new Date(`${date}T00:00:00Z`).getTime()) / (1000 * 60 * 60 * 24 * 30.44);
}

/** The firm's name without its generic words, as one phrase: "First Central Group" is "first central". */
function firmPhrase(company: string): string {
  const generic = new Set(["group", "limited", "ltd", "plc", "the", "insurance", "services", "holdings", "uk", "co"]);
  return (company.toLowerCase().match(/[a-z0-9&]+/g) ?? []).filter((word) => !generic.has(word)).join(" ");
}

function hasWords(text: string, phrase: string): boolean {
  if (phrase === "") return false;
  const pattern = phrase.split(" ").map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  return new RegExp(`\\b${pattern}\\b`, "i").test(text);
}

function clean(text: string): string {
  return scrubFetched(text).text.replace(/\s+/g, " ").trim();
}

/**
 * The findings code keeps, as the lookup items the drafter and the checks already read. At most three, the
 * firm's own lines of business alongside.
 */
export function lookupFromTriggers(subject: TriggerSubject, result: TriggerSearchResult, now: Date): LookupResult {
  const surname = subject.personName.trim().split(/\s+/).at(-1) ?? subject.personName;
  const firm = firmPhrase(subject.company);
  const ownDomain = subject.domain === undefined ? undefined : domainKey(subject.domain);
  const seen = new Set(result.seen.map(normaliseUrl));
  const items: LookupItem[] = [];
  for (const finding of result.answer.findings) {
    if (items.length >= 3) break;
    let url: URL;
    try {
      url = new URL(finding.url);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    // Only a page the search itself returned: never a URL the model wrote from memory.
    if (!seen.has(normaliseUrl(url.href))) continue;
    const text = clean(finding.text);
    const quote = finding.quote === undefined ? undefined : clean(finding.quote);
    const said = `${text} ${quote ?? ""}`;
    if (text === "" || (finding.about === "person" && PERSONAL.test(said))) continue;
    const onOwnSite = ownDomain !== undefined && domainKey(url.href) === ownDomain;
    // The firm's whole distinctive name, as words: "First Direct" is not "First Central", "coverage" is not "Cover".
    if (!onOwnSite && !hasWords(said, firm)) continue;
    if (finding.about === "person" && !hasWords(said, surname)) continue;
    const date = isoDate(finding.date);
    const age = date === undefined ? null : monthsAgo(date, now);
    // Dated within twelve months; undated only on the firm's own site, and only about the firm.
    if (age === null ? !(onOwnSite && finding.about === "firm") : age < -1 || age > MAX_MONTHS) continue;
    const host = hostOf(url.href);
    items.push({
      id: `look-${createHash("sha256").update(`${url.href}\n${text}`).digest("hex").slice(0, 12)}`,
      text,
      ...(quote === undefined || quote === "" ? {} : { quote }),
      ...(date === undefined ? {} : { publishedAt: date }),
      accessedAt: now.toISOString().slice(0, 10),
      evidence: { urls: [url.href], primary: onOwnSite, domains: [host] },
      confidence: onOwnSite ? "strong" : "weak",
      about: finding.about,
    });
  }
  // A line of business only when a kept finding about the firm says it: the model's say-so alone is not data.
  const firmText = items.filter((item) => item.about === "firm").map((item) => `${item.text} ${item.quote ?? ""}`).join(" ");
  const lines = [...new Set(result.answer.lines.map((line) => clean(line).toLowerCase()).filter((line) => line !== "" && hasWords(firmText, line.split(/\s+/)[0] ?? "")))].slice(0, 20);
  return {
    items,
    usable: items.length > 0,
    searches: Math.min(2, result.searches),
    fetches: 0,
    ...(lines.length === 0 ? {} : { lines }),
  };
}
