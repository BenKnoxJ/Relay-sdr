import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SEQUENCE, outreachInputSchema, packSliceSchema, type EvidenceQuote, type OutreachInput, type TouchKind } from "../../agents/outreach/input.schema";
import { outputSchemaFor, type OutreachOutput } from "../../agents/outreach/output.schema";
import recorded from "../../fixtures/outreach/cohort-2026-09-15.json";
import { loadFacts } from "@/lib/facts/load";
import { liveFacts, withApprovedGives } from "@/lib/outreach/adapter";
import { evidenceUsedIn, gateFor, humanizerLoss, unsupportedSourceClaims, type GateContext } from "@/lib/outreach/gates";
import { loadStandard } from "@/lib/outreach/standard";
import { loadDefaultVoice, voiceInputOf } from "@/lib/outreach/voice";

/**
 * The voice round (28 Sep 2026, Benny-san): the drafts were accurate and read as AI-written. The voice layer is
 * now the rep's own hand, from the fleet's approved outreach messages, and the accuracy layer is unchanged.
 *
 * Every person and firm here is made up, with the kind of firm kept because the hook depends on it: Throttle
 * Cover is a direct motorcycle insurer, Hartwell & Crane writes professional indemnity for vets and architects,
 * Sunwell Life is group life cover with a wellbeing app, Keelstone is a specialty commercial MGA and Pawsford
 * sells pet cover direct.
 */

const standard = loadStandard();
const facts = liveFacts(loadFacts("insights360", 2).facts);
const gives: EvidenceQuote[] = standard.gives;
const FCA = gives.find((give) => give.id === "give-fca-interventions-not-measured")!;
const SENDER = { firstName: "Alex", company: "Conversant" };
const base = recorded.people[0]!.input;
const ROLE_REF = packSliceSchema.parse(recorded.pack).archetype.pains[0]!.id;

type Who = { name: string; title: string; company: string; domain: string; firmFact?: string };
const ROB: Who = { name: "Rob Harker", title: "Contact Centre Manager", company: "Throttle Cover", domain: "throttlecover.example" };
const TESS: Who = {
  name: "Tess Morland",
  title: "Head of Professional Indemnity",
  company: "Hartwell & Crane",
  domain: "hartwellcrane.example",
  firmFact: "Hartwell & Crane writes PI cover for vets and architects, and QA covers a sample of the calls.",
};
const NADIA: Who = { name: "Nadia Sorensen", title: "Head of Customer Experience", company: "Sunwell Life", domain: "sunwell.example" };
const DEV: Who = {
  name: "Dev Anand",
  title: "Head of Operations",
  company: "Keelstone",
  domain: "keelstone.example",
  firmFact: "Keelstone is a specialty commercial MGA; much of what is agreed on a deal is agreed on the placing call.",
};
const PAWPRINT: Who = { name: "Lou Carden", title: "Head of Customer Operations", company: "Pawsford", domain: "pawsford.example" };
const HARBOUR: Who = { name: "Sam Ferris", title: "Head of Claims", company: "Harbour Motor", domain: "harbourmotor.example" };

type Thread = OutreachInput["thread"];

function inputFor(who: Who, kind: TouchKind, thread: Thread = []): OutreachInput {
  const firstName = who.name.split(" ")[0]!;
  const items =
    who.firmFact === undefined
      ? []
      : [
          {
            id: "look-firm-1",
            about: "firm",
            text: who.firmFact,
            quote: who.firmFact,
            publishedAt: "2026-08-01",
            accessedAt: "2026-09-28",
            evidence: { urls: [`https://${who.domain}/about`], primary: true, domains: [who.domain] },
            confidence: "strong",
          },
        ];
  return outreachInputSchema.parse({
    ...base,
    person: { ...base.person, name: who.name, firstName, title: who.title, company: who.company, domain: who.domain, email: `${firstName.toLowerCase()}@${who.domain}` },
    account: { company: who.company, domain: who.domain },
    sender: SENDER,
    pack: withApprovedGives(packSliceSchema.parse(recorded.pack), standard, new Date("2026-09-28T09:00:00Z")),
    facts,
    standard,
    lookup: { items, usable: items.length > 0, searches: 1, fetches: 0 },
    touch: { kind, ordinal: SEQUENCE.indexOf(kind) + 1, dueAt: "2026-09-28T09:00:00Z" },
    thread,
  });
}

