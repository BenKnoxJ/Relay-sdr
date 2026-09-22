import { describe, expect, it } from "vitest";

import { outreachInputSchema, type OutreachInput } from "../../agents/outreach/input.schema";
import { checkTouchLimits, messageOutputSchema, outputSchemaFor, outreachOutputSchema, type OutreachOutput } from "../../agents/outreach/output.schema";
import recorded from "../../fixtures/outreach/cohort-2026-09-15.json";
import goodInput from "../../agents/outreach/fixtures/input.good.json";
import goodOutput from "../../agents/outreach/fixtures/output.good.json";
import { objectShapedOutput } from "@/lib/agents/run";
import { loadFacts } from "@/lib/facts/load";
import { liveFacts } from "@/lib/outreach/adapter";
import { gateEmail1, normaliseClaims, type GateContext } from "@/lib/outreach/gates";
import { loadStandard } from "@/lib/outreach/standard";

/**
 * The six first emails the real model wrote on 15 Sep 2026
 * (`fixtures/outreach/cohort-2026-09-15.json`, exported from the cohort
 * database by `scripts/outreach-cohort.ts --export-fixture`), gated again.
 * None passed then. The holds that were the checks' fault are gone; the one
 * that was the draft's fault (Nell's four-sentence paragraph) stays.
 */

type Recorded = (typeof recorded.people)[number];

const facts = liveFacts(loadFacts("insights360", 2).facts);
const context: GateContext = { productNames: [facts.product], repName: "", cohort: [] };

/** The 15 Sep cohort was recorded before the drafter was told who is writing (P5c). */
const RECORDED_SENDER = { firstName: "Ben", company: "Conversant" };

function inputOf(person: Recorded): OutreachInput {
  return outreachInputSchema.parse({ sender: RECORDED_SENDER, ...person.input, pack: recorded.pack, facts, standard: loadStandard() });
}

function person(name: string): { input: OutreachInput; draft: OutreachOutput } {
  const found = recorded.people.find((entry) => entry.name === name);
  if (found === undefined || found.draft === null) throw new Error(`no recorded draft for ${name}`);
  return { input: inputOf(found), draft: outreachOutputSchema.parse(found.draft) };
}

function gate(name: string) {
  const { input, draft } = person(name);
  return gateEmail1(normaliseClaims(draft, input), input, context);
}

const rules = (findings: { rule: string }[]) => findings.map((finding) => finding.rule);

describe("the recorded cohort (15 Sep 2026)", () => {
  it("is the cohort the report describes: five held, one not written", () => {
    expect(recorded.people.map((entry) => [entry.name, entry.state])).toEqual([
      ["Avery Dunmore", "failed"],
      ["Blair Kendrick", "needs_you"],
      ["Emlyn Lomax", "needs_you"],
      ["Marlo Holloway", "needs_you"],
      ["Nell Oakley", "needs_you"],
      ["Orla Bellamy", "needs_you"],
    ]);
  });

  it.each(["Marlo Holloway", "Orla Bellamy"])("%s: the opener's ref listed as a claim no longer holds the draft", (name) => {
    const result = gate(name);
    expect(rules(result.tierA)).not.toContain("claim-id");
    // Messaging v2's tell list holds Marlo's presumptive "…, or is that already sorted?" ask; nothing else holds either draft.
    expect(result.tierA).toEqual(name === "Marlo Holloway" ? [{ rule: "tells", text: expect.stringContaining('"or is that"') }] : []);
  });

  it("Blair Kendrick: one product sentence citing two facts passes (D-1)", () => {
    expect(gate("Blair Kendrick").tierA).toEqual([]);
  });

  it("Emlyn Lomax: a sentence opening on \"Finding\" is advice, not a hold", () => {
    const result = gate("Emlyn Lomax");
    expect(result.tierA).toEqual([]);
    expect(result.tierB.find((finding) => finding.rule === "sentence-start-name")?.text).toContain('"Finding"');
  });

  it("Nell Oakley: \"July's\" is a month, and the four-sentence paragraph still holds", () => {
    const result = gate("Nell Oakley");
    expect(rules(result.tierA)).toEqual(["paragraphs"]);
  });

  it("Avery Dunmore: a first email is offered the message shape only", async () => {
    const schema = outputSchemaFor("email1");
    const json = await Promise.resolve(objectShapedOutput(schema).jsonSchema);
    const properties = json.properties as Record<string, { const?: string; enum?: string[] }>;
    expect(json.type).toBe("object");
    expect(json.anyOf).toBeUndefined();
    expect(properties.talkingPoint).toBeUndefined();
    expect(properties.kind?.const).toBe("message");
    expect(properties.kind?.enum).toBeUndefined();
    expect([...(json.required as string[])].sort()).toEqual(["ask", "body", "claims", "kind", "opener"]);

    const call = { kind: "call", talkingPoint: { openingLine: "Calling about complaints.", oneQuestion: "Is that yours?", listenFor: "ownership", numberSource: "zoho" }, opener: { ref: "role-runs", kind: "role_pain" }, claims: [] };
    expect(schema.safeParse(call).success).toBe(false);
    expect(outputSchemaFor("call").safeParse(call).success).toBe(true);
  });
});

