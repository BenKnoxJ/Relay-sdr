import { describe, expect, it } from "vitest";

import { SEQUENCE, outreachInputSchema, packSliceSchema, type EvidenceQuote, type OutreachInput, type TouchKind } from "../../agents/outreach/input.schema";
import type { OutreachOutput } from "../../agents/outreach/output.schema";
import recorded from "../../fixtures/outreach/cohort-2026-09-15.json";
import { loadFacts } from "@/lib/facts/load";
import { fitsLine, lineFitOf, liveFacts, withApprovedGives, withUsage } from "@/lib/outreach/adapter";
import { figuresMisquoted, gateFor, unsupportedSourceClaims, type CohortDraft, type GateContext } from "@/lib/outreach/gates";
import { linesOf, lookupEvidence, pageDate, type LookupSubject } from "@/lib/outreach/lookup";
import { loadStandard } from "@/lib/outreach/standard";
import type { FetchService, PageRead, SearchHit, SearchService } from "@/lib/services";

/**
 * Trial fix 1 (25 Sep 2026): the live trial's seven sequences, and what held and what should have.
 *
 * Every draft sentence here is one the trial wrote, with the people and firms swapped for made-up ones: the
 * trial wrote to real people, and their names and firms stay out of the repository. Harbour Motor is a motor
 * insurer; Kestrel Home & Motor sells both; Brackenfield Legal sells legal expenses cover; Wayfarer Cover sells
 * travel insurance.
 */

const standard = loadStandard();
const facts = liveFacts(loadFacts("insights360", 2).facts);
const gives: EvidenceQuote[] = standard.gives;
const fos = gives.find((give) => give.id === "give-fos-motor-complaints-q1-2026")!;
const fca40 = gives.find((give) => give.id === "give-fca-interventions-not-measured")!;
const SENDER = { firstName: "Alex", company: "Conversant" };
const base = recorded.people[0]!.input;
/** A real opener ref: the plan's first pain. */
const ROLE_REF = packSliceSchema.parse(recorded.pack).archetype.pains[0]!.id;

type Who = { name: string; company: string; domain: string };
const HARBOUR: Who = { name: "Sam Ferris", company: "Harbour Motor", domain: "harbourmotor.example" };
const KESTREL_A: Who = { name: "Dana Whitlock", company: "Kestrel Home & Motor", domain: "kestrel.example" };
const KESTREL_B: Who = { name: "Owen Pryce", company: "Kestrel Home & Motor", domain: "kestrel.example" };

function inputFor(who: Who, kind: TouchKind, thread: OutreachInput["thread"] = []): OutreachInput {
  const firstName = who.name.split(" ")[0]!;
  return outreachInputSchema.parse({
    ...base,
    person: { ...base.person, name: who.name, firstName, company: who.company, domain: who.domain, email: `${firstName.toLowerCase()}@${who.domain}` },
    account: { company: who.company, domain: who.domain },
    sender: SENDER,
    pack: withApprovedGives(packSliceSchema.parse(recorded.pack), standard, new Date("2026-09-25T09:00:00Z")),
    facts,
    standard,
    touch: { kind, ordinal: SEQUENCE.indexOf(kind) + 1, dueAt: "2026-09-25T09:00:00Z" },
    thread,
  });
}

const context = (cohort: CohortDraft[] = []): GateContext => ({ productNames: [facts.product], repName: "Alex", cohort });
const message = (body: string, ask: string, subject?: string): OutreachOutput => ({
  kind: "message",
  ...(subject === undefined ? {} : { subject }),
  body,
  ask,
  opener: { ref: ROLE_REF, kind: "role_pain" },
  claims: [],
});
const rules = (result: { tierA: { rule: string }[] }) => result.tierA.map((finding) => finding.rule);
const held = (sentence: string, evidence: readonly EvidenceQuote[] = gives) => unsupportedSourceClaims([sentence], evidence, [HARBOUR.company, HARBOUR.name], ["Insights360"]);

// ---------------------------------------------------------------------------
// The clean first person: their Email 1 and last email still pass, and their call script is no longer held.

