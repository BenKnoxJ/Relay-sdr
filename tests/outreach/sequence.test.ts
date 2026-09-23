import { describe, expect, it } from "vitest";

import { SEQUENCE, outreachInputSchema, type OutreachInput, type TouchKind } from "../../agents/outreach/input.schema";
import { LIMITS, checkTouchLimits, outputSchemaFor, type OutreachOutput } from "../../agents/outreach/output.schema";
import { sequenceOutputSchema, touchesOf, withProse } from "../../agents/outreach/sequence.schema";
import goodInput from "../../agents/outreach/fixtures/input.good.json";
import { addedFacts, gateTouch, type GateContext } from "@/lib/outreach/gates";
import { loadStandard } from "@/lib/outreach/standard";

/**
 * P2 (21 Sep 2026): the rest of the sequence. Every touch kind has its own
 * limits and reads only its own row; the call script carries a short voicemail
 * and at most three objections; one touch out of shape does not sink the
 * others; and the humanizer can only reword, never add.
 */

function input(kind: TouchKind, thread: OutreachInput["thread"] = []): OutreachInput {
  const base = outreachInputSchema.parse(goodInput);
  return { ...base, standard: loadStandard(), touch: { kind, ordinal: SEQUENCE.indexOf(kind) + 1, dueAt: "2026-09-21T09:00:00Z" }, thread };
}

const context: GateContext = { productNames: ["Insights360"], repName: "Sam Carter", cohort: [] };

type Message = Extract<OutreachOutput, { kind: "message" }>;

/** A message of exactly `n` words, its last sentence the ask. */
function words(n: number): Message {
  const ask = "Is this relevant?";
  const lead = Array.from({ length: n - 3 }, () => "calls").join(" ");
  return { kind: "message", body: `${lead}. ${ask}`, ask, opener: { ref: "role-runs", kind: "role_pain" }, claims: [] };
}

function chars(n: number): Message {
  const ask = "Open to connecting?";
  return { kind: "message", body: `${"a".repeat(n - ask.length - 1)} ${ask}`, ask, opener: { ref: "role-runs", kind: "role_pain" }, claims: [] };
}

const lengthRules = (draft: OutreachOutput, kind: TouchKind, thread?: OutreachInput["thread"]) =>
  checkTouchLimits(draft, input(kind, thread))
    .map((finding) => finding.rule)
    .filter((rule) => rule === "length" || rule === "no-link" || rule === "shorter-than-the-last");

const call = (point: Record<string, unknown>) => ({
  kind: "call",
  talkingPoint: { openingLine: "It's about the calls behind complaints.", oneQuestion: "Is that yours?", listenFor: "who owns it", numberSource: "find_a_number", ...point },
  opener: { ref: "role-runs", kind: "role_pain" },
  claims: [],
});

describe("each touch kind's limits, at its boundary", () => {
  it("email1: 40 to 110 words, unchanged", () => {
    expect(LIMITS.email1).toEqual({ minWords: 40, maxWords: 110 });
    expect(lengthRules(words(40), "email1")).toEqual([]);
    expect(lengthRules(words(39), "email1")).toEqual(["length"]);
    expect(lengthRules(words(110), "email1")).toEqual([]);
    expect(lengthRules(words(111), "email1")).toEqual(["length"]);
  });

  it("email2: at most 100 words", () => {
    expect(lengthRules(words(100), "email2")).toEqual([]);
    expect(lengthRules(words(101), "email2")).toEqual(["length"]);
  });

  it("breakup: at most 70 words", () => {
    expect(lengthRules(words(70), "breakup")).toEqual([]);
    expect(lengthRules(words(71), "breakup")).toEqual(["length"]);
  });

  it("li_connect: at most 200 characters, no link", () => {
    expect(lengthRules(chars(200), "li_connect")).toEqual([]);
    expect(lengthRules(chars(201), "li_connect")).toEqual(["length"]);
    expect(lengthRules({ ...chars(60), body: "See https://example.com first. Open to connecting?" }, "li_connect")).toEqual(["no-link"]);
  });

  it("li_dm: 50 to 80 words, no link", () => {
    expect(lengthRules(words(50), "li_dm")).toEqual([]);
    expect(lengthRules(words(49), "li_dm")).toEqual(["length"]);
    expect(lengthRules(words(80), "li_dm")).toEqual([]);
    expect(lengthRules(words(81), "li_dm")).toEqual(["length"]);
  });

  it("li_dm2: at most 60 words, no link", () => {
    expect(lengthRules(words(60), "li_dm2")).toEqual([]);
    expect(lengthRules(words(61), "li_dm2")).toEqual(["length"]);
    const linked = words(20);
    expect(lengthRules({ ...linked, body: `https://example.com ${linked.body}` }, "li_dm2")).toEqual(["no-link"]);
  });

  it("reads only its own row: 75 words passes where its kind allows it and fails where it does not", () => {
    const draft = words(75);
    expect(lengthRules(draft, "email2")).toEqual([]);
    expect(lengthRules(draft, "li_dm")).toEqual([]);
    expect(lengthRules(draft, "breakup")).toEqual(["length"]);
    expect(lengthRules(draft, "li_dm2")).toEqual(["length"]);
    expect(lengthRules(draft, "email1")).toEqual([]);
  });

  it("a follow-up email is shorter than the email before it, and a LinkedIn note in between does not count", () => {
    const first = { kind: "email1" as const, ordinal: 1, body: words(60).body, fate: "drafted" as const };
    expect(lengthRules(words(60), "email2", [first])).toEqual(["shorter-than-the-last"]);
    expect(lengthRules(words(59), "email2", [first])).toEqual([]);
    const second = { kind: "email2" as const, ordinal: 2, body: words(50).body, fate: "drafted" as const };
    const note = { kind: "li_connect" as const, ordinal: 4, body: "Open to connecting?", fate: "drafted" as const };
    // The break-up is measured against the follow-up email, not the connection note.
    expect(lengthRules(words(40), "breakup", [first, second, note])).toEqual([]);
    expect(lengthRules(words(50), "breakup", [first, second, note])).toEqual(["shorter-than-the-last"]);
    // A LinkedIn message is not measured against the emails at all.
    expect(lengthRules(words(70), "li_dm", [first, second])).toEqual([]);
  });
});

