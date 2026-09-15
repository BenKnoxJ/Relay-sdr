import { describe, expect, it } from "vitest";

import { outreachInputSchema, type OutreachInput } from "../../agents/outreach/input.schema";
import { outreachOutputSchema, type MessageDraft } from "../../agents/outreach/output.schema";
import goodInput from "../../agents/outreach/fixtures/input.good.json";
import goodOutput from "../../agents/outreach/fixtures/output.good.json";
import { gateEmail1, namedEntities, sentences, type CohortDraft, type GateContext } from "@/lib/outreach/gates";
import { loadStandard } from "@/lib/outreach/standard";

/**
 * Outreach v2.1 §6: the deterministic gates on a first email. Every seeded
 * fault is rejected with the finding a rep would read; a clean draft passes;
 * the corrections the product owner signed are pinned (cohort repetition is
 * template repetition only, and provenance is not a capitalised-word hunt).
 */

function input(patch: Partial<OutreachInput> = {}): OutreachInput {
  const base = outreachInputSchema.parse(goodInput);
  return { ...base, standard: loadStandard(), ...patch };
}

const draft = (patch: Partial<MessageDraft> = {}): MessageDraft => ({ ...(outreachOutputSchema.parse(goodOutput) as MessageDraft), ...patch });

/** The good body with its first sentences replaced, keeping the ask as the last sentence. */
function body(lead: string, ask = draft().ask): MessageDraft {
  return draft({ body: `${lead} ${ask}`, ask });
}

const context = (cohort: CohortDraft[] = []): GateContext => ({ productNames: ["Insights360"], repName: "Sam Carter", cohort });

const rules = (result: { tierA: { rule: string }[] }) => result.tierA.map((finding) => finding.rule);

describe("a clean first email", () => {
  it("passes every Tier A gate with the real tell list", () => {
    const result = gateEmail1(draft(), input(), context());
    expect(result.tierA).toEqual([]);
  });

  it("counts sentences as a reader does", () => {
    expect(sentences(draft().body)).toHaveLength(4);
  });
});

describe("shape (v2.1 §4 and §6)", () => {
  it("rejects under 40 and over 110 words", () => {
    const short = body("Helen, complaint handling is being rebuilt at Westbury Mutual. We read every recorded call.");
    expect(rules(gateEmail1(short, input(), context()))).toContain("length");
    const long = body(Array.from({ length: 4 }, () => "When quality checking covers one call in fifty the habit behind a complaint is usually found weeks after it started and the team only hears of it once the letter arrives.").join(" "));
    expect(gateEmail1(long, input(), context()).tierA.find((finding) => finding.rule === "length")?.text).toMatch(/limit is 110/);
  });

  it("rejects fewer than 3 or more than 5 sentences", () => {
    const two = body("Helen, you told the trade press in June that complaint handling at Westbury Mutual was being rebuilt end to end and that the calls behind complaints were the part nobody could see yet, because quality checking covers one call in fifty and the habit is found weeks later.");
    expect(rules(gateEmail1(two, input(), context()))).toContain("sentences");
    const six = body("Helen, complaints are being rebuilt. One call in fifty is checked. Habits are found late. We read every recorded call. The pattern shows in a week.");
    expect(rules(gateEmail1(six, input(), context()))).toContain("sentences");
  });

  it("rejects a time ask, a meeting length or a calendar link, however the ask is phrased", () => {
    for (const ask of ["Could we find some time next week?", "Are you free for 15 minutes on Thursday?", "Shall I send an invite?", "Can I book a call with you?"]) {
      const result = gateEmail1(body("Helen, you told the trade press in June that complaint handling at Westbury Mutual was being rebuilt end to end. When quality checking covers one call in fifty, the habit behind a complaint is usually found weeks after it started. We read every recorded call, so the pattern shows up in the first week rather than the next quarter.", ask), input(), context());
      expect(rules(result), ask).toContain("time-ask");
    }
  });

  it("rejects a link, an exclamation mark, the antithesis turn and American spelling", () => {
    const lead = "Helen, you told the trade press in June that complaint handling at Westbury Mutual was being rebuilt end to end.";
    const tail = "We read every recorded call, so the pattern shows up in the first week rather than the next quarter.";
    expect(rules(gateEmail1(body(`${lead} There is more at https://example.com/calls on this. ${tail}`), input(), context()))).toContain("link");
    expect(rules(gateEmail1(body(`${lead} It is a real problem! ${tail}`), input(), context()))).toContain("exclamation");
    expect(rules(gateEmail1(body(`${lead} It isn't a staffing problem, it's a visibility problem. ${tail}`), input(), context()))).toContain("antithesis");
    expect(rules(gateEmail1(body(`${lead} Most teams prioritize the loudest complaint. ${tail}`), input(), context()))).toContain("spelling");
  });

  it("rejects a greeting or sign-off in the body: Relay's envelope adds both (v2.1 §2)", () => {
    const good = draft();
    expect(rules(gateEmail1({ ...good, body: `Hi Helen,\n\n${good.body}` }, input(), context()))).toContain("envelope");
    expect(rules(gateEmail1({ ...good, body: `Helen, ${good.body.charAt(0).toLowerCase()}${good.body.slice(1)}` }, input(), context()))).toContain("envelope");
    expect(rules(gateEmail1(good, input(), context()))).not.toContain("envelope");
  });

  it("rejects the short tell list, as whole words", () => {
    const told = body("Helen, I wanted to reach out because complaint handling at Westbury Mutual is being rebuilt end to end. When quality checking covers one call in fifty, the habit behind a complaint is usually found weeks after it started. We read every recorded call, so the pattern shows up in the first week rather than the next quarter.");
    const result = gateEmail1(told, input(), context());
    expect(result.tierA.find((finding) => finding.rule === "tells")?.text).toContain('"reach out"');
    // "outreach" contains no tell as a whole word.
    expect(rules(gateEmail1(draft(), input(), context()))).not.toContain("tells");
  });
});

