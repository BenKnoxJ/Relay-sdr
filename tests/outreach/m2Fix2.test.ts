import { describe, expect, it } from "vitest";

import { SEQUENCE, outreachInputSchema, type EvidenceQuote, type OutreachInput, type TouchKind } from "../../agents/outreach/input.schema";
import type { OutreachOutput } from "../../agents/outreach/output.schema";
import goodInput from "../../agents/outreach/fixtures/input.good.json";
import { evidenceListOf, isVetted, sourceNameOf, withApprovedGives } from "@/lib/outreach/adapter";
import { attributesASource, gateEmail1, gateTouch, humanizerLoss, unsupportedSourceClaims, type CohortDraft, type GateContext } from "@/lib/outreach/gates";
import { loadStandard } from "@/lib/outreach/standard";
import { COHORT_PEOPLE, peopleWindow } from "@/lib/repo/outreach";

/**
 * M2 fix round 2 (23 Sep 2026), from Critic's block, Sentinel's two minors and the independent review of the
 * fix-1 cohort (`m2-review.md`). Every case is a sentence the cohort wrote or a probe a reviewer ran: the
 * false negatives are held, the false positives pass, and the one real catch stays caught.
 */

const standard = loadStandard();
const gives: EvidenceQuote[] = standard.gives;
const fos = gives.find((give) => give.id === "give-fos-motor-complaints-q1-2026")!;
const fca40 = gives.find((give) => give.id === "give-fca-interventions-not-measured")!;

const ARDENT = ["Ardent Motor Insurance", "Ardent Motor Insurance", "Avery Dunmore"];
const BRAMBLE = ["Bramble Claims Mutual", "Bramble Claims Mutual", "Nell Oakley"];
const held = (sentence: string, about: readonly string[] = [], names: readonly string[] = ["Insights360"]) => unsupportedSourceClaims([sentence], gives, about, names);