describe("a clean sequence from the trial still passes", () => {
  const emailBody =
    "The cause recorded against a complaint is usually just a label, filled in on the return without saying much about what actually happened on the call. The real pattern sits in the conversations themselves, but most complaints teams only see the calls that already turned into a complaint.\n\nSo the evidence often comes from a handful of calls someone happened to pull.\n\nHow do you build that evidence today?";
  const email1 = message(emailBody, "How do you build that evidence today?", "what a cause label misses");

  it("passes the Email 1 with no Tier A finding", () => {
    expect(gateFor(email1, inputFor(HARBOUR, "email1"), context()).tierA).toEqual([]);
  });

  it("passes the last email with no Tier A finding", () => {
    const thread = [{ kind: "email1" as const, ordinal: 1, subject: "what a cause label misses", body: emailBody, fate: "drafted" as const }, { kind: "email2" as const, ordinal: 2, body: "A cause on the return says what category to file under. It does not say whether the fix worked, because the calls behind it are rarely checked as a whole. Once a fix goes in, who ends up checking it changed anything?", fate: "drafted" as const }];
    const breakup = message("I'll leave this here. If pulling together the evidence behind a complaint cause sits with someone else at Harbour Motor, who would be the right person for me to ask?", "If pulling together the evidence behind a complaint cause sits with someone else at Harbour Motor, who would be the right person for me to ask?");
    expect(gateFor(breakup, inputFor(HARBOUR, "breakup", thread), context()).tierA).toEqual([]);
  });

  it("no longer holds the call script for antithesis: the objection and its answer are two parts, not one turn", () => {
    const call: OutreachOutput = {
      kind: "call",
      talkingPoint: {
        openingLine: "Hi Sam, it's Alex from Conversant. I emailed about the evidence behind your complaint causes. Is now an alright time?",
        oneQuestion: "When you have to show that a complaint fix worked, what do you point to as the evidence?",
        openingLine2: "Alex again, from Conversant. I followed up by email and connected on LinkedIn about how you evidence a fix working. Have you got a minute?",
        oneQuestion2: "Once that evidence is pulled together, who else ends up relying on it?",
        listenFor: "Whether Sam can point to more than a category label or a couple of calls when a fix needs proving, and whether that evidence gathering sits with Sam alone or is shared across the team.",
        voicemail: "Hi Sam, it's Alex from Conversant. I sent a note about how complaint causes get evidenced. No need to call back urgently, I'll follow up by email. Thanks.",
        objections: [
          { objection: "We already do QA sampling on complaint calls.", answer: "That's common. We score every call against your own QA rules, so you get a complete picture across the whole set of calls." },
          { objection: "This isn't something I own directly.", answer: "That's fine. If there's someone better placed to speak to this, happy to be pointed their way." },
        ],
        numberSource: "find_a_number",
      },
      opener: { ref: ROLE_REF, kind: "role_pain" },
      claims: [],
    } as OutreachOutput;
    expect(rules(gateFor(call, inputFor(HARBOUR, "call"), context()))).not.toContain("antithesis");
  });

  it("still holds a real antithesis inside one part", () => {
    const body = "The cause on a complaint is usually a label. It isn't the evidence. It's the category someone picked. Who checks it?";
    expect(rules(gateFor(message(body, "Who checks it?"), inputFor(HARBOUR, "li_dm2"), context()))).toContain("antithesis");
  });
});

// ---------------------------------------------------------------------------
// Item 2: colleagues never get the same evidence item, whatever the sentence around it.

