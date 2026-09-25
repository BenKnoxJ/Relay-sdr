import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SEQUENCE, outreachInputSchema, packSliceSchema, type Exemplar, type OutreachInput, type TouchKind } from "../../agents/outreach/input.schema";
import { outputSchemaFor, type OutreachOutput } from "../../agents/outreach/output.schema";
import recorded from "../../fixtures/outreach/cohort-2026-09-15.json";
import { loadFacts } from "@/lib/facts/load";
import { liveFacts, withApprovedGives } from "@/lib/outreach/adapter";
import { gateFor, normaliseClaims, type GateContext } from "@/lib/outreach/gates";
import { genderedPronouns, isBinaryAsk, mentionsPrice, mentionsProduct, stockOpener, type CheckedTouch } from "@/lib/outreach/messageChecks";
import { loadStandard } from "@/lib/outreach/standard";

/**
 * Messaging v2 (22 Sep 2026): the writing standard at version 2. Its rules are
 * the change map's eight; its exemplars are worked touches that pass the same
 * gates a real draft meets, on the fixture people they were written for; and
 * its tell list holds the fleet lexicon and the stock outreach openers.
 */

const standard = loadStandard();
const facts = liveFacts(loadFacts("insights360", 2).facts);
const context: GateContext = { productNames: [facts.product], repName: "Alex", cohort: [] };
const SENDER = { firstName: "Alex", company: "Conversant" };

/** Which fixture person each exemplar was written for, by its opener: Avery's sequence, and one Email 1 per role and opener. */
const PERSON_FOR_REF: Record<string, string> = {
  "look-6eea2e4db932": "Avery Dunmore",
  "look-83e6d8082ec4": "Blair Kendrick",
  "pn-a1-published-but-blind": "Marlo Holloway",
  "pn-a1-same-three-arguments": "Orla Bellamy",
};

function inputFor(exemplar: Exemplar, thread: OutreachInput["thread"]): OutreachInput {
  const name = exemplar.touch === "email1" ? PERSON_FOR_REF[exemplar.draft.opener.ref] : "Avery Dunmore";
  const person = recorded.people.find((entry) => entry.name === name);
  if (person === undefined) throw new Error(`no fixture person for ${exemplar.shows}`);
  const kind = exemplar.touch;
  return outreachInputSchema.parse({
    ...person.input,
    sender: SENDER,
    // The real input merges the standard's approved gives into the slice (M2); `buildOutreachInput` does it for a live draft.
    pack: withApprovedGives(packSliceSchema.parse(recorded.pack), standard, new Date("2026-09-25T09:00:00Z")),
    facts,
    standard,
    touch: { kind, ordinal: SEQUENCE.indexOf(kind) + 1, dueAt: "2026-09-22T09:00:00Z" },
    thread,
  });
}

function checked(exemplar: Exemplar): CheckedTouch {
  const draft = exemplar.draft;
  if (draft.kind === "message") return { kind: exemplar.touch, ...(draft.subject === undefined ? {} : { subject: draft.subject }), body: draft.body, ask: draft.ask, claims: draft.claims };
  const point = draft.talkingPoint;
  const body = [point.openingLine, point.oneQuestion, point.listenFor, point.voicemail ?? "", ...(point.objections ?? []).flatMap((pair) => [pair.objection, pair.answer])].join("\n\n");
  return { kind: "call", body, ask: point.oneQuestion, claims: draft.claims };
}

const email1s = standard.exemplars.filter((exemplar) => exemplar.touch === "email1");

