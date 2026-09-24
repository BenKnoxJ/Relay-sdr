import { describe, expect, it } from "vitest";

import { SEQUENCE, outreachInputSchema, type EvidenceQuote, type OutreachInput, type TouchKind } from "../../agents/outreach/input.schema";
import type { OutreachOutput } from "../../agents/outreach/output.schema";
import goodInput from "../../agents/outreach/fixtures/input.good.json";
import { SOURCE_FIX_MAX_CHARS, closestQuote, gateEmail1, gateTouch, sourceClaimFix, withoutThreadSubject, type GateContext } from "@/lib/outreach/gates";
import { loadStandard } from "@/lib/outreach/standard";

/**
 * M2 fix round 1 (23 Sep 2026), from the partial cohort's two people. Emlyn's
 * holds that were right stay held; the ones that were wrong or avoidable go: a
 * channel word is not an unsourced name, a subject the touch is never sent
 * with is dropped rather than held, and a held source claim or paragraph tells
 * the corrective call exactly what to do.
 */

const standard = loadStandard();
const gives: EvidenceQuote[] = standard.gives;

function input(kind: TouchKind): OutreachInput {
  const base = outreachInputSchema.parse(goodInput);
  return { ...base, standard, pack: { ...base.pack, evidence: gives }, touch: { kind, ordinal: SEQUENCE.indexOf(kind) + 1, dueAt: "2026-09-23T09:00:00Z" }, thread: [] };
}

const context: GateContext = { productNames: ["Insights360"], repName: "Sam Carter", cohort: [] };
const rules = (draft: OutreachOutput, kind: TouchKind) => gateTouch(draft, input(kind), context).tierA.map((finding) => finding.rule);
const texts = (draft: OutreachOutput, kind: TouchKind, rule: string) =>
  (kind === "email1" ? gateEmail1(draft, input(kind), context) : gateTouch(draft, input(kind), context)).tierA.filter((finding) => finding.rule === rule).map((finding) => finding.text);

const message = (body: string, ask: string, subject?: string): OutreachOutput => ({ kind: "message", ...(subject === undefined ? {} : { subject }), body, ask, opener: { ref: "role-runs", kind: "role_pain" }, claims: [] });

/** Emlyn's call script as the 23 Sep partial cohort wrote it, the talking point only. */
const emlynCall = (writeUp: string): OutreachOutput => ({
  kind: "call",
  talkingPoint: {
    openingLine: "Hi Helen, it's Ben from Conversant. I emailed about the disputes behind motor complaints. Is this a bad time?",
    oneQuestion: "When a valuation or cancellation dispute comes in, how do you find the calls that led to it?",
    openingLine2: "Hi Helen, Ben again from Conversant. I sent a note on LinkedIn about how review calls get picked. Is this a good time to talk?",
    oneQuestion2: "If you changed how a handler explains a delay, how would you check whether it helped?",
    listenFor: "If Helen can pull together the calls behind a dispute today, and who would own that.",
    numberSource: "find_a_number",
    voicemail: "Hi Helen, it's Ben from Conversant. I emailed about the calls behind valuation disputes. No need to call back, I'll follow up by email.",
    objections: [{ objection: "Send me something in writing.", answer: writeUp }],
  },
  opener: { ref: "role-runs", kind: "role_pain" },
  claims: [],
});

describe("channel and product words are not unsourced names", () => {
  it("lets the call say LinkedIn, and the rep's own company, and still holds its paraphrased FCA write-up", () => {
    const call = emlynCall("Happy to send that over. It's the FCA's review of complaint handling at 40 firms, and it ties into what we've talked about.");
    expect(texts(call, "call", "unsourced-name")).toEqual([]);
    expect(rules(call, "call")).toContain("unsupported-source-claim");
  });

  it.each([
    ["LinkedIn", "I sent a note on LinkedIn about how review calls get picked."],
    ["Outlook", "The invite sits in Outlook for most claims teams."],
    ["Teams", "Most of these calls now happen on Teams rather than the phone."],
    ["Microsoft Teams", "Most of these calls now happen on Microsoft Teams rather than the phone."],
    ["Zoom", "A call on Zoom is recorded the same way as one on the phone."],
  ])("never flags %s", (_word, sentence) => {
    const ask = "Who looks after the recordings on your side?";
    expect(texts(message(`${sentence} Reading every call shows which ones matter. ${ask}`, ask), "li_dm", "unsourced-name")).toEqual([]);
  });

  it("still holds an invented person and firm, as Emlyn's LinkedIn message had them", () => {
    const ask = "Who decides which calls actually get listened to each week?";
    const dm = message(
      `Team leaders often review whichever calls they have time for. Garry Gormley, founder of FAB Solutions, has said that larger sample sizes place unnecessary strain on QA teams. ${ask}`,
      ask,
    );
    const [text] = texts(dm, "li_dm", "unsourced-name");
    expect(text).toContain('"Garry Gormley"');
    expect(text).toContain('"FAB Solutions"');
  });
});