const context = (): GateContext => ({ productNames: [facts.product], repName: "Alex", cohort: [] });
const lastSentence = (body: string) => body.trim().split(/(?<=[.?!])\s+/).at(-1)!;
const message = (body: string, subject?: string, opener: OutreachOutput["opener"] = { ref: ROLE_REF, kind: "role_pain" }): OutreachOutput => ({
  kind: "message",
  ...(subject === undefined ? {} : { subject }),
  body,
  ask: lastSentence(body),
  opener,
  claims: [],
});
const rules = (result: { tierA: { rule: string }[] }) => result.tierA.map((finding) => finding.rule);
const entry = (kind: TouchKind, body: string): Thread[number] => ({ kind, ordinal: SEQUENCE.indexOf(kind) + 1, body, fate: "drafted" });
const held = (sentence: string) => unsupportedSourceClaims([sentence], gives, [HARBOUR.company, HARBOUR.name], ["Insights360"]);

/** A touch through the shape it is written in and every gate, as the draft job runs them. */
function gated(draft: OutreachOutput, input: OutreachInput): string[] {
  const shaped = outputSchemaFor(input.touch.kind).safeParse(draft);
  if (!shaped.success) return shaped.error.issues.map((issue) => `shape: ${issue.message}`);
  return rules(gateFor(shaped.data, input, context()));
}

// ---------------------------------------------------------------------------
// The acceptance test for voice: the rep's approved messages pass every gate.

const { anchors } = loadDefaultVoice();
const anchor = (company: string, register: "email" | "linkedin") => anchors.find((item) => item.register === register && item.ask.includes(company))!.wrote;
const dmOf = (wrote: string) => wrote.split("\n\n").find((part) => part.startsWith("Message: "))!.replace("Message: ", "");
const noteOf = (wrote: string) => wrote.split("\n\n").find((part) => part.startsWith("Note: "))!.replace("Note: ", "");

describe("the rep's approved messages pass every Relay gate", () => {
  it("the approved cold email (Throttle Cover) passes as Email 1, two questions and the light line about the rep included", () => {
    const body = anchor("Throttle Cover", "email");
    expect((body.match(/\?/g) ?? []).length).toBe(2);
    expect(body).toContain("I've been helping a few insurers get a proper look at calls like that.");
    expect(gated(message(body, "the spring rush"), inputFor(ROB, "email1"))).toEqual([]);
  });

  it("the approved LinkedIn message (Hartwell & Crane) passes as the message after they accept", () => {
    const body = dmOf(anchor("Hartwell & Crane", "linkedin"));
    expect(gated(message(body, undefined, { ref: "look-firm-1", kind: "firm_fact" }), inputFor(TESS, "li_dm"))).toEqual([]);
  });

  it("its connection note passes, closing on a statement", () => {
    const body = noteOf(anchor("Hartwell & Crane", "linkedin"));
    expect(gated(message(body, undefined, { ref: "look-firm-1", kind: "firm_fact" }), inputFor(TESS, "li_connect"))).toEqual([]);
  });

  it("the other worked first emails pass: no line about the rep, and a compare-notes statement close", () => {
    expect(gated(message(anchor("Sunwell", "email"), "the two halves of sunwell"), inputFor(NADIA, "email1"))).toEqual([]);
    expect(gated(message(anchor("Keelstone", "email"), "what gets agreed on the call", { ref: "look-firm-1", kind: "firm_fact" }), inputFor(DEV, "email1"))).toEqual([]);
  });

  it("the other worked LinkedIn message passes", () => {
    expect(gated(message(dmOf(anchor("Keelstone", "linkedin")), undefined, { ref: "look-firm-1", kind: "firm_fact" }), inputFor(DEV, "li_dm"))).toEqual([]);
  });

  it("holds the rejected regulatory-fact opener, the prompt's bad example", () => {
    const bad =
      "Pawsford's customer-facing calls carry the same Consumer Duty evidence obligation as any FCA-authorised firm. The 31 July board report requires demonstrating good outcomes across those interactions.\n\nIf your QA monitoring covers 2 to 5% of calls, the board is signing off on 5% of the evidence. Is this on your radar ahead of July?";
    const found = gated(message(bad, "consumer duty call evidence"), inputFor(PAWPRINT, "email1"));
    expect(found).toContain("unsupported-source-claim");
    expect(found).toContain("unsourced-number");
    expect(readFileSync("agents/outreach/prompt.md", "utf8")).toContain(bad.replace("\n\n", " "));
  });
});

