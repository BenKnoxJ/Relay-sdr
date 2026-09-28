import { describe, expect, it } from "vitest";

import { lineVocabularyOf } from "@/lib/outreach/gates";
import { linesOf, lookupEvidence, pageDate, type LookupSubject } from "@/lib/outreach/lookup";
import type { FetchService, PageRead, SearchHit, SearchService } from "@/lib/services";

/**
 * The lookup with undated search hits (trial fix 1, 25 Sep 2026), and the firm's lines of business read in the
 * campaign's own words (standard v3). Harbour Motor is a made-up motor insurer.
 */

const LINE_PHRASES = lineVocabularyOf({
  industries: ["Motor insurance underwriting"],
  groups: [["Motor insurance underwriting"], ["Travel insurance"], ["Home and buildings insurance"]],
}).phrases;

describe("the firm's lines, from the campaign's own words", () => {
  it("reads each line as the labels say it", () => {
    expect(LINE_PHRASES).toEqual({
      motor: ["motor insurance"],
      travel: ["travel insurance"],
      buildings: ["buildings insurance", "home and buildings insurance"],
      home: ["home insurance", "home and buildings insurance"],
    });
  });

  it("keeps both lines of an \"and\" label when a page uses the label's own words (fix round 2)", () => {
    const page = "We offer home and buildings insurance and motor insurance. Our home and buildings insurance covers flats. Motor insurance for vans.";
    expect(linesOf(page, "Hollin Cover", LINE_PHRASES).sort()).toEqual(["buildings", "home", "motor"]);
  });

  it("counts a line's phrase twice in what the lookup read, or once more in the firm's own name", () => {
    expect(linesOf("We sell motor insurance. Our motor insurance covers vans.", "Harbour Cover", LINE_PHRASES)).toEqual(["motor"]);
    expect(linesOf("We sell motor insurance for cars and vans.", "Harbour Motor", LINE_PHRASES)).toEqual(["motor"]);
    expect(linesOf("Travel cover for the whole family.", "Wayfarer Cover", LINE_PHRASES)).toEqual([]);
  });

  it("never reads a page's navigation as a line: a \"Home\" link is not home insurance", () => {
    expect(linesOf("Home | Contact us | Motor insurance. Home insurance?", "Acme Motor", LINE_PHRASES)).toEqual(["motor"]);
  });
});

describe("the lookup, with undated search hits", () => {
  const NOW = new Date("2026-09-25T09:00:00Z");
  const subject: LookupSubject = {
    personName: "Sam Ferris",
    company: "Harbour Motor",
    domain: "harbourmotor.example",
    region: "GB",
    relevance: ["Complaint causes are recorded as a category and nobody can say which conversations caused them.", "Proving a complaint fix worked."],
    triggers: ["complaints rising"],
    linePhrases: LINE_PHRASES,
  };
  const PERSON = '"Sam Ferris" "Harbour Motor"';
  const FIRM = '"Harbour Motor" complaints rising';
  const undated = (url: string, title = "Harbour Motor complaints"): SearchHit => ({ title, url, snippet: "Harbour Motor complaints policy" });

  function services(searches: Record<string, SearchHit[]>, pages: Record<string, string>) {
    const fetched: string[] = [];
    const read = (url: string): PageRead => (pages[url] === undefined ? { unreadable: true, reason: "not scripted" } : { markdown: pages[url]! });
    const search: SearchService = { search: async (input) => ({ hits: searches[input.query] ?? [] }), extract: async (url) => (fetched.push(`extract:${url}`), read(url)) };
    const fetch: FetchService = { scrape: async (url) => (fetched.push(url), read(url)) };
    return { deps: { search, fetch, now: () => NOW }, fetched };
  }
  const POLICY = "# Complaints policy\n\nHarbour Motor records the cause of every complaint by category and reviews the conversations behind complaint causes each month.\n\nWe sell motor insurance for cars and vans. Motor claims are handled in house.";

  it("uses an undated page on the firm's own site, as a weak item, and reads the firm's line off it", async () => {
    const { deps, fetched } = services({ [FIRM]: [undated("https://harbourmotor.example/complaints-policy")] }, { "https://harbourmotor.example/complaints-policy": POLICY });
    const result = await lookupEvidence(subject, deps);
    expect(result).toMatchObject({ usable: true, searches: 2, fetches: 1, lines: ["motor"] });
    expect(result.items[0]).toMatchObject({ about: "firm", confidence: "weak", evidence: { primary: true } });
    expect(result.items[0]!.publishedAt).toBeUndefined();
    expect(fetched).toEqual(["https://harbourmotor.example/complaints-policy"]);
  });

  it("dates an undated hit from its page, and drops it when the page is stale", async () => {
    const stale = `Published 3 March 2024\n\n${POLICY}`;
    const { deps } = services({ [FIRM]: [undated("https://harbourmotor.example/news/causes")] }, { "https://harbourmotor.example/news/causes": stale });
    const result = await lookupEvidence(subject, deps);
    expect(result.usable).toBe(false);
    expect(result.trail.map((step) => step.outcome)).toContain("stale (the page is dated 2024-03-03)");
  });

  it("takes a fresh date from the page, and the item is strong on the firm's own site", async () => {
    const fresh = `Last updated: 12 June 2026\n\n${POLICY}`;
    const { deps } = services({ [FIRM]: [undated("https://harbourmotor.example/news/causes")] }, { "https://harbourmotor.example/news/causes": fresh });
    const result = await lookupEvidence(subject, deps);
    expect(result.items[0]).toMatchObject({ publishedAt: "2026-06-12", confidence: "strong" });
  });

  it("never takes an off-site page's own date: only the search's date counts off the firm's site (fix round 2)", async () => {
    const fresh = `Last updated: 12 June 2026\n\n${POLICY}`;
    const { deps } = services({ [FIRM]: [undated("https://news.example/harbour")] }, { "https://news.example/harbour": fresh });
    const result = await lookupEvidence(subject, deps);
    expect(result.usable).toBe(false);
    expect(result.trail.map((step) => step.outcome)).toContain("undated, and not the firm's own site");
  });

  it("drops an undated page that is not the firm's own", async () => {
    const { deps } = services({ [FIRM]: [undated("https://news.example/harbour")] }, { "https://news.example/harbour": POLICY });
    const result = await lookupEvidence(subject, deps);
    expect(result.usable).toBe(false);
    expect(result.trail.map((step) => step.outcome)).toContain("undated, and not the firm's own site");
  });

  it("still never reads a stale dated hit, and keeps to two searches and two fetches", async () => {
    const old: SearchHit = { ...undated("https://harbourmotor.example/old"), publishedAt: "2024-01-01" };
    const { deps, fetched } = services({ [PERSON]: [{ ...old, snippet: "Sam Ferris, Harbour Motor" }], [FIRM]: [old] }, {});
    const result = await lookupEvidence(subject, deps);
    expect(result).toMatchObject({ usable: false, searches: 2, fetches: 0 });
    expect(fetched).toEqual([]);
  });

  it("reads a labelled date anywhere, a byline date only near the top, and never a future one", () => {
    expect(pageDate("Some text.\n\nPosted on 4 July 2026 by the team", NOW)).toBe("2026-07-04");
    expect(pageDate("2026-05-02\n\n# News", NOW)).toBe("2026-05-02");
    expect(pageDate(`${"x ".repeat(400)} From 1 May 2026 the rules change.`, NOW)).toBeUndefined();
    expect(pageDate("Updated 22 October 2026", NOW)).toBeUndefined();
  });
});