describe("colleague-evidence: the same quote to two people at one firm", () => {
  const first = "Twice a year your complaint numbers go out under your name, and by then there is little left to do but explain them. The FCA's review of 40 firms found that firms did not always measure the impact of interventions they had made to ensure these were the right changes to make. How are you settling on what sits behind the numbers this time?";
  // The second colleague's draft joined both of the quote's sentences into one, which slipped under the 0.8 sentence score.
  const joined =
    "The FCA's review of 40 firms found that firms did not always measure the impact of interventions they had made to ensure these were the right changes to make, and that sometimes firms pursued actions even though they were not as effective as they might need to be.\n\nMost complaints information logs a cause and rarely shows whether the fix worked.\n\nHow does that evidence get put together for the board today?";
  const draft = message(joined, "How does that evidence get put together for the board today?", "evidence for the board");

  it("holds the second colleague's Email 1", () => {
    const colleague: CohortDraft = { body: first, ask: "How are you settling on what sits behind the numbers this time?", sameAccount: true, personId: "dana", touch: "email1" };
    expect(rules(gateFor(draft, inputFor(KESTREL_B, "email1"), context([colleague])))).toContain("colleague-evidence");
  });

  it("holds it on a later touch too: the colleague's LinkedIn message carried it", () => {
    const colleague: CohortDraft = { body: first, ask: "x?", sameAccount: true, personId: "dana", touch: "li_dm" };
    const later = message(`${fca40.quote.split(". ")[0]!.replace("Firms", "The FCA's review of 40 firms found that firms")}. Who owns proving a fix worked?`, "Who owns proving a fix worked?");
    expect(rules(gateFor(later, inputFor(KESTREL_B, "email2", [{ kind: "email1", ordinal: 1, body: "An earlier email about complaint causes. Where does that evidence come from?", fate: "drafted" }]), context([colleague])))).toContain("colleague-evidence");
  });

  it("does not hold the same quote to someone at another firm", () => {
    const stranger: CohortDraft = { body: first, ask: "x?", sameAccount: false, personId: "dana", touch: "email1" };
    expect(rules(gateFor(draft, inputFor(KESTREL_B, "email1"), context([stranger])))).not.toContain("colleague-evidence");
  });
});

// ---------------------------------------------------------------------------
// Item 3: 22 October is the FCA's publication, not a return; no touch counts the weeks to it.