describe("unsupported-source-claim: the false negatives Critic and Sentinel probed", () => {
  it("holds the ombudsman's name at Ardent Motor Insurance: no single word of the firm exempts a sentence", () => {
    const sentence = "The ombudsman says motor insurance complaints almost always go against the firm.";
    expect(held(sentence, ARDENT)).toEqual([sentence]);
  });

  it("holds the FCA sentence for a prospect called Will", () => {
    const sentence = "The FCA will name firms whose complaint numbers rise.";
    expect(held(sentence, ["Westbury Mutual", "Westbury Mutual", "Will Carter"])).toEqual([sentence]);
  });

  it("holds Nell's tables line though it names Bramble (review §3 #13)", () => {
    const sentence = "Bramble's complaint numbers and uphold rate sit in the FCA's public tables twice a year, sortable against every other firm's.";
    expect(held(sentence, ["Bramble", "Bramble", "Nell Oakley"])).toEqual([sentence]);
    expect(held(sentence, BRAMBLE)).toEqual([sentence]);
  });

  it("holds a line about what is published against the firm's name (review §3 #5)", () => {
    const sentence = "Those figures get published against Ardent's name, but the calls that sit behind them usually don't get looked at together.";
    expect(held(sentence, ["Ardent", "Ardent", "Avery Dunmore"])).toEqual([sentence]);
  });

  it("no longer clears a claim with the quote in the sentence next to it", () => {
    // The "percentage upheld" give this probe quoted was dropped in trial fix 1; it is kept here so the probe
    // still tests what it was written for.
    const upheld: EvidenceQuote = {
      id: "give-fca-upheld-means-by-the-firm",
      quote: "Just so you know, 'percentage upheld' by the firm means complaints found in the customer's favour.",
      sourceName: "a firm's own FCA complaints disclosure",
      url: "https://www.ageas.co.uk/important-information/complaints-data-ageas-retail",
    };
    const nell = [
      "For board packs, a firm's own FCA complaints disclosure notes that 'percentage upheld' by the firm means complaints found in the customer's favour.",
      "That is a different number from the ombudsman's own uphold rate.",
    ];
    expect(unsupportedSourceClaims([nell.join(" ")], [...gives, upheld], BRAMBLE)).toEqual([nell[1]]);
    const avery = `The ombudsman's quarterly figures show that ${fos.quote.charAt(0).toLowerCase()}${fos.quote.slice(1)} Those figures get published against Ardent's name.`;
    expect(unsupportedSourceClaims([avery], gives, ARDENT)).toEqual(["Those figures get published against Ardent's name."]);
  });

  it("holds a quote credited to the wrong body: the FCA's name on the ombudsman's words (Sentinel CWE-345)", () => {
    const sentence = "The FCA found car and motorcycle insurance complaints rose to 4,100, up from 2,800 in the same period in 2025.";
    expect(held(sentence)).toEqual([sentence]);
    expect(held("The ombudsman's quarterly figures show car and motorcycle insurance complaints rose to 4,100, up from 2,800 in the same period in 2025.")).toEqual([]);
  });

  it("does not read a bare host as a body, whatever it is called", () => {
    const spoofed: EvidenceQuote = { id: "spoof", quote: "Regulators found that every firm upheld nine in ten claims last year.", sourceName: "fca-news.example", url: "https://fca-news.example/a" };
    const sentence = "The FCA found that every firm upheld nine in ten claims last year.";
    expect(unsupportedSourceClaims([sentence], [spoofed])).toEqual([sentence]);
  });

  it("holds a frequency word the quote does not have (review §3 #10, Blair's LinkedIn message)", () => {
    const sentence = "The ombudsman's quarterly figures show car and motorcycle insurance complaints rose to 4,100, up from 2,800 in the same period in 2025, mostly on valuation, cancellation and delay.";
    expect(held(sentence)).toEqual([sentence]);
    for (const word of ["most", "usually", "always"]) {
      const widened = `The ombudsman's quarterly figures show car and motorcycle insurance complaints ${word} rose to 4,100, up from 2,800 in the same period in 2025.`;
      expect(held(widened), word).toEqual([widened]);
    }
  });

  it("holds the ombudsman's words credited to \"the regulator\"", () => {
    const sentence = "The regulator says car and motorcycle insurance complaints rose to 4,100, up from 2,800 in the same period in 2025.";
    expect(held(sentence)).toEqual([sentence]);
  });

  it("does not read \"most recent\" as a frequency", () => {
    expect(held("The ombudsman's most recent figures show car and motorcycle insurance complaints rose to 4,100, up from 2,800 in the same period in 2025.")).toEqual([]);
  });

  it("does not read \"published on\" a site or a date as a claim about the reader", () => {
    expect(held("Your complaints report, published on your site in July, mentioned delay.", BRAMBLE)).toEqual([]);
  });

  it("lets a frequency word through when the quote itself says it", () => {
    expect(held(`The FCA's review of 40 firms found that ${fca40.quote.charAt(0).toLowerCase()}${fca40.quote.slice(1)}`)).toEqual([]);
  });
});

describe("unsupported-source-claim: the five false positives of review §4 now pass", () => {
  it.each([
    ["#1 Marlo call: the product name is not the figure 360", "Insights360 scores every call that comes in against your own QA rules, so a theme can be shown across the whole set of calls."],
    ["#4 Orla LinkedIn follow-up: a publication cycle, no third party", "Whether a specific fix behind it can be traced back to real conversations is harder to prove once a publication cycle has passed."],
    ["#5 Orla call: the product name again", "Insights360 scores every call that comes in, not a sample, and compares each period against the last, so a change is easy to show."],
    ["#9 Nell call: Call 2's opener", "I sent a note on board evidence after a complaints publication."],
    ["#9 Nell call: the objection", "We already publish our complaints figures, that's covered."],
    ["#9 Nell call: the answer", "That's the number that gets published."],
  ])("%s", (_case, sentence) => {
    expect(held(sentence, ["Cobalt Vehicle Cover", "Cobalt Vehicle Cover", "Orla Bellamy"])).toEqual([]);
  });

  it("still reads a real figure beside the product's name", () => {
    expect(attributesASource("Insights360 showed complaints rose 12% last quarter.", ["Insights360"])).toBe(true);
    expect(attributesASource("Insights360 scores every call, so a change can be shown.", ["Insights360"])).toBe(false);
  });

  it("still counts publish as a source claim with a figure", () => {
    expect(held("Complaints data published last week showed 9,900 motor complaints.")).toHaveLength(1);
  });
});