describe("a subject the touch is never sent with is dropped in code, not held", () => {
  const breakup = message(
    "I won't keep filling your inbox on this. If finding the calls behind a valuation, cancellation or delay dispute sits with someone else on your claims team, who would be the right person to ask?",
    "If finding the calls behind a valuation, cancellation or delay dispute sits with someone else on your claims team, who would be the right person to ask?",
    "one more on disputes",
  );

  it("strips it from every touch but Email 1, and leaves Email 1's alone", () => {
    for (const kind of SEQUENCE.filter((candidate) => candidate !== "email1" && candidate !== "call")) {
      expect(withoutThreadSubject(breakup, kind), kind).not.toHaveProperty("subject");
    }
    expect(withoutThreadSubject(breakup, "email1")).toHaveProperty("subject", "one more on disputes");
  });

  it("passes Emlyn's last email once its subject is gone: no thread-subject rule is left to hold it", () => {
    expect(rules(withoutThreadSubject(breakup, "breakup"), "breakup")).toEqual([]);
    expect(rules(breakup, "breakup")).not.toContain("thread-subject");
  });

  it("no longer holds a LinkedIn message for its discarded subject, and still holds a paraphrase in its body", () => {
    const ask = "How far back can you go if the board asks about a specific dispute type?";
    const quoted = message(`${gives[2]!.quote} It doesn't cover the conversations that led there. ${ask}`, ask, "what the fca publishes");
    expect(rules(withoutThreadSubject(quoted, "li_dm2"), "li_dm2")).not.toContain("unsupported-source-claim");
    const paraphrased = message(`The FCA publishes figures showing most complaints are upheld. ${ask}`, ask);
    expect(rules(paraphrased, "li_dm2")).toContain("unsupported-source-claim");
  });
});

describe("the corrective call is told exactly what to do", () => {
  it("names the approved quote a paraphrase was reaching for, word for word, with its source", () => {
    const sentence = "The FCA's review of 40 firms found firms weren't checking whether their changes were working.";
    const fca = gives.find((give) => give.id === "give-fca-interventions-not-measured")!;
    expect(closestQuote(sentence, gives)?.id).toBe(fca.id);
    const ask = "Who owns showing whether a change like that worked?";
    const [text] = texts(message(`When a script changes, proving it worked means re-listening to calls. ${sentence} ${ask}`, ask), "email2", "unsupported-source-claim");
    expect(text).toContain(`Use this approved quote exactly: "${fca.quote}" (${fca.sourceName}).`);
    expect(text).toContain("Or remove the source reference.");
  });

  it("says to remove the reference when no approved quote is close", () => {
    const text = sourceClaimFix("The regulator is cracking down on this.", closestQuote("The regulator is cracking down on this.", gives));
    expect(text).toContain("remove the source reference");
    expect(text).not.toContain("approved quote exactly");
  });

  it("gives one finding per held sentence, each short enough to reach the corrective call whole", () => {
    const ask = "Is that on your list this year?";
    const body = `The ombudsman says motor complaints doubled. The FCA's review of 40 firms found firms weren't checking whether their changes were working. ${ask}`;
    const held = texts(message(body, ask), "email2", "unsupported-source-claim");
    expect(held).toHaveLength(2);
    for (const text of held) expect(`breakup: ${text}`.length).toBeLessThanOrEqual(500);
    const long: EvidenceQuote = { id: "give-long", quote: `${"Complaints rose sharply across motor insurance ".repeat(12)}.`, sourceName: "the ombudsman", url: "https://example.com/q" };
    const fix = sourceClaimFix("The ombudsman says complaints rose sharply across motor insurance.", long);
    expect(fix.length).toBeLessThanOrEqual(SOURCE_FIX_MAX_CHARS);
    expect(fix).toContain("Use approved quote give-long from the evidence list exactly");
  });

  it("says where to split a paragraph that runs past three sentences", () => {
    const ask = "When a valuation or cancellation dispute lands, how do you pull together the calls that led to it?";
    const email = message(
      `Motor disputes tend to be the same three arguments: value, cancellation and delay. Each one gets handled on its own. Without a way to search the call base by theme, the pattern stays hidden. ${ask}`,
      ask,
      "the same three disputes",
    );
    const [text] = texts(email, "email1", "paragraphs");
    expect(text).toBe('A paragraph runs to 4 sentences; a phone screen wants three at most. Split this paragraph: start a new paragraph at "Without a way to search the call base…".');
  });
});
