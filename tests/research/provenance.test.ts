import { describe, expect, it } from "vitest";

import { MODULE_IDS, moduleItems, packItems, researchOutputSchema, type PackShape } from "../../agents/research/output.schema";
import { moduleUrlFields } from "../../agents/research/output/urls";
import { loadFacts } from "@/lib/facts/load";
import { createCorpus, type Corpus } from "@/lib/research/corpus";
import { checkProvenance, citedNumbers, contentWords, distinctiveWords, matchItem, numberCore, quoteSpans } from "@/lib/research/provenance";

import { goodPack as buildPack } from "../agents/researchPack";

const liveId = loadFacts("insights360", 1).facts.facts.find((fact) => fact.status === "live")!.id;
const goodPack = () => buildPack({ liveFactId: liveId });

/** Every url field outside the Items (m01 bodies, m04 list sources, m10, m12, m13 …), across the pack. */
const urlFields = (pack: PackShape) => MODULE_IDS.flatMap((id) => moduleUrlFields(pack, id).map((field) => ({ module: id, ...field })));

/** Record a page for every item and every url field, except the modules named. */
function readEverything(pack: PackShape, corpus: Corpus, skip: { items?: string[]; urls?: string[] } = {}): void {
  const skipItems = new Set(skip.items ?? []);
  for (const id of MODULE_IDS) {
    if (skipItems.has(id)) continue;
    for (const it of moduleItems(pack, id)) for (const url of it.evidence.urls) corpus.addPage(url, `${it.text} ${it.quote ?? ""}`);
  }
  for (const field of urlFields(pack)) if (!(skip.urls ?? []).includes(field.where)) corpus.addPage(field.url, `the page at ${field.url}`);
}

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

  it("compares figures by their core: no commas, no unit, no leading zeros", () => {
    expect(["8,917", "37%", "2.3m", "05", "1,200", "4.0"].map(numberCore)).toEqual(["8917", "37", "2.3", "5", "1200", "4"]);
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

  it("fails a claim whose figure is wrong, even when its words and quote are on the page (brief E: 8,971 vs 8,917)", () => {
    const corpus = createCorpus();
    corpus.addPage("https://sra.example/firms", "Regulated firms July 2026: total 8,917 SRA regulated firms (sole practitioners 1,329, LLPs 1,418, companies 5,242).");
    const distinctive = distinctiveWords(corpus);
    const wrong = item({ text: "There are 8,971 SRA regulated firms (July 2026)", quote: "total 8,917 SRA regulated firms", evidence: { urls: ["https://sra.example/firms"], primary: true, domains: ["sra.example"] } });
    expect(matchItem(wrong, corpus, distinctive)).toMatchObject({ passed: false, reason: "cited number not on the page (8971)" });
    expect(matchItem({ ...wrong, text: "There are 8,917 SRA regulated firms (July 2026)" }, corpus, distinctive)).toMatchObject({ passed: true, how: "number 8917" });
  });

  it("never finds a figure across the page's own tokens", () => {
    const corpus = createCorpus();
    // A garbled table cell: "8,97" then "1" in the next column. The old
    // whitespace-stripped search read "8971" across them.
    corpus.addPage("https://sra.example/garbled", "Total 8,97 1,329 900 5,242");
    expect(matchItem(item({ text: "8,971 firms in total", evidence: { urls: ["https://sra.example/garbled"], primary: false, domains: ["sra.example"] } }), corpus, distinctiveWords(corpus)).passed).toBe(false);
  });

  it("ignores years beside other figures, and still matches a claim whose only figure is a year", () => {
    const corpus = createCorpus();
    corpus.addPage("https://leo.example/report", "Complaint fees rose 37% as case numbers grew; the ombudsman published its decision data.");
    const distinctive = distinctiveWords(corpus);
    const on = (text: string) => matchItem(item({ text, evidence: { urls: ["https://leo.example/report"], primary: false, domains: ["leo.example"] } }), corpus, distinctive);
    expect(on("Complaint fees rose 37% in 2026")).toMatchObject({ passed: true, how: "number 37%" });
    expect(on("Complaint fees rose 41% in 2026")).toMatchObject({ passed: false });
    // Only a year: the figure rule does not apply; the words carry it.
    expect(on("In 2026 the ombudsman published its decision data")).toMatchObject({ passed: true, how: expect.stringContaining("words") });
  });

  it("matches a URL however it was written", () => {
    const corpus = createCorpus();
    corpus.addSnippet("https://WWW.example.com/story/", "complaints backlog doubled handlers");
    expect(matchItem(item({ evidence: { urls: ["https://example.com/story#top"], primary: false, domains: ["example.com"] } }), corpus, distinctiveWords(corpus)).passed).toBe(true);
  });
});

