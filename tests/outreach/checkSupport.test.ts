import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SEQUENCE, outreachInputSchema } from "../../agents/outreach/input.schema";
import { checkTouchLimits, outputSchemaFor, outreachOutputSchema, type OutreachOutput } from "../../agents/outreach/output.schema";
import goodInput from "../../agents/outreach/fixtures/input.good.json";
import goodOutput from "../../agents/outreach/fixtures/output.good.json";
import { evidenceListOf, isVetted, sourceNameOf } from "@/lib/outreach/adapter";
import { emailCopyText, envelopeOf, signatureText } from "@/lib/outreach/envelope";
import { askShapeOf, hasTell, normaliseClaims, quoteRuns, quotesEvidence, withoutThreadSubject } from "@/lib/outreach/gates";
import { callScriptFor } from "@/lib/outreach/peopleList";
import { loadDefaultVoice, voiceInputOf } from "@/lib/outreach/voice";
import { COHORT_PEOPLE, peopleWindow } from "@/lib/repo/outreach";

/**
 * What the checks lean on, and what the rep copies: quote matching, the tell list, the ask's shape, the
 * claims list before the checks, the evidence list the drafter is given, the envelope (no opt-out line, D3),
 * the call script's two calls, the cohort window and the default voice. Carried over from the M2 and trial
 * rounds; the checks those rounds added and standard v3 removed are gone with their tests.
 */

describe("quote runs", () => {
  it("matches on six consecutive words, normalising case and punctuation", () => {
    const runs = quoteRuns([{ id: "q", quote: "Firms did not always measure the impact of interventions", sourceName: "fca.org.uk", url: "https://example.org/x" }]);
    expect(quotesEvidence("firms did not always measure the impact", runs)).toBe(true);
    expect(quotesEvidence("Firms did not always measure, the impact", runs)).toBe(true);
    expect(quotesEvidence("Firms did not always measure.", runs)).toBe(false);
  });
});

describe("the tell list matches multi-word phrases and stems", () => {
  it("finds a multi-word tell inside a sentence, and a single word's ordinary stems", () => {
    expect(hasTell("I wondered, would it be good to hop on a call?", "hop on a call")).toBe(true);
    expect(hasTell("A streamlined review", "streamline")).toBe(true);
    expect(hasTell("leveraged", "leverage")).toBe(true);
    expect(hasTell("outreaching", "out")).toBe(false);
  });
});

describe("the ask's shape", () => {
  it("reads past a leading clause to the question itself", () => {
    expect(askShapeOf("When a delay complaint lands, how do you find the calls behind it today?")).toBe("how do");
    expect(askShapeOf("Would it help if I sent over the review?")).toBe(askShapeOf("Would it be worth a look?"));
  });
});

describe("claims before the checks", () => {
  const base = () => outreachInputSchema.parse(goodInput);
  const good = () => outreachOutputSchema.parse(goodOutput);

  it("moves out the opener's ref and any lookup or plan id, and keeps facts and unknown ids", () => {
    const input = base();
    const pain = input.pack.archetype.pains[0]!.id;
    const draft = { ...good(), claims: [good().opener.ref, pain, "i360.read-every-call", "i360.live-assist"] };
    expect(normaliseClaims(draft, input).claims).toEqual(["i360.read-every-call", "i360.live-assist"]);
    // An id that resolves to nothing is still held.
    expect(checkTouchLimits(normaliseClaims(draft, input), input).map((finding) => finding.rule)).toContain("claim-id");
  });

  it("leaves a draft with nothing to move untouched, and still bounds the raw list", () => {
    const draft = good();
    expect(normaliseClaims(draft, base())).toBe(draft);
    expect(outputSchemaFor("email1").safeParse({ ...goodOutput, claims: Array.from({ length: 7 }, (_, n) => `i360.fact-${n}`) }).success).toBe(false);
  });
});

describe("a subject the touch is never sent with is dropped in code, not held", () => {
  const breakup: OutreachOutput = { kind: "message", subject: "one more on disputes", body: "I'll leave it there. Happy to be pointed elsewhere.", ask: "Happy to be pointed elsewhere.", opener: { ref: "role-runs", kind: "role_pain" }, claims: [] };

  it("strips it from every touch but Email 1, and leaves Email 1's alone", () => {
    for (const kind of SEQUENCE.filter((candidate) => candidate !== "email1" && candidate !== "call")) expect(withoutThreadSubject(breakup, kind), kind).not.toHaveProperty("subject");
    expect(withoutThreadSubject(breakup, "email1")).toHaveProperty("subject", "one more on disputes");
  });
});

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
  });

  it("names every source by its host, never by the speaker research read off the page (Sentinel CWE-345), and with no table of bodies", () => {
    expect(sourceNameOf(item("callcentrehelper", "weak", false))).toBe("callcentrehelper.example");
    expect(sourceNameOf({ evidence: { urls: ["https://www.fca.org.uk/publications/x"] } })).toBe("fca.org.uk");
    expect(evidenceListOf([item("vendor", "weak", false)])[0]?.sourceName).toBe("vendor.example");
  });
});