describe("the call script", () => {
  it("takes a voicemail of 40 words and refuses 41", () => {
    const forty = Array.from({ length: 40 }, () => "calling").join(" ");
    expect(outputSchemaFor("call").safeParse(call({ voicemail: forty })).success).toBe(true);
    const parsed = outputSchemaFor("call").safeParse(call({ voicemail: `${forty} again` }));
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toMatch(/40 words or fewer/);
  });

  it("takes at most three objection pairs", () => {
    const pair = { objection: "We already sample calls.", answer: "That makes sense." };
    expect(outputSchemaFor("call").safeParse(call({ voicemail: "Calling about complaints.", objections: [pair, pair, pair] })).success).toBe(true);
    expect(outputSchemaFor("call").safeParse(call({ voicemail: "Calling about complaints.", objections: [pair, pair, pair, pair] })).success).toBe(false);
  });

  it("still reads a talking point written before P2, and the gate holds one with no voicemail", () => {
    const older = outputSchemaFor("call").parse(call({}));
    expect(gateTouch(older, input("call"), context).tierA.map((finding) => finding.rule)).toContain("voicemail");
    const current = outputSchemaFor("call").parse(call({ voicemail: "Calling about the calls behind complaints; I will send a note by email." }));
    expect(gateTouch(current, input("call"), context).tierA).toEqual([]);
  });

  it("is asked for with both in the sequence", () => {
    const shape = sequenceOutputSchema.shape.call;
    expect(shape.safeParse(call({})).success).toBe(false);
    expect(shape.safeParse(call({ voicemail: "Calling about complaints.", objections: [] })).success).toBe(true);
  });
});

describe("the sequence answer", () => {
  const message = (body: string, ask: string) => ({ kind: "message", body, ask, opener: { ref: "role-runs", kind: "role_pain" }, claims: [] });
  const answer = {
    email1: message("Complaints come from calls nobody heard. Is that yours?", "Is that yours?"),
    email2: message("One more thought on it. Is it live?", "Is it live?"),
    breakup: message("I will stop here. Who owns it?", "Who owns it?"),
    li_connect: message("Your role came up. Open to connecting?", "Open to connecting?"),
    // An em dash: this touch's own rule.
    li_dm: message("Thanks for connecting — one thought. Is it live?", "Is it live?"),
    li_dm2: message("A last thought. Worth a chat?", "Worth a chat?"),
    call: call({ voicemail: "Calling about complaints.", objections: [] }),
  };

  it("checks each touch against its own rules: one out of shape leaves the other six", () => {
    const parsed = touchesOf(sequenceOutputSchema.parse(answer));
    expect(parsed.map((touch) => touch.kind)).toEqual([...SEQUENCE]);
    expect(parsed.filter((touch) => touch.output === null).map((touch) => touch.kind)).toEqual(["li_dm"]);
    expect(parsed.find((touch) => touch.kind === "li_dm")!.issues.join(" ")).toMatch(/^li_dm\.body: /);
  });

  it("is offered as structure only: a touch's own rules are not in the answer's schema", () => {
    expect(sequenceOutputSchema.safeParse(answer).success).toBe(true);
  });
});

