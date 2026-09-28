import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SEQUENCE, outreachInputSchema, packSliceSchema, type EvidenceQuote, type OutreachInput, type TouchKind } from "../../agents/outreach/input.schema";
import type { OutreachOutput } from "../../agents/outreach/output.schema";
import recorded from "../../fixtures/outreach/cohort-2026-09-15.json";
import { loadFacts } from "@/lib/facts/load";
import { liveFacts, withApprovedGives } from "@/lib/outreach/adapter";
import { attributesASource, gateFor, namedEntities, unsupportedSourceClaims, type GateContext } from "@/lib/outreach/gates";
import { loadStandard } from "@/lib/outreach/standard";

/**
 * Trial fix 2 (28 Sep 2026): the last faults from the trial's second re-run.
 *
 * Every draft sentence here is one the re-run wrote, with the people and firms swapped for made-up ones: the
 * trial wrote to real people, and their names and firms stay out of the repository. Harbour Motor is a motor
 * insurer, Brackenfield Legal sells legal expenses cover, Wayfarer Cover sells travel insurance.
 */

const standard = loadStandard();
const facts = liveFacts(loadFacts("insights360", 2).facts);
const gives: EvidenceQuote[] = standard.gives;
const SENDER = { firstName: "Alex", company: "Conversant" };
const base = recorded.people[0]!.input;
const ROLE_REF = packSliceSchema.parse(recorded.pack).archetype.pains[0]!.id;

type Who = { name: string; company: string; domain: string };
const HARBOUR: Who = { name: "Sam Ferris", company: "Harbour Motor", domain: "harbourmotor.example" };
const BRACKENFIELD: Who = { name: "Jordan Hale", company: "Brackenfield Legal", domain: "brackenfield.example" };
const WAYFARER: Who = { name: "Priya Okafor", company: "Wayfarer Cover", domain: "wayfarer.example" };

type Thread = OutreachInput["thread"];

function inputFor(who: Who, kind: TouchKind, thread: Thread = []): OutreachInput {
  const firstName = who.name.split(" ")[0]!;
  return outreachInputSchema.parse({
    ...base,
    person: { ...base.person, name: who.name, firstName, company: who.company, domain: who.domain, email: `${firstName.toLowerCase()}@${who.domain}` },
    account: { company: who.company, domain: who.domain },
    sender: SENDER,
    pack: withApprovedGives(packSliceSchema.parse(recorded.pack), standard, new Date("2026-09-28T09:00:00Z")),
    facts,
    standard,
    touch: { kind, ordinal: SEQUENCE.indexOf(kind) + 1, dueAt: "2026-09-28T09:00:00Z" },
    thread,
  });
}

const context = (): GateContext => ({ productNames: [facts.product], repName: "Alex", cohort: [] });
const message = (body: string, ask: string, subject?: string, claims: string[] = []): OutreachOutput => ({
  kind: "message",
  ...(subject === undefined ? {} : { subject }),
  body,
  ask,
  opener: { ref: ROLE_REF, kind: "role_pain" },
  claims,
});
const lastSentence = (body: string) => body.trim().split(/(?<=[.?!])\s+/).at(-1)!;
const touch = (body: string, subject?: string) => message(body, lastSentence(body), subject);
const rules = (result: { tierA: { rule: string }[] }) => result.tierA.map((finding) => finding.rule);
const advice = (result: { tierB: { rule: string }[] }) => result.tierB.map((finding) => finding.rule);
const held = (sentence: string) => unsupportedSourceClaims([sentence], gives, [HARBOUR.company, HARBOUR.name], ["Insights360"]);
const entry = (kind: TouchKind, body: string): Thread[number] => ({ kind, ordinal: SEQUENCE.indexOf(kind) + 1, body, fate: "drafted" });

// ---------------------------------------------------------------------------
// Fix 1: a trend or a pattern in a measured figure, with no quote carrying it.