describe("claims before the gates (R2)", () => {
  const base = () => outreachInputSchema.parse(goodInput);
  const good = () => outreachOutputSchema.parse(goodOutput);

  it("moves out the opener's ref and any lookup or plan id, and keeps facts and unknown ids", () => {
    const input = base();
    const pain = input.pack.archetype.pains[0]!.id;
    const draft = { ...good(), claims: [good().opener.ref, pain, "i360.read-every-call", "i360.live-assist"] };
    expect(normaliseClaims(draft, input).claims).toEqual(["i360.read-every-call", "i360.live-assist"]);
    // An id that resolves to nothing is still a finding.
    expect(rules(checkTouchLimits(normaliseClaims(draft, input), input))).toContain("claim-id");
  });

  it("leaves a draft with nothing to move untouched", () => {
    const draft = good();
    expect(normaliseClaims(draft, base())).toBe(draft);
  });

  // Critic, PR #39: the shape is checked before `normaliseClaims` runs, so its
  // cap must leave room for the ids that normalising moves out.
  const facts = ["i360.read-every-call", "i360.search-by-theme"];
  const withFacts = (ids: string[]) => {
    const input = base();
    const extra = ids.filter((id) => !input.facts.facts.some((fact) => fact.id === id)).map((id) => ({ ...input.facts.facts[0]!, id, text: "Reads every call." }));
    return { ...input, facts: { ...input.facts, facts: [...input.facts.facts, ...extra] } };
  };
  const lead = "You told the trade press in June that complaint handling at Westbury Mutual was being rebuilt end to end.";
  const raw = (claims: string[]) => ({ ...goodOutput, body: `${lead} Insights360 reads every call and lets you search them by theme. ${goodOutput.ask}`, claims });

  it("takes a raw list with the opener, a lookup id and pains beside two facts, and passes it once normalised", () => {
    const input = withFacts(facts);
    const claims = [goodOutput.opener.ref, "look-westbury-rebuild", "pain-sampling", "pain-complaints", ...facts];
    const parsed = outputSchemaFor("email1").safeParse(raw(claims));
    expect(parsed.success).toBe(true);
    const draft = normaliseClaims(parsed.data!, input);
    expect(draft.claims).toEqual(facts);
    expect(checkTouchLimits(draft, input)).toEqual([]);
  });

  it("still holds three real product facts under D-1 once normalised", () => {
    const three = [...facts, "i360.period-compare"];
    const input = withFacts(three);
    const parsed = outputSchemaFor("email1").safeParse(raw([goodOutput.opener.ref, ...three]));
    expect(parsed.success).toBe(true);
    const draft = normaliseClaims(parsed.data!, input);
    expect(draft.claims).toEqual(three);
    expect(rules(checkTouchLimits(draft, input))).toContain("one-claim");
  });

  it("still bounds the raw list", () => {
    expect(outputSchemaFor("email1").safeParse(raw(Array.from({ length: 7 }, (_, n) => `i360.fact-${n}`))).success).toBe(false);
  });

  // Critic, PR #39 re-review: the raw cap of 6 is shared by every touch kind,
  // and D-1 is email1's alone, so the other touches keep the three facts the
  // old raw cap gave them, counted after normalising.
  const four = [...facts, "i360.period-compare", "i360.flag-risk"];
  const asTouch = (kind: "email2" | "call", ids: string[]) => {
    const input = withFacts(ids);
    return { ...input, touch: { ...input.touch, kind, ordinal: 2 } };
  };
  const call = (claims: string[]) => ({
    kind: "call",
    talkingPoint: { openingLine: "Calling about complaints at Westbury.", oneQuestion: "Is that yours?", listenFor: "ownership", numberSource: "zoho" },
    opener: goodOutput.opener,
    claims,
  });

  for (const kind of ["email2", "call"] as const) {
    const shaped = (claims: string[]) => (kind === "call" ? call(claims) : raw(claims));

    it(`holds four facts on ${kind} once normalised, and lets three through`, () => {
      const held = outputSchemaFor(kind).safeParse(shaped([goodOutput.opener.ref, ...four]));
      expect(held.success).toBe(true);
      const heldDraft = normaliseClaims(held.data!, asTouch(kind, four));
      expect(heldDraft.claims).toEqual(four);
      expect(rules(checkTouchLimits(heldDraft, asTouch(kind, four)))).toContain("claim-count");

      const three = four.slice(0, 3);
      const passed = outputSchemaFor(kind).safeParse(shaped([goodOutput.opener.ref, ...three]));
      expect(passed.success).toBe(true);
      const passedDraft = normaliseClaims(passed.data!, asTouch(kind, three));
      expect(passedDraft.claims).toEqual(three);
      expect(rules(checkTouchLimits(passedDraft, asTouch(kind, three)))).not.toContain("claim-count");
    });
  }
});