describe("the humanizer: facts locked, voice free", () => {
  const drafted: OutreachOutput = {
    kind: "message",
    subject: "Calls behind complaints",
    body: "Most complaints trace back to calls nobody heard. We read every recorded call. Is that a gap for you?",
    ask: "Is that a gap for you?",
    opener: { ref: "role-runs", kind: "role_pain" },
    claims: ["i360.read-every-call"],
  };

  it("puts the words back on the drafted touch: the opener and the claims are the draft's", () => {
    const next = withProse(drafted, { body: "Most complaints start on calls nobody heard. We read every recorded call. Is that a gap for you?", ask: "Is that a gap for you?" });
    expect(next).toMatchObject({ opener: drafted.opener, claims: drafted.claims, subject: "Calls behind complaints" });
    // No subject where the draft had none: the humanizer does not start a thread.
    const plain = withProse({ ...drafted, subject: undefined } as OutreachOutput, { subject: "New subject", body: "Hi.", ask: "Hi." });
    expect(plain && "subject" in plain ? plain.subject : undefined).toBeUndefined();
    expect(withProse(drafted, undefined)).toBeNull();
  });

  it("finds what a rewrite added: a number, a name, never a reworded plain word", () => {
    const reworded = { ...drafted, body: "Most complaints start on calls no one heard. We read every recorded call. Is that a gap for you?" } as OutreachOutput;
    expect(addedFacts(drafted, reworded)).toEqual([]);
    const numbered = { ...drafted, body: `${(drafted as { body: string }).body.replace("Most complaints", "Most complaints (72%)")}` } as OutreachOutput;
    expect(addedFacts(drafted, numbered)).toEqual(["72%"]);
    const named = { ...drafted, body: "Most complaints trace back to calls nobody heard, as Aviva found. We read every recorded call. Is that a gap for you?" } as OutreachOutput;
    expect(addedFacts(drafted, named)).toEqual(["Aviva"]);
    // A changed figure is an added one, even when its digits sit inside the old one.
    const fifteen = { ...drafted, body: "About 15% of calls get heard. Is that a gap for you?" } as OutreachOutput;
    expect(addedFacts(fifteen, { ...fifteen, body: "About 5% of calls get heard. Is that a gap for you?" } as OutreachOutput)).toEqual(["5%"]);
    expect(addedFacts(fifteen, { ...fifteen, body: "Only 15% of calls get heard. Is that a gap for you?" } as OutreachOutput)).toEqual([]);
  });
});

describe("the gates on the rest of the sequence", () => {
  const ask = "Is that something your team is looking at this year, or is it settled for now?";
  const dm: OutreachOutput = {
    kind: "message",
    body: `In claims teams, something that comes up a lot is that the calls behind a complaint are found late, because only a small sample gets reviewed. Reading every call turns that around, so coaching can start in the same week as the call. ${ask}`,
    ask,
    opener: { ref: "role-runs", kind: "role_pain" },
    claims: [],
  };

  it("passes a clean LinkedIn message", () => {
    expect(gateTouch(dm, input("li_dm"), context).tierA).toEqual([]);
  });

  it("holds the tell list, a time ask, a greeting and an unsourced name on any touch", () => {
    const rules = (draft: OutreachOutput, kind: TouchKind) => gateTouch(draft, input(kind), context).tierA.map((finding) => finding.rule);
    const withBody = (body: string) => ({ ...dm, body: `${body} ${ask}` }) as OutreachOutput;
    expect(rules(withBody("I wanted to reach out after reading about complaint handling in claims teams, since the calls behind a complaint are found late when only a small sample gets reviewed and the pattern hides."), "li_dm")).toContain("tells");
    expect(rules({ ...dm, body: "Could we find twenty minutes next week?", ask: "Could we find twenty minutes next week?" } as OutreachOutput, "email2")).toContain("time-ask");
    expect(rules({ ...dm, body: `Hi Helen, one more thought. ${ask}` } as OutreachOutput, "email2")).toContain("envelope");
    expect(rules({ ...dm, body: `A thought after talking to Zenith Claims about this. ${ask}` } as OutreachOutput, "li_dm2")).toContain("unsourced-name");
    expect(rules({ ...dm, body: `More at https://example.com on this. ${ask}` } as OutreachOutput, "breakup")).toContain("link");
  });

  it("refuses the wrong shape for the touch", () => {
    expect(gateTouch(dm, input("call"), context).tierA.map((finding) => finding.rule)).toEqual(["kind"]);
  });
});