describe("unsourced trend and pattern claims", () => {
  const TRIAL: readonly (readonly [string, string])[] = [
    ["li_dm2, two people: climb, tends to slip", "As complaint volumes climb, the share closed within three days tends to slip, and more cases drift toward the eight-week deadline."],
    ["li_dm2: rise, tends to grow", "As complaint volumes rise, the share that misses a quick close and drifts toward the eight-week deadline tends to grow as well."],
    ["li_dm2: have been climbing", "Complaint volumes across motor have been climbing, and a complaints team's capacity to review those calls doesn't grow at the same rate."],
    ["Email 1: can slip as volumes rise", "The share of complaints closed within three days can slip as volumes rise."],
  ];

  it.each(TRIAL)("holds the re-run's %s", (_where, sentence) => {
    expect(held(sentence)).toEqual([sentence]);
  });

  const FORMS = [
    "Complaint numbers climbed through the summer.",
    "Complaints have been rising across the market.",
    "The share closed on the first contact tends to fall.",
    "Uphold rates tend to rise in a busy quarter.",
    "The quick-close share may slip as complaint numbers climb.",
    "Response times suffer as volumes rise.",
  ];

  it.each(FORMS)("holds %s", (sentence) => {
    expect(held(sentence)).toEqual([sentence]);
  });

  it("holds the trial's LinkedIn follow-up whole, and says what to do", () => {
    const body =
      "Complaint volumes across motor have been climbing, and a complaints team's capacity to review those calls doesn't grow at the same rate. That's usually where root cause work gets thin first. How does your team's capacity for reviewing calls hold up as volume grows?";
    const found = gateFor(touch(body), inputFor(HARBOUR, "li_dm2"), context());
    expect(rules(found)).toContain("unsupported-source-claim");
    expect(found.tierA.find((finding) => finding.rule === "unsupported-source-claim")!.text).toContain("says something is rising or growing");
  });

  it("still passes the ombudsman's rise when the quote carries it", () => {
    expect(held(`The ombudsman's quarterly figures for April to June 2026 show ${gives[0]!.quote.charAt(0).toLowerCase()}${gives[0]!.quote.slice(1)}`)).toEqual([]);
  });

  const ORDINARY = [
    "As your team grows, the calls get harder to review by hand.",
    "Claims teams rarely see the whole set of calls behind a complaint.",
    "A fix can slip through without anyone checking it worked.",
    "The call rose to a manager before anyone listened back.",
    "Complaints teams grow as the business does.",
    "When a complaint goes up to a senior manager, the calls behind it matter most.",
    "A complaint rises to a manager before anyone listens back.",
    "The conversation tends to drift toward price.",
  ];

  it.each(ORDINARY)("does not read an ordinary sentence as a trend: %s", (sentence) => {
    expect(attributesASource(sentence)).toBe(false);
    expect(held(sentence)).toEqual([]);
  });

  // Fix round 2 (Critic on #54): "rises" and "increases" after a preposition are nouns, an escalation goes up the
  // chain as well as to a manager, and a job "tends to fall to" someone.
  const CRITIC_ORDINARY = [
    "We see a lot of complaints about premium rises at renewal.",
    "Claims about price increases are the ones that reach the ombudsman.",
    "Most disputes about rate rises start on the phone.",
    "When a complaint goes up the chain, the notes rarely follow it.",
    "Complaints that go up a level lose the call context.",
    "The root-cause write-up tends to fall to one team leader.",
    "Ownership of the fix tends to fall between claims and customer services.",
  ];

  it.each(CRITIC_ORDINARY)("does not read Critic's ordinary sentence as a trend: %s", (sentence) => {
    expect(attributesASource(sentence.replace(/ombudsman/, "complaints team"))).toBe(false);
    expect(held(sentence.replace(/ombudsman/, "complaints team"))).toEqual([]);
  });

  it.each(["As the complaint volume goes up, reviews slip.", "Complaint numbers go up every winter.", "Volumes across motor rise every January."])("still holds a trend put with \"goes up\" or a gap: %s", (sentence) => {
    expect(held(sentence)).toEqual([sentence]);
  });

  it("tells the drafter never to describe how a figure moves without a quote", () => {
    expect(readFileSync("agents/outreach/prompt.md", "utf8")).toContain("Never describe how a market or complaint figure moves or tends to move unless a quote says so.");
  });
});