describe("the envelope the rep copies (D3: no opt-out line)", () => {
  const envelope = envelopeOf({ firstName: "Avery", repName: "Sam", signature: "<p>Sam Carter<br>Conversant</p><p>07700 900000</p>" });

  it("reads a pasted HTML signature back as plain lines", () => {
    expect(signatureText("<p>Sam Carter<br>Conversant</p><p>07700 900000</p>")).toBe("Sam Carter\nConversant\n\n07700 900000");
    expect(signatureText("<div>Sam &amp; Co</div>")).toBe("Sam & Co");
    expect(signatureText("")).toBe("");
  });

  it("puts the greeting, body, sign-off and signature in that order, and nothing after them", () => {
    expect(emailCopyText("The body.", envelope)).toBe("Hi Avery,\n\nThe body.\n\nSam\n\nSam Carter\nConversant\n\n07700 900000");
    expect(envelope).not.toHaveProperty("optOut");
  });

  it("leaves out a part the rep has not given, rather than leaving a gap", () => {
    expect(emailCopyText("The body.", envelopeOf({ firstName: "Avery", repName: "", signature: "" }))).toBe("Hi Avery,\n\nThe body.");
  });
});

describe("the second call has its own script", () => {
  it("shows call 1 its own lines and call 2 its own, from the one stored script", () => {
    const stored = ["Open with: First opener.", "Ask: First question?", "Call 2, open with: Second opener.", "Call 2, ask: Second question?", "Listen for: who owns it", "Voicemail: A short message."].join("\n\n");
    expect(callScriptFor("call1", stored)).toBe("Open with: First opener.\n\nAsk: First question?\n\nListen for: who owns it\n\nVoicemail: A short message.");
    expect(callScriptFor("call2", stored)).toBe("Open with: Second opener.\n\nAsk: Second question?\n\nListen for: who owns it\n\nVoicemail: A short message.");
  });

  it("falls back to the one script for a call written before M2", () => {
    const old = "Open with: Only opener.\n\nAsk: Only question?\n\nListen for: who owns it";
    expect(callScriptFor("call2", old)).toBe(old);
  });
});

describe("the cohort window", () => {
  it("keeps every touch of the 40 most recent people and stops at the people cap, not a draft count", () => {
    expect(COHORT_PEOPLE).toBe(40);
    const drafts = Array.from({ length: 45 }, (_, person) => Array.from({ length: 7 }, (_, touch) => ({ campaignPersonId: `p${person}`, touch }))).flat();
    const window = peopleWindow(drafts, COHORT_PEOPLE);
    expect(new Set(window.map((draft) => draft.campaignPersonId)).size).toBe(40);
    expect(window).toHaveLength(40 * 7);
  });
});

describe("the default voice", () => {
  it("is the rep's own samples when they have any, and the vendored anchors and style when they have none", () => {
    const fallback = loadDefaultVoice();
    const none = voiceInputOf({ samples: [], howIWrite: "" }, fallback);
    expect(none.anchors).toEqual(fallback.anchors);
    expect(none.howIWrite).toContain("I reckon");
    const own = voiceInputOf({ samples: [{ text: "Morning, a quick note from me." }], howIWrite: "Short and dry." }, fallback);
    expect(own).toEqual({ email: ["Morning, a quick note from me."], linkedin: [], howIWrite: "Short and dry." });
  });

  it("vendors both registers and credits its source", () => {
    const file = JSON.parse(readFileSync("agents/outreach/voice/anchors.json", "utf8")) as { source: string; anchors: { register: string }[] };
    expect(file.source).toMatch(/Vendored 28 Sep 2026/);
    expect(new Set(file.anchors.map((item) => item.register))).toEqual(new Set(["email", "linkedin"]));
  });

  it("carries none of the real people or firms the fleet's samples were written to, nor the standard's worked example", () => {
    const vendored = ["agents/outreach/voice/anchors.json", "agents/outreach/voice/style.md", "agents/outreach/standard.json", "agents/outreach/prompt.md", "agents/outreach/definition.md"]
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    // Each real name is a fingerprint (the first 16 hex characters of the SHA-256 of the lower-case name),
    // checked against every run of one to three words, so the names stay out of the repository even here.
    const REAL = new Set([
      "ff85d4845712dc11",
      "fb1f805aa093d371",
      "acc354c65584b0b0",
      "9e9115ceca636c46",
      "2a494ed8525ab84f",
      "b3e5c5d33d61b825",
      "13d17b90a3e31717",
      "3460eb8087523e19",
      "34550715062af006",
      "2ebba2b55c6adb0a",
      "cc493644d129c078",
      "eee9e0172bbf5a80",
      // The standard v3 worked example's prospect, firm and the trial firm it cites (28 Sep 2026).
      "09d6cb65f440ddea",
      "5580b892a00b388b",
      "1d3b111b3b33aac0",
    ]);
    const tokens = vendored.toLowerCase().replace(/[’']s\b/g, "").match(/[a-z&]+/g) ?? [];
    const found = tokens.flatMap((_, i) => [1, 2, 3].map((n) => tokens.slice(i, i + n).join(" "))).filter((run) => REAL.has(createHash("sha256").update(run).digest("hex").slice(0, 16)));
    expect(found).toEqual([]);
  });
});