describe("return-date and relative-date", () => {
  const RETURN = [
    ["an Email 1", "With the next return dated 22 October, how are you settling on what sits behind the numbers this time?"],
    ["a second email", "The next complaints return is due on 22 October, and once it lands this year's numbers are largely fixed."],
    ["a call objection", "We're not making any changes before the October return."],
    ["a subject", "the october complaints return"],
    // Fix round 2: Critic's rewordings, one step from the trial's probe.
    ["an Email 1, with on", "Ahead of the H1 return on 22 October, how are you settling what sits behind the numbers?"],
    ["a second email, with a month", "Your next complaints return is due in October."],
    ["an opener, with in", "Ahead of your half-year return in October, the explanation matters as much as the number."],
    ["a possessive", "October's return will show the same pattern."],
  ] as const;
  it.each(RETURN)("holds a return dated with the publication day in %s", (_where, sentence) => {
    const body = `The cause on a complaint is usually a label. ${sentence} Who puts the explanation together?`;
    expect(rules(gateFor(message(body, "Who puts the explanation together?"), inputFor(HARBOUR, "li_dm2"), context()))).toContain("return-date");
  });

  const COUNTED = [
    "The next publication is dated 22 October, which leaves six weeks where the numbers can be explained but not changed.",
    "Six weeks out from 22 October, the numbers are more or less locked in.",
    "The numbers publish on 22 October, and for the six weeks before that the number is fixed, so all that's left is explaining it.",
    "With publication a month out, the figures are set.",
    // Fix round 2: Critic's rewordings.
    "Under four weeks until the FCA publishes.",
    "In 27 days the figures go public.",
    "That leaves you a month ahead of the October publication.",
  ];
  it.each(COUNTED)("holds a count of time to a date: %s", (sentence) => {
    const body = `${sentence} Who puts the explanation together on your side?`;
    expect(rules(gateFor(message(body, "Who puts the explanation together on your side?"), inputFor(HARBOUR, "li_dm2"), context()))).toContain("relative-date");
  });

  it("does not hold a rule's own period, or the verb return", () => {
    for (const sentence of ["A firm has eight weeks to send a final response.", "The FCA publishes its complaints data every 6 months, around April and October.", "I'll return to this in October if it helps."]) {
      const found = rules(gateFor(message(`${sentence} Who owns that on your side?`, "Who owns that on your side?"), inputFor(HARBOUR, "li_dm2"), context()));
      expect(found, sentence).not.toContain("relative-date");
      expect(found, sentence).not.toContain("return-date");
    }
  });

  it("does not hold ordinary sentences with a month, a return, or a story's duration in them", () => {
    for (const sentence of [
      "I may return next week.",
      "Your tax return is due in January.",
      "The return on investment shows by May.",
      "Customers who return in March often call twice.",
      "Happy to talk in May about returns.",
      "We spent a week before launch testing it.",
      "It took two weeks before the team saw results.",
      "Just days before Christmas the volume doubled.",
      "It went three months to go live.",
      // Fix round 2: the verb return with a date elsewhere in the sentence, and "to go through".
      "Happy to pick this up on 3 November when I return.",
      "The figures come out on 22 October, a few weeks after firms return their data.",
      "We had two days to go through it.",
    ]) {
      const found = rules(gateFor(message(`${sentence} Who owns that on your side?`, "Who owns that on your side?"), inputFor(HARBOUR, "li_dm2"), context()));
      expect(found, sentence).not.toContain("relative-date");
      expect(found, sentence).not.toContain("return-date");
    }
  });

  it("passes the approved wording: the FCA's own schedule sentence, and the date as the FCA's publication", () => {
    const sentence = "The FCA publishes its complaints data every 6 months, around April and October, and the H1 figures by firm on 22 October.";
    expect(held(sentence)).toEqual([]);
    const found = gateFor(message(`${sentence} Who puts the explanation together on your side?`, "Who puts the explanation together on your side?"), inputFor(HARBOUR, "li_dm2"), context());
    expect(found.tierA).toEqual([]);
  });

  it("says 22 October is the FCA's publication in the give's scope, never the firm's return", () => {
    const dates = gives.find((give) => give.id === "give-fca-complaints-data-dates")!;
    expect(dates.sourceName).toContain("22 October 2026");
    expect(dates.scope).toMatch(/publishes the H1 2026 figures by firm/);
    expect(dates.scope).toMatch(/Never call 22 October a return/);
    // Fix round 2 (Benny-san, 25 Sep): a date anchor only, never news to the firm.
    expect(dates.scope).toMatch(/use only as a date; never tell the firm about its own reporting cycle/i);
  });

  it("stops reaching the drafter after 22 October 2026, and the other gives stay (fix round 2)", () => {
    const slice = { ...packSliceSchema.parse(recorded.pack), evidence: [] };
    const ids = (now: string) => withApprovedGives(slice, standard, new Date(now)).evidence.map((quote) => quote.id);
    expect(ids("2026-09-25T09:00:00Z")).toContain("give-fca-complaints-data-dates");
    expect(ids("2026-10-22T23:59:59Z")).toContain("give-fca-complaints-data-dates");
    expect(ids("2026-10-23T00:00:00Z")).not.toContain("give-fca-complaints-data-dates");
    expect(ids("2026-10-23T00:00:00Z")).toEqual(expect.arrayContaining(["give-fos-motor-complaints-q1-2026", "give-fca-interventions-not-measured"]));
    // The expiry is the standard's to read, never the drafter's: it is not on the quote the drafter sees.
    const before = withApprovedGives(slice, standard, new Date("2026-09-25T09:00:00Z")).evidence.find((quote) => quote.id === "give-fca-complaints-data-dates")!;
    expect(before).not.toHaveProperty("validUntil");
  });
});

// ---------------------------------------------------------------------------
// Item 4: a figure about one product line goes only to firms in that line.