describe("provenance: zero invention (v2.1 §6, as corrected)", () => {
  const lead = "Helen, you told the trade press in June that complaint handling at Westbury Mutual was being rebuilt end to end.";
  const tail = "We read every recorded call, so the pattern shows up in the first week rather than the next quarter.";

  it("rejects a seeded invented firm and a seeded invented number", () => {
    const named = gateEmail1(body(`${lead} Aviva found the same thing when it moved its claims desk. ${tail}`), input(), context());
    expect(named.tierA.find((finding) => finding.rule === "unsourced-name")?.text).toContain('"Aviva"');
    const counted = gateEmail1(body(`${lead} Complaints like these rose 38% across the market last year. ${tail}`), input(), context());
    expect(counted.tierA.find((finding) => finding.rule === "unsourced-number")?.text).toContain("38%");
  });

  it("accepts the structured values the input carries: person, company, product, rep and role", () => {
    const withValues = input({ person: { ...input().person, city: "Leeds" } });
    const result = gateEmail1(body(`${lead} Insights360 reads every call for a Claims Operations Director in Leeds, and Sam Carter can show you how. ${tail}`), withValues, context());
    expect(rules(result)).not.toContain("unsourced-name");
  });

  it("accepts a name and a number that resolve to the lookup, the plan or the facts", () => {
    const base = input();
    const cited = input({
      lookup: { ...base.lookup, items: [{ ...base.lookup.items[0]!, quote: "We are rebuilding complaint handling under Consumer Duty, end to end." }] },
    });
    const result = gateEmail1(body(`${lead} Consumer Duty makes that harder to leave for a quarter. An evidence pack per complaint takes under 2 minutes. ${tail}`), cited, context());
    expect(rules(result)).not.toContain("unsourced-name");
    expect(rules(result)).not.toContain("unsourced-number");
  });

  it("is not a capitalised-word detector: a sentence's first word and a month are not names", () => {
    expect(namedEntities("Most claims teams read one call in fifty. Complaints rose in June.")).toEqual(["June"]);
    expect(namedEntities("We spoke to the FCA about Consumer Duty.")).toEqual(["FCA", "Consumer Duty"]);
    // An ordinary word opening a sentence passes; a firm opening one does not.
    const opens = gateEmail1(body(`${lead} Complaints rarely say which call caused them. Honestly, that is the hard part. ${tail}`), input(), context());
    expect(rules(opens)).not.toContain("unsourced-name");
  });

  it("refuses a person or firm opener when the lookup is not usable", () => {
    const base = input();
    const unusable = input({ lookup: { ...base.lookup, usable: false } });
    expect(rules(gateEmail1(draft(), unusable, context()))).toContain("opener-usable");
    // The same email on the role problem is the ordinary, good case.
    const onRole = draft({ opener: { ref: "role-runs", kind: "role_pain" } });
    expect(rules(gateEmail1(onRole, unusable, context()))).not.toContain("opener-usable");
    expect(rules(gateEmail1(onRole, unusable, context()))).not.toContain("opener-ref");
  });
});