describe("checkProvenance", () => {
  it("demotes failures to speculative, names why, and rejects past twenty percent", () => {
    const pack = researchOutputSchema.parse(goodPack());
    const corpus = createCorpus();
    const { pack: checked, report } = checkProvenance(pack, corpus);
    expect(report.total).toBe(packItems(pack).length + urlFields(pack).length);
    expect(report.failed).toHaveLength(report.total);
    expect(report.rejected).toBe(true);
    for (const it of packItems(checked)) {
      expect(it.confidence).toBe("speculative");
      expect(it.inferredFrom).toMatch(/^provenance: /);
    }
    // The input is untouched.
    expect(packItems(pack).some((it) => it.confidence !== "speculative")).toBe(true);
  });

  it("passes a pack whose evidence and cited urls are all in the corpus", () => {
    const pack = researchOutputSchema.parse(goodPack());
    const corpus = createCorpus();
    readEverything(pack, corpus);
    const { report } = checkProvenance(pack, corpus);
    expect(report.failed).toEqual([]);
    expect(report.rejected).toBe(false);
  });

  it("checks the urls a module cites outside its Items: a venue never read is a failure of that module", () => {
    const pack = researchOutputSchema.parse(goodPack());
    expect([...new Set(urlFields(pack).map((field) => field.module))].sort()).toEqual(["m01", "m04", "m10", "m12", "m13"]);
    const venues = urlFields(pack).filter((field) => field.module === "m10");
    const corpus = createCorpus();
    readEverything(pack, corpus, { urls: ["m10.entries.0.url"] });
    const { report } = checkProvenance(pack, corpus);
    expect(report.failed).toEqual([{ module: "m10", id: "m10.entries.0.url", text: venues[0]!.url, reason: "cited url was never read this run" }]);
    expect(report.modules.find((m) => m.module === "m10")).toMatchObject({ total: venues.length, rejected: 1 / venues.length > 0.2 });
  });

  it("reports per module, so only the module over the threshold is re-asked (v3 §7)", () => {
    const pack = researchOutputSchema.parse(goodPack());
    const corpus = createCorpus();
    readEverything(pack, corpus, { items: ["m05"] });
    const { report } = checkProvenance(pack, corpus);
    expect(report.modules.filter((m) => m.rejected).map((m) => m.module)).toEqual(["m05"]);
    expect(report.failed.every((f) => f.module === "m05")).toBe(true);
  });

  it("does not count an honest guess — speculative, no url, inferredFrom — as a failure (§10 note 10)", () => {
    const pack = researchOutputSchema.parse(goodPack());
    const corpus = createCorpus();
    readEverything(pack, corpus);
    const guess = { id: "guess-1", text: "Most firms in the band run a single phone line", accessedAt: "2026-09-10", evidence: { urls: [], primary: false, domains: [] }, confidence: "speculative" as const, inferredFrom: "the size bands in m01" };
    const m14 = (pack.modules as Record<string, { claims: unknown[] }>).m14!;
    m14.claims = [guess];
    const { report } = checkProvenance(pack, corpus);
    expect(report.failed).toEqual([]);
    expect(report.modules.find((m) => m.module === "m14")).toBeUndefined();
    // A claim that cites nothing and does not say it is a guess is still a failure.
    m14.claims = [{ ...guess, confidence: "weak", inferredFrom: undefined, evidence: { urls: ["https://nowhere.example/"], primary: false, domains: ["nowhere.example"] } }];
    expect(checkProvenance(pack, corpus).report.failed.map((f) => f.id)).toEqual(["guess-1"]);
  });

  it("does not treat a date's day or a standard's name as a figure (brief E: '10 September 2026', 'ISO 27001')", () => {
    const corpus = createCorpus();
    corpus.addPage("https://vendor.example/pricing", "AutoQM from $35 per user per month. Over 20 years serving law firms.");
    const dated = item({ id: "move-1", text: "As read on 10 September 2026, the pricing page lists AutoQM from $35 per user per month", evidence: { urls: ["https://vendor.example/pricing"], primary: false, domains: ["vendor.example"] } });
    expect(matchItem(dated, corpus, distinctiveWords(corpus)).passed).toBe(true);
    const iso = item({ id: "move-2", text: "Holds ISO 9001 and ISO/IEC 27001:2022 certification and cites over 20 years with law firms", evidence: { urls: ["https://vendor.example/pricing"], primary: false, domains: ["vendor.example"] } });
    expect(matchItem(iso, corpus, distinctiveWords(corpus)).passed).toBe(true);
    // A real figure missing from the page still fails.
    const wrong = item({ id: "move-3", text: "As read on 10 September 2026, AutoQM costs $45 per user per month", evidence: { urls: ["https://vendor.example/pricing"], primary: false, domains: ["vendor.example"] } });
    expect(matchItem(wrong, corpus, distinctiveWords(corpus)).passed).toBe(false);
  });
});