describe("one product sentence in a first email (D-1)", () => {
  const input = () => outreachInputSchema.parse(goodInput);
  const withFacts = (ids: string[]) => {
    const base = input();
    const extra = ids.filter((id) => !base.facts.facts.some((fact) => fact.id === id)).map((id) => ({ ...base.facts.facts[0]!, id, text: "Reads every call." }));
    return { ...base, facts: { ...base.facts, facts: [...base.facts.facts, ...extra] } };
  };
  const draftWith = (body: string, claims: string[]): OutreachOutput => ({ ...messageOutputSchema.parse(goodOutput), body, claims });
  const ask = messageOutputSchema.parse(goodOutput).ask;
  const lead = "You told the trade press in June that complaint handling at Westbury Mutual was being rebuilt end to end.";

  it("allows one product sentence citing two facts", () => {
    const facts = ["i360.read-every-call", "i360.search-by-theme"];
    const body = `${lead} Insights360 reads every call and lets you search them by theme. ${ask}`;
    expect(rules(checkTouchLimits(draftWith(body, facts), withFacts(facts)))).not.toContain("one-claim");
  });

  it("holds three fact ids, or two sentences about the product", () => {
    const three = ["i360.read-every-call", "i360.search-by-theme", "i360.period-compare"];
    const body = `${lead} Insights360 reads every call and lets you search them by theme. ${ask}`;
    expect(rules(checkTouchLimits(draftWith(body, three), withFacts(three)))).toContain("one-claim");
    const two = `${lead} Insights360 reads every call. Insights360 also lets you search by theme. ${ask}`;
    expect(rules(checkTouchLimits(draftWith(two, ["i360.read-every-call"]), withFacts(["i360.read-every-call"])))).toContain("one-claim");
  });
});