describe("the product line of a give", () => {
  it("tags the ombudsman's car and motorcycle figure as motor, and nothing else", () => {
    expect(gives.filter((give) => give.line !== undefined).map((give) => [give.id, give.line])).toEqual([["give-fos-motor-complaints-q1-2026", "motor"]]);
  });

  it("reads a firm's lines from what the lookup read, by keyword", () => {
    expect(linesOf("Wayfarer Cover: travel insurance for the over-50s. Our travel insurance covers cruises and car hire excess.", "Wayfarer Cover")).toEqual(["travel"]);
    expect(linesOf("Legal expenses insurance and after the event insurance for law firms. Our legal expenses cover…", "Brackenfield Legal")).toEqual(["legal-expenses"]);
    // A multi-line broker sells motor among others: one mention of a line is not enough, two are.
    expect(linesOf("Car insurance, van insurance, home insurance, travel insurance and pet insurance from one broker. Motor claims line…", "Thornbury Brokers")).toEqual(["motor"]);
    expect(linesOf("Complaints handling policy. How to complain.", "Wayfarer Cover")).toEqual([]);
    // A word in the firm's name tips a line the page also mentions, and never decides one alone.
    expect(linesOf("Legal expenses cover for landlords.", "Brackenfield Legal")).toEqual(["legal-expenses"]);
    expect(linesOf("", "Legal & General")).toEqual([]);
    // Fix round 2: motor legal protection is the legal-expenses product, not motor cover.
    expect(linesOf("Motor legal protection covers you after an accident. Our motor legal expenses policy pays solicitor costs.", "Brackenfield Legal")).toEqual(["legal-expenses"]);
    expect(linesOf("Motor trade cover and motor finance protection for dealers.", "Brackenfield Legal")).toEqual([]);
  });

  it("gives the motor figure to a motor firm, and not to a travel or a legal-expenses firm", () => {
    const campaign = { targeting: { industries: ["General insurance"] } } as Parameters<typeof lineFitOf>[1];
    expect(fitsLine(fos, lineFitOf({ lines: ["motor", "home"] }, campaign))).toBe(true);
    expect(fitsLine(fos, lineFitOf({ lines: ["travel"] }, campaign))).toBe(false);
    expect(fitsLine(fos, lineFitOf({ lines: ["legal-expenses"] }, campaign))).toBe(false);
    // A give about complaints in general goes to everyone.
    expect(fitsLine(fca40, lineFitOf({ lines: ["travel"] }, campaign))).toBe(true);
  });

  it("falls back to the campaign's industry when nothing says what the firm sells", () => {
    const motor = { targeting: { industries: ["Motor insurance underwriting and claims"] } } as Parameters<typeof lineFitOf>[1];
    const general = { targeting: { industries: ["General insurance", "Insurance"] } } as Parameters<typeof lineFitOf>[1];
    expect(fitsLine(fos, lineFitOf({}, motor))).toBe(true);
    expect(fitsLine(fos, lineFitOf({}, general))).toBe(false);
  });

  it("keeps the motor figure out of a travel firm's evidence list", () => {
    const slice = { ...packSliceSchema.parse(recorded.pack), evidence: [] };
    const campaign = { targeting: { industries: ["Motor insurance"] } } as Parameters<typeof lineFitOf>[1];
    expect(withApprovedGives(slice, standard, new Date("2026-09-25T09:00:00Z"), lineFitOf({ lines: ["travel"] }, campaign)).evidence.map((quote) => quote.id)).not.toContain(fos.id);
    expect(withApprovedGives(slice, standard, new Date("2026-09-25T09:00:00Z"), lineFitOf({ lines: ["motor"] }, campaign)).evidence.map((quote) => quote.id)).toContain(fos.id);
  });
});

// ---------------------------------------------------------------------------
// Item 5: the unsupported claims that got through.