describe("the seven misstatements of 22 Sep stay held under the fix-2 rules", () => {
  it.each([
    "The FCA's review of 40 firms found they didn't always measure whether a fix worked, and kept ones that weren't working.",
    "Valuation, cancellation and delay are almost always the three arguments behind a motor complaint, based on the ombudsman's quarterly data.",
    "The FCA found firms kept some fixes that weren't paying off.",
    "The FCA reviewed complaint handling at 40 firms, so some kept doing things that weren't helping.",
    "The FCA publishes each firm's complaint numbers, the share closed within eight weeks, and the share upheld by the ombudsman.",
    "Those FCA tables show the share of complaints upheld by the ombudsman.",
    "Every firm's figures are published by the FCA twice a year, including the share upheld by the ombudsman.",
  ])("%s", (sentence) => {
    expect(held(sentence, ARDENT)).toEqual([sentence]);
  });
});

// ---------------------------------------------------------------------------
// cohort-sentence: an approved quote across firms, never at the same account

function input(kind: TouchKind, company: string, name: string): OutreachInput {
  const base = outreachInputSchema.parse(goodInput);
  return {
    ...base,
    standard,
    person: { ...base.person, name, firstName: name.split(" ")[0]!, company },
    account: { ...base.account, company },
    pack: { ...base.pack, evidence: gives },
    touch: { kind, ordinal: SEQUENCE.indexOf(kind) + 1, dueAt: "2026-09-23T09:00:00Z" },
    thread: [],
  };
}

const context = (cohort: CohortDraft[]): GateContext => ({ productNames: ["Insights360"], repName: "Sam Carter", cohort });
const message = (body: string, ask: string, subject?: string): OutreachOutput => ({ kind: "message", ...(subject === undefined ? {} : { subject }), body, ask, opener: { ref: "role-runs", kind: "role_pain" }, claims: [] });
const fcaSentence = `The FCA's review of 40 firms found that ${fca40.quote.split(". ")[0]!.charAt(0).toLowerCase()}${fca40.quote.split(". ")[0]!.slice(1)}.`;

describe("cohort-sentence and the approved quotes (review §4 #2 and #8)", () => {
  const blairE1 = message(
    `Your July complaints publication showed delay complaints falling, and handler conversations about delay are now reviewed every week.\n\n${fcaSentence}\n\nA weekly review shows what recent calls sounded like. How do you check that once the first few weeks have passed?`,
    "How do you check that once the first few weeks have passed?",
    "past the first few weeks",
  );
  const emlynE2: CohortDraft = { personId: "emlyn", sameAccount: false, ask: "Who owns that?", body: `${fcaSentence} Proving a script change worked is another matter. Who owns that?` };
  const averyE2: CohortDraft = { personId: "avery", sameAccount: false, ask: "Who checks that?", body: `${fcaSentence} That is hard to prove from a handful of calls. Who checks that?` };

  it("#2: passes Blair's Email 1, whose FCA sentence two people at other firms also carry", () => {
    const rules = gateEmail1(blairE1, input("email1", "Bramble Claims Mutual", "Blair Kendrick"), context([emlynE2, averyE2])).tierA.map((finding) => finding.rule);
    expect(rules).not.toContain("cohort-sentence");
  });

  it("#8: holds Nell's LinkedIn message, which repeats the quote her colleague Blair was sent", () => {
    const nellLi = message(`${fcaSentence}\n\nThat gap sits above any single team, since it's about proving that a fix actually worked.\n\nWho at Bramble ends up owning that answer if the board asks for it?`, "Who at Bramble ends up owning that answer if the board asks for it?");
    const blair: CohortDraft = { personId: "blair", sameAccount: true, ask: blairE1.kind === "message" ? blairE1.ask : "", body: blairE1.kind === "message" ? blairE1.body : "" };
    const rules = gateTouch(nellLi, input("li_dm", "Bramble Claims Mutual", "Nell Oakley"), context([blair])).tierA.map((finding) => finding.rule);
    expect(rules).toContain("cohort-sentence");
  });

  it("still holds a repeated sentence with no quote in it across firms", () => {
    const own = "When quality checking covers one call in fifty, the habit behind a complaint is usually found weeks after it started.";
    const draft = message(`${own} The calls behind a complaint are found late. Is that on your list?`, "Is that on your list?");
    const others: CohortDraft[] = ["emlyn", "avery"].map((personId) => ({ personId, sameAccount: false, ask: "Why?", body: `${own} Why?` }));
    expect(gateEmail1(draft, input("email1", "Cobalt Vehicle Cover", "Orla Bellamy"), context(others)).tierA.map((finding) => finding.rule)).toContain("cohort-sentence");
  });
});