// ---------------------------------------------------------------------------
// The vendored hand reaches the writer, and no real name comes with it.

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
    const file = JSON.parse(readFileSync("agents/outreach/voice/anchors.json", "utf8")) as { source: string };
    expect(file.source).toMatch(/Vendored 28 Sep 2026/);
    expect(new Set(anchors.map((item) => item.register))).toEqual(new Set(["email", "linkedin"]));
  });

  it("carries none of the real people or firms the fleet's samples were written to", () => {
    const vendored = ["agents/outreach/voice/anchors.json", "agents/outreach/voice/style.md", "agents/outreach/standard.json", "agents/outreach/prompt.md", "agents/outreach/humanizer.md"]
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    // The real names are kept out of the repository even here: each is a fingerprint (the first 16 hex characters
    // of the SHA-256 of the lower-case name), checked against every run of one to three words in the vendored text.
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
    ]);
    const tokens = vendored.toLowerCase().replace(/[’']s\b/g, "").match(/[a-z&]+/g) ?? [];
    const found = tokens.flatMap((_, i) => [1, 2, 3].map((n) => tokens.slice(i, i + n).join(" "))).filter((run) => REAL.has(createHash("sha256").update(run).digest("hex").slice(0, 16)));
    expect(found).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// D1: one light line about the rep in Email 1.

describe("the light line about the rep (D1)", () => {
  const opening = "Saw you run the contact centre at Throttle Cover. Spring must be brutal, everyone back on the bikes at once and the team going from quiet to flat-out in a fortnight.";
  const close = "Mostly though I'm curious how you handle it, do you flex the team or lean on the people who've been through it before?\n\nHow do you handle it when the season turns?";
  const withAside = (aside: string) => message(`${opening}\n\n${aside} ${close}`, "the spring rush");

  it("is no longer a tell", () => {
    for (const phrase of ["been helping a few", "we've been helping", "i've been helping"]) expect(standard.bannedLexicon).not.toContain(phrase);
    for (const phrase of ["teams i speak to", "clients i work with", "what we tend to see"]) expect(standard.bannedLexicon).toContain(phrase);
  });

  it("passes in Email 1", () => {
    expect(gated(withAside("I've been helping a few insurers get a proper look at calls like that."), inputFor(ROB, "email1"))).toEqual([]);
  });

  it.each([
    ["the product's name", `I've been helping a few insurers use ${"Insights360"} on calls like that.`],
    ["what the product does", "I've been helping a few insurers score every call like that automatically."],
    ["a result", "I've been helping a few insurers cut their complaint volumes on calls like that."],
  ])("still holds %s", (_what, aside) => {
    expect(gated(withAside(aside), inputFor(ROB, "email1"))).toContain("product-in-email1");
  });

  it("holds it twice in one touch", () => {
    expect(gated(withAside("I've been helping a few insurers get a proper look at calls like that. Been helping a few others too."), inputFor(ROB, "email1"))).toContain("aside");
  });
});

// ---------------------------------------------------------------------------
// D2: a short quoted fragment of the source's own words.

describe("a quoted fragment of the source (D2)", () => {
  it.each([
    `The FCA's review of 40 firms made the point that firms "did not always measure the impact" of the changes they made.`,
    `One of the points in the FCA's review of 40 firms was that firms "did not always measure" what their changes did.`,
    `The FCA's review of 40 firms said “firms pursued actions even though” they were not the right ones.`,
  ])("passes %s", (sentence) => {
    expect(held(sentence)).toEqual([]);
  });

  it.each([
    ["a paraphrase", "The FCA's review of 40 firms found firms weren't checking their changes."],
    ["hardening outside the quote", `The FCA's review of 40 firms found firms "did not always measure the impact", so their changes weren't working.`],
    ["an added frequency", `The FCA's review of 40 firms found most firms "did not always measure the impact" of their changes.`],
    ["a made-up quotation", `The FCA's review of 40 firms said firms "never check whether a fix worked" at all.`],
    ["a fragment too short to be the quote", `The FCA's review of 40 firms said firms "did not always" check.`],
    ["the fragment with no source named", `Plenty of firms "did not always measure the impact" of what they changed.`],
    ["the fragment credited to the wrong body", `The ombudsman found firms "did not always measure the impact" of their changes.`],
  ])("still holds %s", (_what, sentence) => {
    expect(held(sentence)).toEqual([sentence]);
  });

  it("counts a fragment as the quote used, so a colleague is not sent it again", () => {
    expect(evidenceUsedIn(`The FCA's review made the point that firms "did not always measure the impact" of changes.`, gives)).toEqual([FCA.id]);
  });

  it("keeps the drafted words when the humanizer rewords a fragment", () => {
    // Four words, so no six-word run covers it: the fragment is checked as itself.
    const before = message(`The FCA's review of 40 firms said firms "did not always measure" what their changes did. Worth a chat?`);
    const after = message(`The FCA's review of 40 firms said firms "did not always check" what their changes did. Worth a chat?`);
    expect(humanizerLoss(before, after, gives)).toMatch(/quoted fragment/);
    expect(humanizerLoss(before, before, gives)).toBeNull();
  });

  it("passes the standard's own fragment exemplar through Email 1", () => {
    const email = standard.exemplars.find((exemplar) => exemplar.draft.kind === "message" && exemplar.draft.body.includes('"did not always measure the impact"'));
    expect(email?.touch).toBe("email1");
  });
});

// ---------------------------------------------------------------------------
// The contrast cadence, consultant vocabulary and American spelling.

describe("the contrast cadence", () => {
  const dm = (sentence: string) => message(`${sentence} Been wondering how the team keeps on top of the delay calls day to day. Who looks after that?`);
  const run = (sentence: string) => gated(dm(sentence), inputFor(HARBOUR, "li_dm2"));

  it.each([
    "Whether the fix worked is a separate question.",
    "Checking it worked is a different job entirely.",
    "Naming the cause is one thing, and proving the fix is another.",
    "The complaint numbers say what moved, never which calls moved them.",
    "A category tells you where a case was filed. It says nothing about the call.",
    "The review covers the calls that got flagged, not the ones that never did.",
    "Not a subset. All of them.",
  ])("holds %s", (sentence) => {
    expect(run(sentence)).toContain("contrast");
  });

  it.each([
    "We have not yet looked at the delay calls properly.",
    "Whether or not the fix worked, someone has to check the calls.",
    "Most of the team is heading towards the busy season now.",
    "Not yet, but hopefully soon.",
  ])("does not hold ordinary English: %s", (sentence) => {
    expect(run(sentence)).not.toContain("contrast");
  });
});

describe("consultant vocabulary and the rep's own phrases", () => {
  const dm = (sentence: string) => message(`${sentence} Been wondering how the team keeps on top of the delay calls day to day. Who looks after that?`);
  const tells = (sentence: string) => gateFor(dm(sentence), inputFor(HARBOUR, "li_dm2"), context()).tierA.find((finding) => finding.rule === "tells")?.text ?? "";

  it.each([
    ["Evidencing a fix is hard.", "evidencing"],
    ["It needs demonstrable outcomes.", "demonstrable"],
    ["It needs a robust process.", "robust"],
    ["These are advisory conversations at heart.", "advisory conversations"],
    ["What we tend to see is the same three arguments.", "what we tend to see"],
    ["We work with a few insurers on the QA side.", "we work with … on the … side"],
    ["Is delay the main theme, or is that guesswork?", "or is that"],
  ])("holds %j", (sentence, tell) => {
    expect(tells(sentence)).toContain(`"${tell}"`);
  });

  it.each(["I keep wondering how the team holds two registers that different.", "Happy to compare notes, I'd be happy to.", "Do the same people take them, or is that a different team entirely?"])(
    "lets the rep's own phrases through: %s",
    (sentence) => {
      expect(tells(sentence)).toBe("");
    },
  );
});

describe("American spellings", () => {
  const dm = (sentence: string) => message(`${sentence} Been wondering how the team keeps on top of the delay calls day to day. Who looks after that?`);
  const spelling = (sentence: string) => gateFor(dm(sentence), inputFor(HARBOUR, "li_dm2"), context()).tierA.find((finding) => finding.rule === "spelling")?.text ?? "";

  it.each([
    ["The team is moving toward weekly reviews.", "toward (towards)"],
    ["The color of the dashboard is a detail.", "color (colour)"],
    ["It depends on the organization and its size.", "organization (organisation)"],
    ["They analyze a few calls a week.", "analyze (analyse)"],
    ["The coaching program runs monthly.", "program (programme)"],
    ["The contact center runs late shifts.", "center (centre)"],
    ["Handlers need a license to advise.", "license (licence)"],
    ["They practiced the script for a week.", "practiced (practised)"],
    ["It is a gray area for most teams.", "gray (grey)"],
    ["The team does it in favor of speed.", "favor (favour)"],
  ])("holds %j with the British spelling as the remedy", (sentence, remedy) => {
    expect(spelling(sentence)).toContain(remedy);
  });

  it.each(["The team is moving towards weekly reviews.", "It runs on a computer program they built.", "While the team is small, it copes.", "They license the software per seat."])("passes %s", (sentence) => {
    expect(spelling(sentence)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Closes: a statement is fine in the connection note, the last email and one other touch.

describe("statement closes", () => {
  const email1 = anchor("Throttle Cover", "email");

  it("allows one touch besides the connection note and the last email to close on a statement", () => {
    const thread = [entry("email1", email1)];
    expect(gated(message("Been thinking about the spring rush a bit more, and how the new starters cope with the first big week of it. No need to reply, just got me thinking."), inputFor(ROB, "li_dm2", thread))).not.toContain("statement-close");
  });

  it("holds a second one", () => {
    const thread = [entry("email1", email1), entry("email2", "The bit I keep coming back to is the first week of the season and who takes the hardest calls. Happy to compare notes on it some time.")];
    expect(gated(message("Been thinking about the spring rush a bit more, and how the new starters cope with the first big week of it. No need to reply, just got me thinking."), inputFor(ROB, "li_dm2", thread))).toContain("statement-close");
  });

  it("never counts the connection note or the last email", () => {
    const thread = [entry("email1", email1), entry("breakup", "I'll leave it there, no worries if the timing's off."), entry("li_connect", "Rob, you run the contact centre at Throttle Cover. Be good to connect.")];
    expect(gated(message("Been thinking about the spring rush a bit more, and how the new starters cope with the first big week of it. No need to reply, just got me thinking."), inputFor(ROB, "li_dm2", thread))).not.toContain("statement-close");
  });

  it("refuses a third question mark in one message", () => {
    const shaped = outputSchemaFor("email1").safeParse(message("Is it busy? Is it quiet? How do you handle it when the season turns?", "the spring rush"));
    expect(shaped.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Self-review probes (before Critic): ordinary English the new gates must let through, and trends they must hold.

describe("self-review probes", () => {
  const dm = (sentence: string) => message(`${sentence} Been wondering how the team keeps on top of the delay calls day to day. Who looks after that?`);
  const run = (sentence: string) => gated(dm(sentence), inputFor(HARBOUR, "li_dm2"));

  it.each([
    "Not a problem at all.",
    "Not to worry.",
    "Not everyone does.",
    "Happy to send it over, not a problem.",
    "Hope the move went well, not an easy one.",
    "Spring's a busy time, not the easiest for anyone.",
    "Firms that license their data have it easier.",
    "Your team has been helping customers through the floods, I've been helping a few insurers with calls like that.",
  ])("passes %s", (sentence) => {
    expect(run(sentence)).toEqual([]);
  });

  it("does not read a surname as an American spelling (the name itself is provenance's business)", () => {
    expect(run("Emma Gray mentioned the same thing.")).not.toContain("spelling");
  });

  it.each(["The report tells you nothing about tone.", "The dashboard tells you what happened, never why."])("holds the contrast in %s", (sentence) => {
    expect(run(sentence)).toContain("contrast");
  });

  it.each([
    "Engagement tends to drop off after day three.",
    "The uphold rate tends to fall to single figures by March.",
    "Volumes tend to rise to a peak.",
    "Complaint volumes grow a lot after renewal.",
    "Claims for storm damage rise every autumn.",
    "Complaint volumes on motor climb in January.",
  ])("holds the trend in %s", (sentence) => {
    expect(held(sentence)).toEqual([sentence]);
  });

  it.each(["Customers complain about a price rise at renewal.", "Complaints about premium increases peak in January."])("does not read a noun as a trend: %s", (sentence) => {
    expect(held(sentence)).toEqual([]);
  });

  it("reads a curly-quoted fragment with an apostrophe in it whole", () => {
    const sentence = "The FCA's review of 40 firms said ‘firms did not always measure the impact’ of their changes.";
    expect(held(sentence)).toEqual([]);
  });

  it("lets a genuine \"or is that\" question through, and a digit that is not a result", () => {
    expect(run("Is it done weekly, or is that too often?")).not.toContain("tells");
    const email = message(
      "Saw you run the contact centre at Throttle Cover. Spring must be brutal, everyone back on the bikes at once and the team going from quiet to flat-out in a fortnight.\n\nI've been helping a few insurers with their 24/7 claims lines. Mostly though I'm curious how you handle it, do you flex the team or lean on the people who've been through it before?\n\nHow do you handle it when the season turns?",
      "the spring rush",
    );
    // "24/7" is provenance's business (no source carries it); it is not a result in the line about the rep.
    const found = gated(email, inputFor(ROB, "email1"));
    expect(found).not.toContain("product-in-email1");
    expect(found).not.toContain("aside");
  });
});

// ---------------------------------------------------------------------------
// Fix round 3 of #54 (Critic): a call's objection is the prospect's line, a deferral is not a set-up contrast, and
// "rise" or "increase" after an adjective is a noun.

describe("fix round 3 of #54", () => {
  const call = (objection: string, answer = "Fair enough. Who would be the right person to ask?"): OutreachOutput => ({
    kind: "call",
    talkingPoint: {
      openingLine: "Hi Sam, it's Alex from Conversant. I sent a note about the delay calls. Is now an alright time?",
      oneQuestion: "Who looks after the delay calls day to day?",
      openingLine2: "Alex again, from Conversant. Have you got a moment?",
      oneQuestion2: "Who decides which calls get reviewed?",
      listenFor: "Whether anyone listens back to the delay calls.",
      voicemail: "Hi Sam, it's Alex from Conversant. No need to call back, I'll follow up by email.",
      numberSource: "switchboard",
      objections: [{ objection, answer }],
    },
    opener: { ref: ROLE_REF, kind: "role_pain" },
    claims: [],
  });
  const runCall = (objection: string, answer?: string) => gated(call(objection, answer), inputFor(HARBOUR, "call"));

  it.each([
    "Not interested.",
    "Not right now.",
    "Not my area.",
    "Not a priority this year.",
    "Not for us.",
    "Not in the budget.",
    "Not at the moment.",
    "Not today.",
    "Not this quarter.",
    "Not me, try our QA lead.",
  ])("reads no contrast in the objection %s", (objection) => {
    expect(runCall(objection)).not.toContain("contrast");
  });

  it.each(["That's another thing we could look at later.", "Fair enough, that's a different conversation."])("reads no contrast in the answer %s", (answer) => {
    expect(runCall("Not interested.", answer)).not.toContain("contrast");
  });

  it("still holds the escalating fragment in the rep's own answer", () => {
    expect(runCall("We already review calls.", "Not a subset. All of them.")).toContain("contrast");
  });

  it("still holds a set-up contrast in a message", () => {
    const run = (sentence: string) => gated(message(`${sentence} Been wondering how the team keeps on top of the delay calls day to day. Who looks after that?`), inputFor(HARBOUR, "li_dm2"));
    expect(run("Whether the fix worked is a different conversation.")).toContain("contrast");
  });

  it.each([
    "Most of the complaints about the recent rise in premiums land with your team.",
    "Claims after the big increase in storm cover often need a second look.",
    "Complaints about last year's rise tend to cluster at renewal.",
    "Disputes over the steep increase in excess are hard calls to take.",
  ])("does not read a noun after an adjective as a trend: %s", (sentence) => {
    expect(held(sentence)).toEqual([]);
  });

  it.each(["Claims for storm damage rise every autumn.", "Complaint numbers in home insurance increase each quarter.", "Complaint volumes on motor climb in January."])(
    "still holds the base-form trend in %s",
    (sentence) => {
      expect(held(sentence)).toEqual([sentence]);
    },
  );
});
