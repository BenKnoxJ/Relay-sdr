import { describe, expect, it } from "vitest";

import type { EvidenceQuote } from "../../agents/outreach/input.schema";
import {
  HUMANIZER_MAX_WORD_LOSS,
  askShapeOf,
  attributesASource,
  hasTell,
  humanizerLoss,
  quoteRuns,
  quotesEvidence,
  unsupportedSourceClaims,
} from "@/lib/outreach/gates";
import { isPriceFact } from "../../agents/outreach/output.schema";
import { callScriptFor } from "@/lib/outreach/peopleList";
import { loadStandard } from "@/lib/outreach/standard";
import { OPT_OUT_LINE, emailCopyText, envelopeOf, signatureText } from "@/lib/outreach/envelope";

/**
 * M2 (23 Sep 2026): the evidence gate, the humanizer's loss check, and the
 * envelope the rep actually copies.
 *
 * The cases that matter are real ones. Every misstatement in §3 of the 22 Sep
 * re-review is here as the model wrote it, against the approved quotes it
 * should have used, and every one of them must be held. Passing cases are the
 * source's own words. The point of the file is that "it reads plausibly" and
 * "it is what the source said" are different things, and only the second one
 * gets through.
 */

const standard = loadStandard();
const gives: EvidenceQuote[] = standard.gives;

const held = (sentence: string) => unsupportedSourceClaims([sentence], gives);