// ---------------------------------------------------------------------------
// The evidence list: vetted, scoped, dated

describe("the evidence list the drafter is given", () => {
  const item = (id: string, confidence: "strong" | "moderate" | "weak", primary: boolean) => ({
    id,
    text: "a paraphrase",
    quote: `The source's own words for ${id}.`,
    speaker: "Garry Gormley",
    confidence,
    evidence: { urls: [`https://${id}.example/page`], primary, domains: [`${id}.example`] },
  });

  it("passes research items marked strong or from a primary source, and nothing weaker", () => {
    expect(isVetted(item("a", "strong", false))).toBe(true);
    expect(isVetted(item("b", "moderate", true))).toBe(true);
    expect(isVetted(item("c", "moderate", false))).toBe(false);
    expect(isVetted(item("d", "weak", false))).toBe(false);
  });

  it("names an unknown host by the host, never by the speaker research read off the page (Sentinel CWE-345)", () => {
    expect(sourceNameOf(item("callcentrehelper", "weak", false))).toBe("callcentrehelper.example");
    expect(sourceNameOf({ evidence: { urls: ["https://www.fca.org.uk/publications/x"] } })).toBe("the FCA");
    expect(evidenceListOf([item("vendor", "weak", false)])[0]?.sourceName).toBe("vendor.example");
  });

  it("gives the drafter each approved quote's scope, and no longer the FCA-publishes line", () => {
    const base = outreachInputSchema.parse(goodInput);
    const evidence = withApprovedGives({ ...base.pack, evidence: [] }, standard, new Date("2026-09-25T09:00:00Z")).evidence;
    expect(evidence.map((quote) => quote.id)).toEqual(["give-fos-motor-complaints-q1-2026", "give-fca-interventions-not-measured", "give-fca-complaints-data-dates"]);
    for (const quote of evidence) expect(quote.scope, quote.id).toMatch(/\S/);
    expect(evidence.every((quote) => !quote.scope!.includes("\n"))).toBe(true);
    expect(outreachInputSchema.safeParse({ ...base, pack: { ...base.pack, evidence } }).success).toBe(true);
  });

  it("names the ombudsman quote's period, which its own words never do", () => {
    expect(fos.quote).not.toMatch(/April to June/);
    expect(fos.sourceName).toContain("(April to June 2026)");
  });
});

// ---------------------------------------------------------------------------
// The humanizer may cut a whole attributed sentence (review §6)