// ---------------------------------------------------------------------------
// Fix 2: the FCA's publication schedule is gone, and held if it comes back.

describe("the FCA's publication schedule", () => {
  it("is no longer an approved give; the other two stay", () => {
    expect(gives.map((give) => give.id)).toEqual(["give-fos-motor-complaints-q1-2026", "give-fca-interventions-not-measured"]);
    expect(gives.some((give) => /every 6 months|22 October/i.test(`${give.quote} ${give.sourceName}`))).toBe(false);
  });

  const TRIAL = [
    "The FCA's complaints data page says, 'We publish our complaints data every 6 months, around April and October,' and the H1 figures by firm land on 22 October.",
    "The FCA publishes its complaints data every 6 months, around April and October, with the H1 figures by firm landing on 22 October.",
    "The FCA publishes its complaints data every 6 months, around April and October, and the H1 figures by firm on 22 October.",
    "The FCA's complaints data page says it publishes complaints data every 6 months, around April and October, with the H1 figures by firm out on 22 October.",
    "The regulator publishes complaints figures twice a year.",
    "The H1 figures by firm land on 22 October.",
  ];

  it.each(TRIAL)("holds %s", (sentence) => {
    const found = gateFor(touch(`${sentence} Who puts the explanation together on your side?`), inputFor(HARBOUR, "li_dm"), context());
    expect(rules(found)).toContain("fca-schedule");
  });

  it("holds it in Email 1 too", () => {
    const body = `Proving a fix worked is harder than naming the cause. ${TRIAL[2]}\n\nHow do you show a change worked?`;
    expect(rules(gateFor(touch(body, "proving a fix worked"), inputFor(HARBOUR, "email1"), context()))).toContain("fca-schedule");
  });

  it("does not hold a publication the reader's own firm makes, with no regulator named", () => {
    const body = "The half-yearly complaints publication puts a number under your name twice a year, with limited room to explain it. Worth connecting?";
    expect(rules(gateFor(touch(body), inputFor(HARBOUR, "li_connect"), context()))).not.toContain("fca-schedule");
  });
});

// ---------------------------------------------------------------------------
// Fix 3: a word opening a question or an offer is not a name.

describe("unsourced-name at the start of a sentence", () => {
  it("passes the re-run's LinkedIn message held for \"Shall I\"", () => {
    const body = `The ombudsman's quarterly figures for April to June 2026 show car and motorcycle insurance complaints rose to 4,100, up from 2,800 in the same period in 2025. That's more complaints where the account of what happened on the call needs to hold up. Shall I send over the ombudsman's write-up?`;
    const found = gateFor(touch(body), inputFor(HARBOUR, "li_dm", [entry("email1", "When a motor complaint lands, the ombudsman's figures are rarely the first thing anyone checks. How do you find the calls behind one?")]), context());
    expect(rules(found)).not.toContain("unsourced-name");
    expect(found.tierA).toEqual([]);
  });

  it("does not read \"Want\" after a closing quote mark as a name", () => {
    const body = `A fix counts once you can show it changed the calls behind the number. The FCA's review of 40 firms found: '${gives[1]!.quote}' Want me to send it over?`;
    expect(namedEntities(body)).not.toContain("Want");
    expect(rules(gateFor(touch(body), inputFor(HARBOUR, "email2"), context()))).not.toContain("unsourced-name");
  });

  it.each(["Should I send it over?", "Worth a look?", "Want me to send the summary?", "Shall I leave it there?"])("reads no name in %s", (sentence) => {
    expect(namedEntities(sentence).filter((name) => name !== "I")).toEqual([]);
  });

  it.each([
    ["a name mid-sentence", "We spoke to Northgate about the same problem last month.", "Northgate"],
    ["a two-word name at the start", "Northgate Mutual found the same thing last year.", "Northgate Mutual"],
    ["a name after an opener", "Should Northgate ask, the answer is the same.", "Northgate"],
  ])("still holds %s", (_what, sentence, name) => {
    const found = gateFor(touch(`${sentence} Who looks after that on your side?`), inputFor(HARBOUR, "li_dm"), context());
    expect(rules(found)).toContain("unsourced-name");
    expect(found.tierA.find((finding) => finding.rule === "unsourced-name")!.text).toContain(`"${name}"`);
  });
});