describe("cohort: template repetition only (v2.1 §6, as corrected)", () => {
  const other = (text: string, ask: string, sameAccount = false): CohortDraft => ({ body: `${text} ${ask}`, ask, sameAccount });
  const opening = "Helen, you told the trade press in June that complaint handling at Westbury Mutual was being rebuilt end to end.";

  it("treats generic word overlap as advice, never a failure", () => {
    // Two of this draft's sentences again, at another account, once: similar, and not a template.
    const similar = other(
      "Tom, quality checking at Ardent covers one call in fifty. When quality checking covers one call in fifty, the habit behind a complaint is usually found weeks after it started. We read every recorded call, so the pattern shows up in the first week rather than the next quarter.",
      "Is that something you are looking at?",
    );
    const result = gateEmail1(draft(), input(), context([similar]));
    expect(rules(result).filter((rule) => rule.startsWith("cohort"))).toEqual([]);
    expect(result.tierB.map((finding) => finding.rule)).toContain("cohort-overlap");
  });

  it("fails a near-identical opening frame used in two other drafts, or once at the same account", () => {
    const once = other(opening, "Is that on your list this year?");
    expect(rules(gateEmail1(draft(), input(), context([once])))).not.toContain("cohort-opening");
    expect(rules(gateEmail1(draft(), input(), context([once, other(opening, "Would a short note help?")])))).toContain("cohort-opening");
    expect(rules(gateEmail1(draft(), input(), context([other(opening, "Is that on your list this year?", true)])))).toContain("cohort-opening");
  });

  it("fails the same normalised ask used more than twice in the campaign, and stricter at the same account", () => {
    const ask = draft().ask;
    const a = other("Priya, the night desk at Bramble takes the overflow.", ask);
    const b = other("Marlo, Cobalt's handlers mark their own calls.", ask.toLowerCase());
    expect(rules(gateEmail1(draft(), input(), context([a])))).not.toContain("cohort-ask");
    expect(rules(gateEmail1(draft(), input(), context([a, b])))).toContain("cohort-ask");
    expect(rules(gateEmail1(draft(), input(), context([{ ...a, sameAccount: true }])))).toContain("cohort-ask");
  });

  it("fails a distinctive sentence repeated almost word for word", () => {
    const sentence = "When quality checking covers one call in fifty, the habit behind a complaint is usually found weeks after it started.";
    const a = other(`Priya, the night desk at Bramble takes the overflow. ${sentence}`, "Is that on your list?");
    const b = other(`Marlo, handlers at Cobalt mark their own calls. ${sentence}`, "Would that help?");
    expect(rules(gateEmail1(draft(), input(), context([a])))).not.toContain("cohort-sentence");
    expect(rules(gateEmail1(draft(), input(), context([a, b])))).toContain("cohort-sentence");
  });
});

describe("advice on the card (Tier B)", () => {
  it("advises on the subject and on hedging, and never blocks", () => {
    const hedged = body("Helen, perhaps complaint handling at Westbury Mutual might be changing, and maybe the calls behind complaints are probably unread. When quality checking covers one call in fifty, the habit behind a complaint is usually found weeks after it started. We read every recorded call, so the pattern shows up in the first week rather than the next quarter.");
    const result = gateEmail1({ ...hedged, subject: "A long subject line that goes on well past what a phone shows" }, input(), context());
    expect(result.tierB.map((finding) => finding.rule)).toEqual(expect.arrayContaining(["subject", "hedges"]));
  });
});

describe("the rep's edit, classed without a model (§10)", () => {
  it("classes a product name's digits as a name, and a changed number as factual", async () => {
    const { editClassOf } = await import("@/lib/repo/outreach");
    const before = "Most teams only find those calls once the complaint arrives. We read every recorded call. Is that a theme you are chasing?";
    expect(editClassOf(before, "Most teams only find those calls once the complaint arrives. Is that a theme you are chasing?")).toBe("trim");
    expect(editClassOf(before, "Most teams only find those calls late. Insights360 reads every recorded call. Is that a theme you are chasing?")).not.toBe("factual");
    expect(editClassOf(before, "Most teams only find 12 of those calls. We read every recorded call. Is that a theme you are chasing?")).toBe("factual");
  });
});