describe("the humanizer's quote guard allows a clean cut of a whole attributed sentence", () => {
  const gormley: EvidenceQuote = {
    id: "cx-sample-small-is-fine",
    quote: "larger sample sizes place unnecessary strain on QA teams without significantly improving the quality of insights",
    sourceName: "callcentrehelper.com",
    url: "https://www.callcentrehelper.com/x",
  };
  const everySix: EvidenceQuote = {
    id: "give-fca-publishes-every-six-months",
    quote:
      "The FCA publishes complaints data every six months as part of its oversight of consumer outcomes and regulated financial services firms. The data includes complaints opened, upheld, and closed, alongside redress payments made by firms.",
    sourceName: "the FCA's complaints data",
    url: "https://www.itij.com/latest/news/x",
  };

  it("keeps Marlo's Email 1 with the Gormley line cut out", () => {
    const drafted = message(
      "When a fix is made to how a complaint gets handled, showing that it actually worked usually rests on the same handful of calls someone happened to review. Garry Gormley has said that larger sample sizes place unnecessary strain on QA teams without significantly improving the quality of insights. When you need to prove a theme is real rather than a one-off, what do you point to today?",
      "When you need to prove a theme is real rather than a one-off, what do you point to today?",
      "proving a complaint theme",
    );
    const humanized = message(
      "Showing that a fix to how a complaint gets handled worked usually comes down to the same handful of calls someone happened to review. When you need to prove a theme is real rather than a one-off, what do you point to today?",
      "When you need to prove a theme is real rather than a one-off, what do you point to today?",
      "proving a complaint theme",
    );
    expect(humanizerLoss(drafted, humanized, [gormley])).toBeNull();
  });

  it("keeps Nell's Email 1 with the FCA-publishes line cut out", () => {
    const drafted = message(
      "Bramble's complaint numbers and uphold rate sit in the FCA's public tables twice a year, sortable against every other firm's.\n\nThe FCA publishes complaints data every six months as part of its oversight of consumer outcomes and regulated financial services firms.\n\nWhat sits behind the figures, the conversations that led to them, isn't part of that publication.\n\nWhen the board asks what's changed since the last one, what do you point to?",
      "When the board asks what's changed since the last one, what do you point to?",
      "what gets published on you",
    );
    const humanized = message(
      "Bramble's complaint numbers and uphold rate go into the FCA's public tables twice a year, sortable against every other firm's.\n\nThe conversations behind those figures never show up in that publication.\n\nWhen the board asks what's changed since the last one, what do you point to?",
      "When the board asks what's changed since the last one, what do you point to?",
      "what gets published on you",
    );
    expect(humanizerLoss(drafted, humanized, [everySix, ...gives])).toBeNull();
  });

  const drafted = message(
    "The ombudsman's quarterly figures show car and motorcycle insurance complaints rose to 4,100, up from 2,800 in the same period in 2025. Motor disputes tend to be the same three arguments. How do you find the calls behind them?",
    "How do you find the calls behind them?",
  );

  it("still rejects a word slipped into the quote (Emlyn's \"recorded\")", () => {
    const slipped = message(
      "The ombudsman's quarterly figures show car and motorcycle insurance complaints rose to a recorded 4,100, up from 2,800 in the same period in 2025. Motor disputes tend to be the same three arguments. How do you find the calls behind them?",
      "How do you find the calls behind them?",
    );
    expect(humanizerLoss(drafted, slipped, gives)).toMatch(/reworded an approved quote/);
  });

  it("still rejects the quote trimmed to half a sentence", () => {
    const trimmed = message("The ombudsman's quarterly figures show car and motorcycle insurance complaints rose to 4,100. Motor disputes tend to be the same three arguments. How do you find the calls behind them?", "How do you find the calls behind them?");
    expect(humanizerLoss(drafted, trimmed, gives)).toMatch(/reworded an approved quote/);
  });

  it("still rejects the quote said again in other words", () => {
    const paraphrased = message("The ombudsman's quarterly figures show motor insurance complaints went up to 4,100 from 2,800 a year before. Motor disputes tend to be the same three arguments. How do you find the calls behind them?", "How do you find the calls behind them?");
    expect(humanizerLoss(drafted, paraphrased, gives)).toMatch(/reworded an approved quote/);
  });
});

// ---------------------------------------------------------------------------
// The cohort the repetition gates read: people, not drafts (Critic's second major)

describe("the cohort window", () => {
  it("is Email 1's pre-M2 window: 40 people", () => {
    expect(COHORT_PEOPLE).toBe(40);
  });

  it("keeps every touch of the most recent people and stops at the people cap, not a draft count", () => {
    // Seven touches each for 45 people, newest first.
    const drafts = Array.from({ length: 45 }, (_, person) => Array.from({ length: 7 }, (_, touch) => ({ campaignPersonId: `p${person}`, touch }))).flat();
    const window = peopleWindow(drafts, COHORT_PEOPLE);
    expect(new Set(window.map((draft) => draft.campaignPersonId)).size).toBe(40);
    expect(window).toHaveLength(40 * 7);
    expect(window.some((draft) => draft.campaignPersonId === "p40")).toBe(false);
  });
});