describe("the writing standard, version 2", () => {
  it("loads: version 2, the eight rules, and an exemplar for every touch kind but the LinkedIn follow-up", () => {
    expect(standard.version).toBe(2);
    expect(standard.rules).toHaveLength(8);
    expect(standard.exemplars.map((exemplar) => exemplar.touch)).toEqual(["email1", "email1", "email1", "email1", "email2", "breakup", "li_connect", "li_dm", "call"]);
  });

  it("states the product owner's decisions in its rules: no pitch in Email 1, price only when asked and complete, no gender, no stock openers", () => {
    const rules = standard.rules.join("\n");
    expect(rules).toMatch(/Email 1 neither names nor describes the product/);
    expect(rules).toMatch(/£1,280/);
    expect(rules).toMatch(/£640 configuration review/);
    expect(rules).toMatch(/per-seat monthly plans/);
    expect(rules).toMatch(/never he, she, him or her/);
    expect(rules).toMatch(/At most one "X, or Y\?" question in the whole sequence/);
    expect(rules).toMatch(/Thanks for connecting/);
    // The opt-out line is added at send (P7), never written into a draft.
    expect(rules).toMatch(/opt-out line \("If this isn.t relevant, just reply and I won.t follow up."\) are added below the sign-off/);
  });

  it("gives four Email 1 exemplars across the three roles and the three opener kinds, each with a different ask", () => {
    expect(new Set(email1s.map((exemplar) => exemplar.draft.opener.kind))).toEqual(new Set(["person_fact", "firm_fact", "role_pain"]));
    expect(email1s.map((exemplar) => exemplar.shows.split(" · ")[1])).toEqual(["runs it", "runs it", "champions it", "signs it off"]);
    const asks = email1s.map((exemplar) => (exemplar.draft.kind === "message" ? exemplar.draft.ask : ""));
    expect(new Set(asks).size).toBe(4);
  });

  it.each(email1s.map((exemplar, index) => [index + 1, exemplar] as const))("Email 1 exemplar %i makes no product sentence and cites no fact", (_index, exemplar) => {
    expect(exemplar.draft.claims).toEqual([]);
    expect(mentionsProduct(checked(exemplar), facts.product)).toBe(false);
  });

  it("puts the product in writing once across the sequence's exemplars, and price only in the call script, complete", () => {
    const sequence = standard.exemplars.filter((exemplar) => exemplar.touch !== "email1" || exemplar.draft.opener.ref === "look-6eea2e4db932");
    const written = sequence.filter((exemplar) => exemplar.touch !== "call");
    expect(written.filter((exemplar) => mentionsProduct(checked(exemplar), facts.product)).map((exemplar) => exemplar.touch)).toEqual(["email2"]);
    expect(standard.exemplars.filter((exemplar) => mentionsPrice(checked(exemplar))).map((exemplar) => exemplar.touch)).toEqual(["call"]);
    const call = standard.exemplars.find((exemplar) => exemplar.touch === "call")!;
    const answer = call.draft.kind === "call" ? call.draft.talkingPoint.objections!.find((pair) => /cost/i.test(pair.objection))!.answer : "";
    expect(answer).toMatch(/£1,280/);
    expect(answer).toMatch(/£640 configuration review/);
    expect(answer).toMatch(/per seat, per month/);
  });

  it("uses no gendered pronoun, no stock opener or subject and no \"X, or Y?\" ask in any exemplar", () => {
    for (const exemplar of standard.exemplars) {
      expect(genderedPronouns(checked(exemplar)), exemplar.shows).toEqual([]);
      expect(stockOpener(checked(exemplar)), exemplar.shows).toBeNull();
      expect(isBinaryAsk(checked(exemplar).ask), exemplar.shows).toBe(false);
    }
  });

  it("keeps the LinkedIn message exemplar inside 50 to 80 words, and opens it on the point", () => {
    const dm = standard.exemplars.find((exemplar) => exemplar.touch === "li_dm")!;
    const body = dm.draft.kind === "message" ? dm.draft.body : "";
    const words = body.trim().split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(50);
    expect(words).toBeLessThanOrEqual(80);
    expect(body).not.toMatch(/^(?:thanks|thank you|good to be connected)/i);
  });

  it.each(standard.exemplars.map((exemplar) => [exemplar.shows.split(" · ").slice(0, 2).join(" · "), exemplar] as const))("%s passes its touch's shape and every Tier A gate", (_label, exemplar) => {
    const shaped = outputSchemaFor(exemplar.touch).safeParse(exemplar.draft);
    expect(shaped.success, shaped.success ? "" : JSON.stringify(shaped.error.issues)).toBe(true);
    // A follow-up is measured against the Email 1 it follows: Avery's.
    const avery = email1s[0]!.draft as Extract<OutreachOutput, { kind: "message" }>;
    const thread: OutreachInput["thread"] = exemplar.touch === "email1" ? [] : [{ kind: "email1", ordinal: 1, subject: avery.subject!, body: avery.body, fate: "drafted" }];
    const input = inputFor(exemplar, thread);
    const result = gateFor(normaliseClaims(shaped.data!, input), input, context);
    expect(result.tierA).toEqual([]);
  });
});

