import { describe, expect, it } from "vitest";

import { SEQUENCE, outreachInputSchema, type OutreachInput, type TouchKind } from "../../agents/outreach/input.schema";
import { LIMITS, checkTouchLimits, outputSchemaFor, type OutreachOutput } from "../../agents/outreach/output.schema";
import { sequenceOutputSchema, touchesOf } from "../../agents/outreach/sequence.schema";
import goodInput from "../../agents/outreach/fixtures/input.good.json";
import { gateFor, type GateContext } from "@/lib/outreach/gates";
import { loadStandard } from "@/lib/outreach/standard";

/**
 * P2 (21 Sep 2026): the rest of the sequence. Every touch kind has its own
 * limits and reads only its own row; the call script carries a short voicemail
 * and at most three objections; and one touch out of shape does not sink the
 * others. Standard v3 (28 Sep 2026) sets the limits.
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
    .filter((rule) => rule === "length");

const call = (point: Record<string, unknown>) => ({
  kind: "call",
  talkingPoint: { openingLine: "It's about the calls behind complaints.", oneQuestion: "Is that yours?", listenFor: "who owns it", numberSource: "find_a_number", ...point },
  opener: { ref: "role-runs", kind: "role_pain" },
  claims: [],
});

describe("each touch kind's limits, at its boundary (standard v3)", () => {
  it("email1: 50 to 100 words", () => {
    expect(LIMITS.email1).toEqual({ minWords: 50, maxWords: 100 });
    expect(lengthRules(words(50), "email1")).toEqual([]);
    expect(lengthRules(words(49), "email1")).toEqual(["length"]);
    expect(lengthRules(words(100), "email1")).toEqual([]);
    expect(lengthRules(words(101), "email1")).toEqual(["length"]);
  });

  it("email2 at most 90, the breakup and the LinkedIn follow-up at most 50, the LinkedIn message 40 to 70", () => {
    for (const [kind, max] of [["email2", 90], ["breakup", 50], ["li_dm2", 50], ["li_dm", 70]] as const) {
      expect(lengthRules(words(max), kind), kind).toEqual([]);
      expect(lengthRules(words(max + 1), kind), kind).toEqual(["length"]);
    }
    expect(lengthRules(words(40), "li_dm")).toEqual([]);
    expect(lengthRules(words(39), "li_dm")).toEqual(["length"]);
  });

  it("a follow-up need not be shorter than the email before it: the limits are the whole rule", () => {
    const first = { kind: "email1" as const, ordinal: 1, body: words(60).body, fate: "drafted" as const };
    expect(lengthRules(words(80), "email2", [first])).toEqual([]);
  });

  it("li_connect: at most 200 characters", () => {
    expect(lengthRules(chars(200), "li_connect")).toEqual([]);
    expect(lengthRules(chars(201), "li_connect")).toEqual(["length"]);
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
    expect(gateFor(older, input("call"), context).tierA.map((finding) => finding.rule)).toContain("voicemail");
    // M2: the script needs the second call's own words too, or the rep rings twice and says the same thing.
    const noSecond = outputSchemaFor("call").parse(call({ voicemail: "Calling about the calls behind complaints; I will send a note by email." }));
    expect(gateFor(noSecond, input("call"), context).tierA.map((finding) => finding.rule)).toContain("second-call");
    const current = outputSchemaFor("call").parse(
      call({
        voicemail: "Calling about the calls behind complaints; I will send a note by email.",
        openingLine2: "Calling again after the note I sent about complaint calls. Is now a bad time?",
        oneQuestion2: "Who decides which calls get listened to each week?",
      }),
    );
    expect(gateFor(current, input("call"), context).tierA).toEqual([]);
  });

  it("is asked for with both in the sequence", () => {
    const shape = sequenceOutputSchema.shape.call;
    expect(shape.safeParse(call({})).success).toBe(false);
    expect(shape.safeParse(call({ voicemail: "Calling about complaints.", objections: [] })).success).toBe(false);
    // M2: the sequence asks for both calls.
    expect(
      shape.safeParse(
        call({ voicemail: "Calling about complaints.", objections: [], openingLine2: "Calling again after my note about complaint calls.", oneQuestion2: "Who decides which calls get listened to?" }),
      ).success,
    ).toBe(true);
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
    call: call({ voicemail: "Calling about complaints.", objections: [], openingLine2: "Calling again after my note.", oneQuestion2: "Who decides which calls get listened to?" }),
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
    expect(gateFor(dm, input("li_dm"), context).tierA).toEqual([]);
  });

  it("holds an unsourced name and a link on any touch, and gives advice for the tell list, a time ask and a greeting", () => {
    const result = (draft: OutreachOutput, kind: TouchKind) => gateFor(draft, input(kind), context);
    const rules = (draft: OutreachOutput, kind: TouchKind) => result(draft, kind).tierA.map((finding) => finding.rule);
    const advice = (draft: OutreachOutput, kind: TouchKind) => result(draft, kind).tierB.map((finding) => finding.rule);
    const withBody = (body: string) => ({ ...dm, body: `${body} ${ask}` }) as OutreachOutput;
    const reach = withBody("I wanted to reach out after reading about complaint handling in claims teams, since the calls behind a complaint are found late.");
    expect(advice(reach, "li_dm")).toContain("tells");
    expect(rules(reach, "li_dm")).not.toContain("tells");
    const time = { ...dm, body: "Could we find twenty minutes next week?", ask: "Could we find twenty minutes next week?" } as OutreachOutput;
    expect(advice(time, "email2")).toContain("time-ask");
    expect(advice({ ...dm, body: `Hi Helen, one more thought. ${ask}` } as OutreachOutput, "email2")).toContain("envelope");
    expect(rules({ ...dm, body: `A thought after talking to Zenith Claims about this. ${ask}` } as OutreachOutput, "li_dm2")).toContain("unsourced-name");
    expect(rules({ ...dm, body: `More at https://example.com on this. ${ask}` } as OutreachOutput, "breakup")).toContain("link");
  });

  it("refuses the wrong shape for the touch", () => {
    expect(gateFor(dm, input("call"), context).tierA.map((finding) => finding.rule)).toEqual(["kind"]);
  });
});