// ---------------------------------------------------------------------------
// Fix 4: one firm's main complaint cause, said of every firm or of this one.

describe("one firm's complaint category", () => {
  const E1 =
    "When a complaints report needs a cause, 'other general admin' is often the only category on offer, and it says nothing about what actually happened on the call.\n\nHow do you get from a category like that to what happened on the calls?";

  it("holds the re-run's Email 1 sentence", () => {
    expect(rules(gateFor(touch(E1, "what a category hides"), inputFor(WAYFARER, "email1"), context()))).toContain("one-firm-cause");
  });

  it("holds the call script's assumption about this firm's published category", () => {
    const call: OutreachOutput = {
      kind: "call",
      talkingPoint: {
        openingLine: "Hi Priya, it's Alex from Conversant. I emailed about complaint categories. Is now an alright time?",
        oneQuestion: "When your published category is just 'general admin', how do you currently work out what actually happened on the call?",
        openingLine2: "Alex again, from Conversant. Have you got a moment?",
        oneQuestion2: "Who decides which calls get reviewed?",
        listenFor: "Whether they can get from a category to the calls behind it.",
        voicemail: "Hi Priya, it's Alex from Conversant. No need to call back, I'll follow up by email.",
        numberSource: "switchboard",
      },
      opener: { ref: ROLE_REF, kind: "role_pain" },
      claims: [],
    };
    const found = gateFor(call, inputFor(WAYFARER, "call"), context());
    expect(rules(found)).toContain("one-firm-cause");
  });

  it("passes when this person's own lookup says it", () => {
    const input = inputFor(WAYFARER, "email1");
    const item = { ...input.pack.archetype.pains[0]!, about: "firm", text: "Wayfarer Cover's published main complaint cause is other general admin." } as unknown as OutreachInput["lookup"]["items"][number];
    const found = gateFor(touch(E1, "what a category hides"), { ...input, lookup: { ...input.lookup, items: [item] } }, context());
    expect(rules(found)).not.toContain("one-firm-cause");
  });

  it("does not hold a category mentioned in passing", () => {
    const body = "A complaint category says what to file a case under, not what happened on the call. Who ends up working that out?";
    expect(rules(gateFor(touch(body), inputFor(WAYFARER, "li_dm"), context()))).not.toContain("one-firm-cause");
  });

  // Fix round 2 (Critic on #54): keyed on "general admin", whatever the wording, and a bare "only category" is fine.
  it.each([
    "Most firms file their complaints under 'general admin'.",
    "General admin is the biggest cause on your published data.",
    "'Other general admin' tops most firms' published causes.",
  ])("holds a rewording: %s", (sentence) => {
    expect(rules(gateFor(touch(`${sentence} Who looks at what sits behind it?`), inputFor(WAYFARER, "li_dm"), context()))).toContain("one-firm-cause");
  });

  it("does not hold a bare \"only category\" with no general admin in it", () => {
    const body = "Is complaints the only category you report on the dashboard?";
    expect(rules(gateFor(touch(body), inputFor(WAYFARER, "li_dm2"), context()))).not.toContain("one-firm-cause");
  });
});