describe("the approved gives", () => {
  it("carries the source sentences the re-review asked for, each with a url and a scope", () => {
    // Fix round 2 dropped "the FCA publishes complaints data every six months": every prospect here works at a
    // firm that sends the FCA that data, so it told them about their own regulatory return.
    expect(standard.gives.map((give) => give.id)).toEqual(["give-fos-motor-complaints-q1-2026", "give-fca-interventions-not-measured", "give-fca-upheld-means-by-the-firm"]);
    for (const give of standard.gives) {
      expect(give.url, give.id).toMatch(/^https:\/\//);
      expect(give.scope.length, give.id).toBeGreaterThan(20);
    }
  });

  it("says what the FCA actually said, not what the drafts said it said", () => {
    const fca = standard.gives.find((give) => give.id === "give-fca-interventions-not-measured")!;
    expect(fca.quote).toContain("not as effective as they might need to be");
    expect(fca.quote).not.toContain("weren't working");
    const upheld = standard.gives.find((give) => give.id === "give-fca-upheld-means-by-the-firm")!;
    expect(upheld.quote).toContain("by the firm");
  });
});

describe("unsupported-source-claim: the seven misstatements of 22 Sep", () => {
  // Each of these reached a rep. The re-review's §3 row is named beside it.
  const MISSTATED: readonly (readonly [string, string])[] = [
    ["row 2, Emlyn E2: the FCA's finding hardened into a fact", "The FCA's review of 40 firms found they didn't always measure whether a fix worked, and kept ones that weren't working."],
    ["row 11, Avery LI follow-up: an invented frequency on the ombudsman's data", "Valuation, cancellation and delay are almost always the three arguments behind a motor complaint, based on the ombudsman's quarterly data."],
    ["row 16, Marlo LI follow-up: the same hardening, in other words", "The FCA found firms kept some fixes that weren't paying off."],
    ["row 19, Blair E2: the second half overstates the review", "The FCA reviewed complaint handling at 40 firms, so some kept doing things that weren't helping."],
    ["row 21a, Blair LI message: the FCA table read as the ombudsman's", "The FCA publishes each firm's complaint numbers, the share closed within eight weeks, and the share upheld by the ombudsman."],
    ["row 21b, Orla LI message: the same table, the same error", "Those FCA tables show the share of complaints upheld by the ombudsman."],
    ["row 21c, Nell E2: and again, in an email", "Every firm's figures are published by the FCA twice a year, including the share upheld by the ombudsman."],
  ];

  it.each(MISSTATED)("holds %s", (_row, sentence) => {
    expect(held(sentence)).toEqual([sentence]);
  });

  it("names the sentence it held, so the rep knows which one to look at", () => {
    const [, sentence] = MISSTATED[0]!;
    expect(held(sentence)[0]).toBe(sentence);
  });
});

describe("unsupported-source-claim: what passes", () => {
  it("lets the source's own words through", () => {
    for (const give of gives) expect(held(give.quote), give.id).toEqual([]);
  });

  it("lets a six-word run of an approved quote through, inside a sentence of the draft's own", () => {
    expect(held("Car and motorcycle insurance complaints rose to 4,100, up from 2,800 in the same period in 2025.")).toEqual([]);
  });

  it("holds the same claim once a word is changed inside the run", () => {
    expect(held("Car and motorcycle insurance complaints to the ombudsman rose to 4,100 in April to June 2026.")).toHaveLength(1);
  });

  it("holds a framing line whose quote is in the next sentence: the source and its words go in one sentence (fix round 2)", () => {
    const give = "The ombudsman's quarterly figures show the wider picture. Car and motorcycle insurance complaints rose to 4,100, up from 2,800 in the same period in 2025.";
    expect(held(give)).toEqual(["The ombudsman's quarterly figures show the wider picture."]);
    expect(held("The ombudsman's quarterly figures show car and motorcycle insurance complaints rose to 4,100, up from 2,800 in the same period in 2025.")).toEqual([]);
  });

  it("does not hold a question: an offer to send a document asserts nothing", () => {
    expect(held("Want me to send you the FCA's write-up?")).toEqual([]);
  });

  it("does not hold a sentence about the reader's own firm", () => {
    expect(unsupportedSourceClaims(["Bramble's July publication showed delay complaints falling by 12%."], gives, ["Bramble"])).toEqual([]);
    expect(held("Your July complaints publication showed delay complaints falling.")).toEqual([]);
  });

  it("does not hold the call's complete price answer, which carries numbers and no source", () => {
    expect(held("There's a one-off setup fee of £1,280 and a one-off £640 configuration review around month one.")).toEqual([]);
  });

  it("holds a figure that reports something, with no source behind it", () => {
    expect(held("Complaints rose to 9,900 last quarter.")).toHaveLength(1);
  });
});

describe("attributesASource", () => {
  it("is true whenever a regulator or an ombudsman is named", () => {
    expect(attributesASource("The FCA looked at 40 firms.")).toBe(true);
    expect(attributesASource("The ombudsman sees this every quarter.")).toBe(true);
  });

  it("needs a reporting word as well as a figure, so a price is not a source claim", () => {
    expect(attributesASource("It is £4.99 per seat per month.")).toBe(false);
    expect(attributesASource("Complaints rose to 4,100.")).toBe(true);
  });
});

describe("quote runs", () => {
  it("matches on six consecutive words, normalising case and punctuation", () => {
    const runs = quoteRuns([{ id: "q", quote: "Firms did not always measure the impact of interventions", sourceName: "the FCA", url: "https://example.org/x" }]);
    expect(quotesEvidence("firms did not always measure the impact", runs)).toBe(true);
    expect(quotesEvidence("Firms did not always measure, the impact", runs)).toBe(true);
    // Five words is not six.
    expect(quotesEvidence("Firms did not always measure.", runs)).toBe(false);
  });
});

describe("the tell list matches multi-word phrases and stems", () => {
  it("finds a multi-word tell inside a sentence, whatever sits around it", () => {
    expect(hasTell("I wondered, would it help if I sent over the write-up?", "would it help if i sent over")).toBe(true);
  });

  it("finds a single word's ordinary stems", () => {
    expect(hasTell("A streamlined review", "streamline")).toBe(true);
    expect(hasTell("Our platform empowers teams", "empower")).toBe(true);
  });

  it("does not match a word that merely starts with the tell", () => {
    expect(hasTell("outreaching", "out")).toBe(false);
    expect(hasTell("leveraged", "leverage")).toBe(true);
  });
});

describe("the ask's shape", () => {
  it("reads past a leading clause to the question itself", () => {
    expect(askShapeOf("When a delay complaint lands, how do you find the calls behind it today?")).toBe("how do");
    expect(askShapeOf("Who owns this at Ardent?")).toBe("who owns");
  });

  it("calls two offers of the same shape the same shape", () => {
    expect(askShapeOf("Would it help if I sent over the review?")).toBe(askShapeOf("Would it be worth a look?"));
  });
});

describe("the humanizer must not cut the point", () => {
  const message = (body: string, ask: string) => ({ kind: "message" as const, body, ask, opener: { ref: "r", kind: "role_pain" as const }, claims: [] });
  const quote = gives.find((give) => give.id === "give-fca-interventions-not-measured")!;
  const drafted = message(
    `The FCA found that firms did not always measure the impact of interventions they had made. That is the part a board asks about. Who owns that at your end?`,
    "Who owns that at your end?",
  );

  it("keeps a pass that tightens the prose", () => {
    const tightened = message(
      "The FCA found that firms did not always measure the impact of interventions they had made. Boards ask about that. Who owns that at your end?",
      "Who owns that at your end?",
    );
    expect(humanizerLoss(drafted, tightened, [quote])).toBeNull();
  });

  it("rejects a pass that rewords an approved quote", () => {
    const reworded = message(
      "The FCA found that firms rarely measured whether their fixes worked. That is the part a board asks about. Who owns that at your end?",
      "Who owns that at your end?",
    );
    expect(humanizerLoss(drafted, reworded, [quote])).toMatch(/reworded an approved quote/);
  });

  it("rejects Marlo's Email 2 case: the give cut out, leaving the point pointing at nothing", () => {
    const gutted = message("A pattern like that can be searched. Who owns that at your end?", "Who owns that at your end?");
    expect(humanizerLoss(drafted, gutted, [quote])).toMatch(/reworded an approved quote|cut \d+% of the words/);
  });

  it(`rejects a pass that cuts more than ${Math.round(HUMANIZER_MAX_WORD_LOSS * 100)}% of the words`, () => {
    const short = message("Boards ask about that. Who owns that at your end?", "Who owns that at your end?");
    expect(humanizerLoss(drafted, short, [])).toMatch(/cut \d+% of the words/);
  });

  it("allows the same cut when it is the verified clean cut of a product sentence", () => {
    const short = message("Boards ask about that. Who owns that at your end?", "Who owns that at your end?");
    expect(humanizerLoss(drafted, short, [], true)).toBeNull();
  });

  it("rejects a pass that leaves the touch with no question", () => {
    const noAsk = message("The FCA found that firms did not always measure the impact of interventions they had made.", "");
    expect(humanizerLoss(drafted, noAsk, [quote])).toMatch(/no question/);
  });
});

describe("the envelope the rep copies", () => {
  const envelope = envelopeOf({ firstName: "Avery", repName: "Sam", signature: "<p>Sam Carter<br>Conversant</p><p>07700 900000</p>" });

  it("reads a pasted HTML signature back as plain lines", () => {
    expect(signatureText("<p>Sam Carter<br>Conversant</p><p>07700 900000</p>")).toBe("Sam Carter\nConversant\n\n07700 900000");
    expect(signatureText("<div>Sam &amp; Co</div>")).toBe("Sam & Co");
    expect(signatureText("")).toBe("");
  });

  it("puts the greeting, body, sign-off, signature and opt-out in that order", () => {
    expect(emailCopyText("The body.", envelope)).toBe("Hi Avery,\n\nThe body.\n\nSam\n\nSam Carter\nConversant\n\n07700 900000\n\nIf this isn't relevant, just reply and I won't follow up.");
  });

  it("uses Benny-san's wording for the opt-out, unaltered", () => {
    expect(envelope.optOut).toBe(OPT_OUT_LINE);
    expect(OPT_OUT_LINE).toBe("If this isn't relevant, just reply and I won't follow up.");
  });

  it("leaves out a part the rep has not given, rather than leaving a gap", () => {
    const bare = envelopeOf({ firstName: "Avery", repName: "", signature: "" });
    expect(emailCopyText("The body.", bare)).toBe("Hi Avery,\n\nThe body.\n\nIf this isn't relevant, just reply and I won't follow up.");
  });
});

describe("the second call has its own script (M2)", () => {
  it("shows call 1 its own lines and call 2 its own, from the one stored script", () => {
    const stored = [
      "Open with: First opener.",
      "Ask: First question?",
      "Call 2, open with: Second opener.",
      "Call 2, ask: Second question?",
      "Listen for: who owns it",
      "Voicemail: A short message.",
    ].join("\n\n");
    expect(callScriptFor("call1", stored)).toBe("Open with: First opener.\n\nAsk: First question?\n\nListen for: who owns it\n\nVoicemail: A short message.");
    expect(callScriptFor("call2", stored)).toBe("Open with: Second opener.\n\nAsk: Second question?\n\nListen for: who owns it\n\nVoicemail: A short message.");
  });

  it("falls back to the one script for a call written before M2", () => {
    const old = "Open with: Only opener.\n\nAsk: Only question?\n\nListen for: who owns it";
    expect(callScriptFor("call1", old)).toBe(old);
    expect(callScriptFor("call2", old)).toBe(old);
  });
});

describe("the price facts do not count against a call's claim cap (M2)", () => {
  it("knows a price fact id from any other", () => {
    expect(isPriceFact("i360.price.per-seat-plans")).toBe(true);
    expect(isPriceFact("i360.feature.auto-qa-scoring-against-tenant-rules")).toBe(false);
  });
});
