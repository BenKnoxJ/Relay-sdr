import { describe, expect, it } from "vitest";

import goodPack from "../../agents/research/fixtures/output.good.json";
import { packItems, researchOutputSchema } from "../../agents/research/output.schema";
import { createCorpus } from "@/lib/research/corpus";
import { checkProvenance, citedNumbers, contentWords, distinctiveWords, matchItem, quoteSpans } from "@/lib/research/provenance";

const item = (over: Partial<ReturnType<typeof packItems>[number]> = {}) => ({
  id: "pain-1",
  text: "Claims handlers say the complaints backlog doubled after the January storms",
  accessedAt: "2026-09-01",
  evidence: { urls: ["https://example.com/story"], primary: false, domains: ["example.com"] },
  confidence: "weak" as const,
  ...over,
});

describe("the matchers", () => {
  it("finds cited numbers, content words and quote spans", () => {
    expect(citedNumbers("fined £2.3m, 48% of calls, 7 firms, 1,200 claims")).toEqual(["2.3m", "48%", "1200"]);
    expect(contentWords("Claims handlers say the complaints backlog doubled")).toEqual(["claims", "handlers", "complaints", "backlog", "doubled"]);
    expect(quoteSpans("we answer the phone but we cannot prove it")).toEqual([
      "we answer the phone but we",
      "answer the phone but we cannot",
      "the phone but we cannot prove",
      "phone but we cannot prove it",
    ]);
    expect(quoteSpans("short quote")).toEqual(["short quote"]);
  });
});

describe("matchItem", () => {
  it("fails an item whose evidence was never fetched", () => {
    const corpus = createCorpus();
    expect(matchItem(item(), corpus, distinctiveWords(corpus))).toEqual({ passed: false, reason: "no evidence url was fetched or seen this run" });
  });

  it("passes on a cited number, a quote span, or two distinctive words", () => {
    const corpus = createCorpus();
    corpus.addPage("https://example.com/story", "The regulator fined the firm £2.3m. Handlers said the complaints backlog doubled after the storms.");
    corpus.addPage("https://other.example/b", "A page about something else entirely, mentioning handlers.");
    const distinctive = distinctiveWords(corpus);
    expect(matchItem(item({ text: "Fined £2.3m by the regulator" }), corpus, distinctive)).toMatchObject({ passed: true, how: "number 2.3m" });
    expect(matchItem(item({ text: "Staff were candid", quote: "the complaints backlog doubled after the storms" }), corpus, distinctive)).toMatchObject({ passed: true, how: expect.stringContaining("quote span") });
    expect(matchItem(item(), corpus, distinctive)).toMatchObject({ passed: true, how: expect.stringContaining("words") });
    expect(matchItem(item({ text: "Premiums rose sharply in Scotland" }), corpus, distinctive)).toMatchObject({ passed: false, reason: expect.stringContaining("fewer than two") });
    expect(matchItem(item({ text: "Fined £9.9m last year" }), corpus, distinctive)).toMatchObject({ passed: false, reason: expect.stringContaining("cited number not on the page") });
  });

  it("matches a URL however it was written", () => {
    const corpus = createCorpus();
    corpus.addSnippet("https://WWW.example.com/story/", "complaints backlog doubled handlers");
    expect(matchItem(item({ evidence: { urls: ["https://example.com/story#top"], primary: false, domains: ["example.com"] } }), corpus, distinctiveWords(corpus)).passed).toBe(true);
  });
});

describe("checkProvenance", () => {
  it("demotes failures to speculative, names why, and rejects past twenty percent", () => {
    const pack = researchOutputSchema.parse(goodPack);
    const corpus = createCorpus();
    const { pack: checked, report } = checkProvenance(pack, corpus);
    expect(report.total).toBe(packItems(pack).length);
    expect(report.failed).toHaveLength(report.total);
    expect(report.rejected).toBe(true);
    for (const it of packItems(checked)) {
      expect(it.confidence).toBe("speculative");
      expect(it.inferredFrom).toMatch(/^provenance: /);
    }
    // The input is untouched.
    expect(packItems(pack).some((it) => it.confidence !== "speculative")).toBe(true);
  });

  it("passes a pack whose evidence is all in the corpus", () => {
    const pack = researchOutputSchema.parse(goodPack);
    const corpus = createCorpus();
    for (const it of packItems(pack)) {
      for (const url of it.evidence.urls) corpus.addPage(url, `${it.text} ${it.quote ?? ""}`);
    }
    const { report } = checkProvenance(pack, corpus);
    expect(report.failed).toEqual([]);
    expect(report.rejected).toBe(false);
  });
});