// ---------------------------------------------------------------------------
// Fix 5: an offer of a source's write-up follows from the thread (advice).

describe("the relative-date remedy (fix round 2 of #54)", () => {
  it("no longer suggests the dropped give's date", () => {
    const body = "The figures publish on 3 November, which leaves six weeks to get ahead of them. Who puts the explanation together on your side?";
    const found = gateFor(touch(body), inputFor(HARBOUR, "li_dm2"), context()).tierA.find((finding) => finding.rule === "relative-date");
    expect(found?.text).toContain("Give the date itself, as the plan gives it, or nothing");
    expect(found?.text).not.toContain("22 October");
  });
});

describe("an offer that names a source", () => {
  const RHYS_E1 =
    "Most complaints MI can say what caused a complaint and what the fix was. Whether that fix actually worked afterwards is a different question. Usually it comes down to a judgement call, because there's nothing solid to check it against.\n\nWhen you do make a change, how do you show it worked?";
  const RHYS_E2 = `Pointing to one handler doing something differently is easy. Showing it changed the pattern across every complaint-adjacent call is a different claim.\n\n${facts.product}'s dashboard compares each period against the one before it, so a change shows up in the numbers.\n\nWant me to send over the ombudsman's write-up?`;

  it("advises when nothing earlier in the thread mentions the ombudsman", () => {
    const found = gateFor(message(RHYS_E2, "Want me to send over the ombudsman's write-up?"), inputFor(HARBOUR, "email2", [entry("email1", RHYS_E1)]), context());
    expect(advice(found)).toContain("ask-source");
    expect(rules(found)).not.toContain("ask-source");
  });

  it("gives no advice when an earlier touch raised it", () => {
    const thread = [entry("email1", `${RHYS_E1.split("\n\n")[0]} The ombudsman sees the cases that were never settled.\n\nWhen you do make a change, how do you show it worked?`)];
    expect(advice(gateFor(message(RHYS_E2, "Want me to send over the ombudsman's write-up?"), inputFor(HARBOUR, "email2", thread), context()))).not.toContain("ask-source");
  });

  it.each(["Want me to send over the Financial Ombudsman Service's write-up?", "Want me to send over the FOS's summary?"])("advises on the ombudsman's full name and its initials: %s", (offer) => {
    const body = RHYS_E2.replace("Want me to send over the ombudsman's write-up?", offer);
    expect(advice(gateFor(message(body, offer), inputFor(HARBOUR, "email2", [entry("email1", RHYS_E1)]), context()))).toContain("ask-source");
  });

  it("gives no advice when the same touch raised it", () => {
    const body = `The FCA's review of 40 firms found that firms did not always measure the impact of interventions they had made to ensure these were the right changes to make. Should I send over the FCA's write-up?`;
    expect(advice(gateFor(touch(body), inputFor(HARBOUR, "li_dm"), context()))).not.toContain("ask-source");
  });
});

// ---------------------------------------------------------------------------
// The re-run's two best sequences, touch by touch: every touch the review sent as is still passes, and the two
// FCA-schedule touches are now held (the give is gone, so its date and "H1" are unsourced too).

type Step = { kind: TouchKind; body: string; subject?: string; draft?: OutreachOutput };

function walk(who: Who, steps: readonly Step[]) {
  const thread: Thread = [];
  return steps.map((step) => {
    const draft = step.draft ?? touch(step.body, step.subject);
    const found = gateFor(draft, inputFor(who, step.kind, [...thread]), context());
    if (step.kind !== "call") thread.push({ ...entry(step.kind, step.body), ...(step.subject === undefined ? {} : { subject: step.subject }) });
    return { kind: step.kind, rules: rules(found) };
  });
}