describe("the tell list, version 2", () => {
  const ask = "How do your team leaders choose which calls to review?";
  const dm = (opening: string): OutreachOutput => ({
    kind: "message",
    body: `${opening} Delay calls are hard to review well when each handler has a monthly review target, and the difficult ones are the least likely to be heard. ${ask}`,
    ask,
    opener: { ref: "pn-a1-coaching-on-anecdote", kind: "role_pain" },
    claims: [],
  });
  const avery = recorded.people.find((entry) => entry.name === "Avery Dunmore")!;
  const input = (kind: TouchKind) =>
    outreachInputSchema.parse({ ...avery.input, sender: SENDER, pack: recorded.pack, facts, standard, touch: { kind, ordinal: SEQUENCE.indexOf(kind) + 1, dueAt: "2026-09-22T09:00:00Z" }, thread: [] });
  const tells = (draft: OutreachOutput, kind: TouchKind) => gateFor(draft, input(kind), context).tierA.find((finding) => finding.rule === "tells")?.text ?? "";

  it.each([
    ["Thanks for connecting.", "thanks for connecting"],
    ["Just following up on this.", "just following up"],
    ["Did you see my email about it?".replace("?", "."), "did you see my email"],
    ["Sound familiar, perhaps.", "sound familiar"],
    ["That being said, it matters.", "that being said"],
    ["Our tool is best in class here.", "best in class"],
    ["It takes review to the next level.", "next level"],
    ["It is industry leading work.", "industry leading"],
    ["The landscape is changing.", "landscape"],
    ["It is a robust process.", "robust"],
  ])("holds %j as a tell", (opening, entry) => {
    expect(tells(dm(opening), "li_dm")).toContain(`"${entry}"`);
  });

  it("holds a stock subject and a presumptive \"or is that\" ask", () => {
    const binary = "Is delay the main theme, or is that guesswork?";
    const breakup: OutreachOutput = { kind: "message", subject: "one last note", body: `I'll leave it here. ${binary}`, ask: binary, opener: { ref: "look-6eea2e4db932", kind: "person_fact" }, claims: [] };
    const text = tells(breakup, "breakup");
    expect(text).toContain('"one last note"');
    expect(text).toContain('"or is that"');
  });

  it("carries every term, phrase and marketing line of the fleet lexicon", () => {
    for (const entry of ["delve", "tapestry", "cornerstone", "it's worth mentioning that", "at the heart of", "dive into", "in other words", "put simply", "whether you're", "the kicker", "unlock the full potential", "industry-leading", "best-in-class"]) {
      expect(standard.bannedLexicon).toContain(entry);
    }
    expect(new Set(standard.bannedLexicon).size).toBe(standard.bannedLexicon.length);
  });
});

describe("a call script's cited facts", () => {
  it("finds a price fact's number in an objection answer, where messaging v2 puts price", () => {
    const call = standard.exemplars.find((exemplar) => exemplar.touch === "call")!;
    const input = inputFor(call, []);
    const moved = { ...call.draft, talkingPoint: { ...(call.draft.kind === "call" ? call.draft.talkingPoint : ({} as never)), objections: [{ objection: "What does it cost?", answer: "It depends on the plan." }] } } as OutreachOutput;
    expect(gateFor(call.draft as OutreachOutput, input, context).tierA.map((finding) => finding.rule)).not.toContain("claim-number");
    // With the numbers gone from every line, the cited price facts are held.
    expect(gateFor(moved, input, context).tierA.map((finding) => finding.rule)).toContain("claim-number");
  });
});

describe("the humanizer: the full fleet skill and the outreach overlay", () => {
  const read = (file: string) => readFileSync(new URL(`../../agents/outreach/${file}`, import.meta.url), "utf8");
  const text = read("humanizer.md");

  it("puts the outreach overlay first, winning over the vendored fleet skill, base catalogue and lexicon", () => {
    const parts = ["# Part 1. The outreach overlay", "# Part 2. The fleet humanizer skill", "# Part 3. The base catalogue", "# Part 4. The fleet banned lexicon"].map((heading) => text.indexOf(heading));
    expect(parts.every((index) => index >= 0)).toBe(true);
    expect([...parts].sort((a, b) => a - b)).toEqual(parts);
    expect(text).toMatch(/Part 1, the outreach overlay, wins wherever it disagrees with the rest/);
  });

  it("vendors the whole catalogue: the fleet overlay's six rules, all 33 base patterns, and the three lexicon lists", () => {
    for (let n = 1; n <= 33; n += 1) expect(text).toMatch(new RegExp(`^### ${n}\\. `, "m"));
    for (const rule of ["### 1. Em dashes", "### 4. Who is writing", "### 5. The swap test"]) expect(text).toContain(rule);
    for (const list of ["## BANNED_TERMS", "## BANNED_PHRASES", "## MARKETING_SPEAK"]) expect(text).toContain(list);
    expect(read("humanizer-LICENSE")).toMatch(/Copyright \(c\) 2025 Siqi Chen/);
  });

  it("lets the pass cut a pitch or product sentence and never add one, and adds the outreach rules", () => {
    expect(text).toMatch(/You may cut a pitch or product sentence; never add one\./);
    expect(text).toMatch(/droppedProduct: true/);
    expect(text).toMatch(/## The swap test, for outreach/);
    for (const rule of [/gendered pronoun for the prospect/, /claimed experience/, /False ranges/, /emojis/, /curly/, /speculative gap-filling/, /generic positive endings/, /hyphenated pairs/, /Stock openers and subjects/]) {
      expect(text).toMatch(rule);
    }
    // The old contract protected the product line; it is gone.
    expect(text).not.toMatch(/do not drop the one product sentence/);
  });
});