describe("unsupported claims the trial let through", () => {
  it("holds an unsourced trend, whoever it is about", () => {
    for (const sentence of [
      "More motor complaints are drifting past three days and into the run-up to an eight-week final response, leaving less time to see what happened on the calls involved.",
      "Motor is the line pulling in the most complaints right now, and the volume keeps rising.",
      "Harbour Motor's complaints keep rising.",
      "Complaint volumes are rising across the sector.",
    ]) {
      expect(held(sentence), sentence).toEqual([sentence]);
    }
  });

  it("holds a reworded trend in something measured", () => {
    for (const sentence of [
      "Motor complaints have risen sharply this year.",
      "Complaint volumes are up this year.",
      "Complaints are drifting past three days.",
      "Complaint numbers have been climbing.",
      "More and more complaints go past eight weeks.",
    ]) {
      expect(held(sentence), sentence).toEqual([sentence]);
    }
  });

  it("holds a trend in the simple past, or more of something ending up somewhere (fix round 2)", () => {
    for (const sentence of [
      "Complaints rose sharply last year.",
      "Uphold rates went up in H1.",
      "Volumes have doubled.",
      "Complaint volumes spiked after the storm.",
      "More motor complaints are ending up at the ombudsman.",
    ]) {
      expect(held(sentence), sentence).toEqual([sentence]);
    }
  });

  it("does not read a growing team or a separate send as a source claim", () => {
    for (const sentence of [
      "More and more claims teams are moving to cloud contact centres.",
      "Complaints handling has grown into a team of twelve.",
      "Your team is growing fast.",
      "Headcount at Harbour Motor is growing.",
      "Interest in call QA is on the rise.",
      "We score calls and publish results to each team lead separately.",
    ]) {
      expect(held(sentence), sentence).toEqual([]);
    }
  });

  it("lets a quote's leading year go unquoted: a year dates a figure, it is not compared with it", () => {
    const quote: EvidenceQuote = { id: "q", quote: "In 2025 we received 4,100 complaints about motor insurance, up from 4,000 the year before.", sourceName: "the ombudsman", url: "https://ombudsman.example/q" };
    expect(figuresMisquoted("The ombudsman says we received 4,100 complaints about motor insurance, up from 4,000 the year before.", quote)).toBe(false);
  });

  it("lets a trend through when the approved quote in the sentence carries it", () => {
    const sentence = "The ombudsman's quarterly figures for April to June 2026 show car and motorcycle insurance complaints rose to 4,100, up from 2,800 in the same period in 2025, so the volume is rising.";
    expect(held(sentence)).toEqual([]);
  });

  it("holds \"a different number from\" with no body named (the M2 probe, unnamed)", () => {
    const sentence = "That's a different number from what gets recorded once a case is escalated outside the firm.";
    expect(held(sentence)).toEqual([sentence]);
  });

  it("holds \"publishes … separately\" riding on a quote from another body", () => {
    const upheld: EvidenceQuote = {
      id: "upheld",
      quote: "'Percentage upheld' by the firm means complaints found in the customer's favour.",
      sourceName: "a firm's own FCA complaints disclosure",
      url: "https://insurer.example/complaints",
    };
    const sentence = "A firm's own FCA complaints disclosure spells it out: 'percentage upheld' by the firm means complaints found in the customer's favour, and the ombudsman publishes its own uphold figure separately.";
    expect(held(sentence, [...gives, upheld])).toEqual([sentence]);
  });

  it("holds a figure taken out of its quote: the 4,000 without the 4,100 it is compared with", () => {
    const sentence = "The ombudsman's quarterly figures for April to June 2026 show numbers up on the 4,000 from January to March 2026, with consumers raising concerns about claim values, policy cancellations and claim delays.";
    expect(figuresMisquoted(sentence, fos)).toBe(true);
    expect(held(sentence)).toEqual([sentence]);
  });

  it("holds a figure given the wrong words: the 2,800 as the rise", () => {
    const sentence = "The ombudsman's quarterly figures for April to June 2026 show car and motorcycle insurance complaints rose to 2,800.";
    expect(held(sentence)).toEqual([sentence]);
  });

  it("passes the quote's figures in its own words and order, whole or first figure only", () => {
    for (const sentence of [
      "The ombudsman's quarterly figures for April to June 2026 show car and motorcycle insurance complaints rose to 4,100, up from 2,800 in the same period in 2025.",
      "The ombudsman's quarterly figures for April to June 2026 show car and motorcycle insurance complaints rose to 4,100.",
      `The ombudsman's quarterly figures for April to June 2026 show ${fos.quote.charAt(0).toLowerCase()}${fos.quote.slice(1)}`,
    ]) {
      expect(held(sentence), sentence).toEqual([]);
    }
  });

  it("drops the one firm's \"percentage upheld\" give and its boilerplate", () => {
    expect(gives.map((give) => give.id)).not.toContain("give-fca-upheld-means-by-the-firm");
    expect(gives.some((give) => /just so you know/i.test(give.quote))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Item 6: the give rotates across the campaign.

describe("the give across the campaign", () => {
  const withFca = (person: string, touch = "email1"): CohortDraft => ({
    body: `The cause on a complaint is a label. The FCA's review of 40 firms found that firms did not always measure the impact of interventions they had made. Who checks it for ${person}?`,
    ask: `Who checks it for ${person}?`,
    sameAccount: false,
    personId: person,
    touch,
  });
  const draft = message(
    "The cause recorded for a complaint rarely says what happened on the call.\n\nThe FCA's review of 40 firms found that firms did not always measure the impact of interventions they had made to ensure these were the right changes to make.\n\nWhere does that evidence come from today?",
    "Where does that evidence come from today?",
    "what the cause leaves out",
  );

  it("tells the drafter how many other people each quote has gone to", () => {
    const approved = withApprovedGives({ ...packSliceSchema.parse(recorded.pack), evidence: [] }, standard, new Date("2026-09-25T09:00:00Z"));
    const slice = withUsage(approved, new Map([[fca40.id, 5]]));
    expect(slice.evidence.find((quote) => quote.id === fca40.id)?.usedBy).toBe(5);
    expect(slice.evidence.find((quote) => quote.id === fos.id)?.usedBy).toBe(0);
    expect(outreachInputSchema.safeParse({ ...inputFor(HARBOUR, "email1"), pack: slice }).success).toBe(true);
  });

  it("advises, and never holds, when more than half the campaign's first emails carry the same quote", () => {
    const result = gateFor(draft, inputFor(HARBOUR, "email1"), context([withFca("a"), withFca("b"), withFca("c", "email2"), { ...withFca("d"), body: "Nothing quoted here. Who owns it?" }]));
    expect(result.tierB.map((finding) => finding.rule)).toContain("cohort-give");
    expect(rules(result)).not.toContain("cohort-give");
  });

  it("stays quiet when the quote is in only a few of them", () => {
    const quiet = { ...withFca("x"), body: "Nothing quoted here. Who owns it?" };
    const result = gateFor(draft, inputFor(HARBOUR, "email1"), context([withFca("a"), { ...quiet, personId: "b" }, { ...quiet, personId: "c" }, { ...quiet, personId: "d" }]));
    expect(result.tierB.map((finding) => finding.rule)).not.toContain("cohort-give");
  });

  it("advises when most last emails in the campaign end on the same question shape", () => {
    const ask = "If this sits with someone else, who would be the right person for me to ask?";
    const other = (personId: string): CohortDraft => ({ body: `I'll leave it there. ${ask}`, ask, sameAccount: false, personId, touch: "breakup" });
    const thread = [{ kind: "email1" as const, ordinal: 1, body: "A longer first email about complaint causes and the calls behind them. Where does that come from?", fate: "drafted" as const }];
    const breakup = message(`I'll stop writing about this. ${ask}`, ask);
    const advised = gateFor(breakup, inputFor(HARBOUR, "breakup", thread), context([other("a"), other("b"), other("c")]));
    expect(advised.tierB.map((finding) => finding.rule)).toContain("cohort-breakup-shape");
    const varied = gateFor(breakup, inputFor(HARBOUR, "breakup", thread), context([other("a"), { ...other("b"), ask: "Shall I leave it for now?" }, { ...other("c"), ask: "Would a copy of the write-up ever help?" }]));
    expect(varied.tierB.map((finding) => finding.rule)).not.toContain("cohort-breakup-shape");
  });
});

// ---------------------------------------------------------------------------
// Item 1: the lookup reads undated hits.

describe("the lookup, with undated search hits", () => {
  const NOW = new Date("2026-09-25T09:00:00Z");
  const subject: LookupSubject = {
    personName: "Sam Ferris",
    company: "Harbour Motor",
    domain: "harbourmotor.example",
    region: "GB",
    relevance: ["Complaint causes are recorded as a category and nobody can say which conversations caused them.", "Proving a complaint fix worked."],
    triggers: ["complaints rising"],
  };
  const PERSON = '"Sam Ferris" "Harbour Motor"';
  const FIRM = '"Harbour Motor" complaints rising';
  const undated = (url: string, title = "Harbour Motor complaints"): SearchHit => ({ title, url, snippet: "Harbour Motor complaints policy" });

  function services(searches: Record<string, SearchHit[]>, pages: Record<string, string>) {
    const fetched: string[] = [];
    const read = (url: string): PageRead => (pages[url] === undefined ? { unreadable: true, reason: "not scripted" } : { markdown: pages[url]! });
    const search: SearchService = { search: async (input) => ({ hits: searches[input.query] ?? [] }), extract: async (url) => (fetched.push(`extract:${url}`), read(url)) };
    const fetch: FetchService = { scrape: async (url) => (fetched.push(url), read(url)) };
    return { deps: { search, fetch, now: () => NOW }, fetched };
  }
  const POLICY = "# Complaints policy\n\nHarbour Motor records the cause of every complaint by category and reviews the conversations behind complaint causes each month.\n\nWe sell car insurance and van insurance. Motor claims are handled in house.";

  it("uses an undated page on the firm's own site, as a weak item, and reads the firm's line off it", async () => {
    const { deps, fetched } = services({ [FIRM]: [undated("https://harbourmotor.example/complaints-policy")] }, { "https://harbourmotor.example/complaints-policy": POLICY });
    const result = await lookupEvidence(subject, deps);
    expect(result).toMatchObject({ usable: true, searches: 2, fetches: 1, lines: ["motor"] });
    expect(result.items[0]).toMatchObject({ about: "firm", confidence: "weak", evidence: { primary: true } });
    expect(result.items[0]!.publishedAt).toBeUndefined();
    expect(fetched).toEqual(["https://harbourmotor.example/complaints-policy"]);
  });

  it("dates an undated hit from its page, and drops it when the page is stale", async () => {
    const stale = `Published 3 March 2024\n\n${POLICY}`;
    const { deps } = services({ [FIRM]: [undated("https://harbourmotor.example/news/causes")] }, { "https://harbourmotor.example/news/causes": stale });
    const result = await lookupEvidence(subject, deps);
    expect(result.usable).toBe(false);
    expect(result.trail.map((step) => step.outcome)).toContain("stale (the page is dated 2024-03-03)");
  });

  it("takes a fresh date from the page, and the item is strong on the firm's own site", async () => {
    const fresh = `Last updated: 12 June 2026\n\n${POLICY}`;
    const { deps } = services({ [FIRM]: [undated("https://harbourmotor.example/news/causes")] }, { "https://harbourmotor.example/news/causes": fresh });
    const result = await lookupEvidence(subject, deps);
    expect(result.items[0]).toMatchObject({ publishedAt: "2026-06-12", confidence: "strong" });
  });

  it("never takes an off-site page's own date: only the search's date counts off the firm's site (fix round 2)", async () => {
    const fresh = `Last updated: 12 June 2026\n\n${POLICY}`;
    const { deps } = services({ [FIRM]: [undated("https://news.example/harbour")] }, { "https://news.example/harbour": fresh });
    const result = await lookupEvidence(subject, deps);
    expect(result.usable).toBe(false);
    expect(result.trail.map((step) => step.outcome)).toContain("undated, and not the firm's own site");
  });

  it("drops an undated page that is not the firm's own", async () => {
    const { deps } = services({ [FIRM]: [undated("https://news.example/harbour")] }, { "https://news.example/harbour": POLICY });
    const result = await lookupEvidence(subject, deps);
    expect(result.usable).toBe(false);
    expect(result.trail.map((step) => step.outcome)).toContain("undated, and not the firm's own site");
  });

  it("still never reads a stale dated hit, and keeps to two searches and two fetches", async () => {
    const old: SearchHit = { ...undated("https://harbourmotor.example/old"), publishedAt: "2024-01-01" };
    const { deps, fetched } = services({ [PERSON]: [{ ...old, snippet: "Sam Ferris, Harbour Motor" }], [FIRM]: [old] }, {});
    const result = await lookupEvidence(subject, deps);
    expect(result).toMatchObject({ usable: false, searches: 2, fetches: 0 });
    expect(fetched).toEqual([]);
  });

  it("reads a labelled date anywhere, a byline date only near the top, and never a future one", () => {
    expect(pageDate("Some text.\n\nPosted on 4 July 2026 by the team", NOW)).toBe("2026-07-04");
    expect(pageDate("2026-05-02\n\n# News", NOW)).toBe("2026-05-02");
    expect(pageDate(`${"x ".repeat(400)} From 1 May 2026 the rules change.`, NOW)).toBeUndefined();
    expect(pageDate("Updated 22 October 2026", NOW)).toBeUndefined();
  });
});