describe("the re-run's clean sequences still pass", () => {
  it("the legal-expenses champion: six touches clean, the schedule LinkedIn message held, the schedule among its findings", () => {
    const steps: Step[] = [
      {
        kind: "email1",
        subject: "proving a fix worked",
        body: "Working out why a complaint happened is usually straightforward. Showing that whatever you changed afterwards actually fixed it is harder, and complaints management information generally stops at the category label.\n\nThe FCA's review of 40 firms found that firms did not always measure the impact of interventions they had made to ensure these were the right changes to make. When someone asks whether a change you made actually worked, what do you point to?",
      },
      { kind: "email2", body: `The evidence for a fix usually comes from calls that already became a complaint, rather than the wider set that showed the same pattern earlier and never escalated. ${facts.product} analyses every call that comes in, so a pattern can be checked across the whole set rather than just the ones that got flagged. Who at Brackenfield Legal ends up putting that evidence together?` },
      { kind: "breakup", body: "I'll stop chasing this so I'm not filling your inbox. Root cause and evidence for complaints isn't going away, but the timing might not be right just now. Would it be better if I left this for now?" },
      { kind: "li_connect", body: "Proving that a complaints fix actually worked is harder than identifying the cause in the first place. Worth connecting on that?" },
      {
        kind: "li_dm",
        body: "Root cause work usually only gets checked once, at the point a complaint is investigated, rather than kept under review once a fix has gone in. The FCA publishes its complaints data every 6 months, around April and October, with the H1 figures by firm landing on 22 October. Should I send over the FCA's write-up on this?",
      },
      { kind: "li_dm2", body: "A fix that can't be evidenced is hard to defend if a complaint escalates further, whatever the category code says caused it. How does that pressure show up for you day to day?" },
    ];
    const result = walk(BRACKENFIELD, steps);
    for (const { kind, rules: found } of result) {
      if (kind === "li_dm") expect(found, kind).toContain("fca-schedule");
      else expect(found, kind).toEqual([]);
    }
  });

  // Voice round (28 Sep 2026): the LinkedIn message ("…already got flagged, not the full set around it") and the
  // follow-up ("is a separate problem from making the fix itself") use the contrast cadence Benny-san banned.
  it("the travel champion: four touches clean, the schedule Email 2 held, the two contrast LinkedIn touches held", () => {
    const steps: Step[] = [
      {
        kind: "email1",
        subject: "proving the fix worked",
        body: "Proving a fix worked is often harder than naming the cause in the first place. The FCA's review of 40 firms found that firms did not always measure the impact of interventions they had made to ensure these were the right changes to make.\n\nA complaint category doesn't tell you that. You need what's underneath it. How do you evidence that a change has worked once you've made it?",
      },
      {
        kind: "email2",
        body: `The FCA publishes its complaints data every 6 months, around April and October, and the H1 figures by firm on 22 October. A category label doesn't explain why the numbers moved. ${facts.product} analyses every call that comes in, so a pattern doesn't depend on which cases happened to get escalated. Who owns pulling that evidence together when the numbers get questioned?`,
      },
      { kind: "breakup", body: "I'll leave it there so I'm not filling your inbox. Worth a word later in the year if this becomes more pressing?" },
      { kind: "li_connect", body: "Proving a fix worked is hard when the data you get is just a category label. Worth connecting?" },
      {
        kind: "li_dm",
        body: "When a complaint does get investigated, the review usually starts from a handful of calls that already got flagged, not the full set around it. That makes it hard to say with confidence what the pattern actually is, rather than what the loudest case happened to be. Who ends up choosing which calls get pulled for a review like that?",
      },
      {
        kind: "li_dm2",
        body: "Even once a fix is made, checking whether it actually changed anything is a separate problem from making the fix itself. There's rarely an easy way to see that once a case has closed. How would you know if a change like that had actually worked?",
      },
    ];
    const result = walk(WAYFARER, steps);
    for (const { kind, rules: found } of result) {
      if (kind === "email2") expect(found, kind).toContain("fca-schedule");
      else if (kind === "li_dm" || kind === "li_dm2") expect(found, kind).toEqual(["contrast"]);
      else expect(found, kind).toEqual([]);
    }
  });
});
