import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SEQUENCE, outreachInputSchema, type EvidenceQuote, type OutreachInput, type TouchKind } from "../../agents/outreach/input.schema";
import { outputSchemaFor, type OutreachOutput } from "../../agents/outreach/output.schema";
import goodInput from "../../agents/outreach/fixtures/input.good.json";
import { agentsDir } from "@/lib/agents/definitions";
import { loadFacts } from "@/lib/facts/load";
import { loadNeverSay } from "@/lib/facts/neverSay";
import { liveFacts } from "@/lib/outreach/adapter";
import { TRUTH_CHECKS, gateFor, lineClaimsIn, lineVocabularyOf, lineWordsOf, unsupportedSourceClaims, type CohortDraft, type GateContext, type GateResult } from "@/lib/outreach/gates";
import { loadStandard } from "@/lib/outreach/standard";
import { hostOf } from "../../agents/_shared/item.schema";

/**
 * Outreach standard v3 (28 Sep 2026): the eight truth checks hold a draft, and nothing else does.
 *
 * The acceptance cases are the rep's two approved messages and the standard's worked sequence, with a made-up
 * person and firm of the same kind (a home and motor insurer): every touch passes as its own kind with no
 * hold. Then each truth check has a probe it holds and a clean pass beside it, and the style probes give
 * advice and never hold. Every person and firm here is made up.
 */

const facts = liveFacts(loadFacts("insights360", 2).facts);
const standard = loadStandard();
const base = outreachInputSchema.parse(goodInput);
const neverSay = loadNeverSay("insights360", 2);

const FCA: EvidenceQuote = {
  id: "fca-root-cause-not-measured",
  quote:
    "Firms did not always measure the impact of interventions they had made to ensure these were the right changes to make. This means that sometimes firms pursued actions even though they were not as effective as they might need to be.",
  sourceName: "the FCA's root cause review of 40 firms",
  url: "https://www.fca.org.uk/publications/good-and-poor-practice/complaints-and-root-cause-analysis",
};

/** The research's four groups, as a UK insurance pack's m04 has them; the confirmed group is the first. */
const HOME_GROUP = ["Home and buildings insurance", "Specialist and non-standard household insurance", "Managing general agents (household)"];
const MOTOR_GROUP = ["Motor insurance underwriting", "Managing general agents (motor and telematics)", "Personal lines insurance"];
const TRAVEL_GROUP = ["Travel insurance", "Travel assistance and medical assistance", "Specialist travel claims administration"];
const CLAIMS_GROUP = ["Third-party claims administration", "Outsourced claims handling", "Loss adjusting and claims management services"];
const campaignFor = (industries: string[]) => ({ industries, groups: [HOME_GROUP, MOTOR_GROUP, TRAVEL_GROUP, CLAIMS_GROUP] });

const REPORT = {
  id: "lookup-complaints-report",
  text: "Hollin Cover's complaints report for the first half of 2026 says 25% of complaints were closed within three days.",
  quote: "25% of complaints were closed within three days.",
  publishedAt: "2026-07-15",
  accessedAt: "2026-09-28",
  evidence: { urls: ["https://hollincover.example/how-to-complain"], primary: true, domains: ["hollincover.example"] },
  confidence: "strong" as const,
  about: "firm" as const,
};

type Who = { first: string; company: string; domain: string; title: string };
const JO: Who = { first: "Jo", company: "Hollin Cover", domain: "hollincover.example", title: "Head of Customer Relations" };

type Options = {
  who?: Who;
  role?: "runs" | "champions" | "signs";
  lookup?: Partial<OutreachInput["lookup"]>;
  campaign?: OutreachInput["campaign"];
  evidence?: EvidenceQuote[];
  thread?: OutreachInput["thread"];
};

function inputFor(kind: TouchKind, options: Options = {}): OutreachInput {
  const who = options.who ?? JO;
  const role = options.role ?? "champions";
  return outreachInputSchema.parse({
    ...base,
    person: { id: `p-${who.first.toLowerCase()}`, name: `${who.first} Pennant`, firstName: who.first, title: who.title, company: who.company, domain: who.domain, email: `${who.first.toLowerCase()}@${who.domain}` },
    sender: { firstName: "Sam", company: "Conversant" },
    buyerRole: { id: `role-${role}`, part: role, title: who.title, needs: "Show whether a complaint fix actually stuck, without adding checkers." },
    account: { company: who.company, domain: who.domain },
    campaign: options.campaign ?? campaignFor(HOME_GROUP),
    touch: { kind, ordinal: SEQUENCE.indexOf(kind) + 1, dueAt: "2026-09-28T09:00:00Z" },
    thread: options.thread ?? [],
    pack: { ...base.pack, evidence: options.evidence ?? [FCA] },
    facts,
    standard,
    lookup: { items: [REPORT], usable: true, searches: 1, fetches: 1, lines: ["home", "motor"], ...options.lookup },
    recentDrafts: [],
  });
}

const context = (cohort: CohortDraft[] = []): GateContext => ({ productNames: [facts.product], repName: "Sam", cohort, neverSay });
const run = (draft: OutreachOutput, kind: TouchKind, options: Options = {}, cohort: CohortDraft[] = []): GateResult => gateFor(outputSchemaFor(kind).parse(draft), inputFor(kind, options), context(cohort));
const holds = (result: GateResult) => result.tierA.map((finding) => finding.rule);
const advice = (result: GateResult) => result.tierB.map((finding) => finding.rule);

const message = (body: string, ask: string, subject?: string, claims: string[] = [], ref = "role-champions"): OutreachOutput => ({
  kind: "message",
  ...(subject === undefined ? {} : { subject }),
  body,
  ask,
  opener: { ref, kind: "role_pain" },
  claims,
});

/** A clean Email 1 around one sentence under test: the sentence, then the rep's own light line and question. */
const email1With = (sentence: string) =>
  message(
    `${sentence} I'd guess a fair few of the rest are the ones where someone has to go back and work out what actually got said on the call.\n\nI've been helping a few insurers get a proper look at calls like that. Curious how your team gets to the bottom of those ones at the moment?`,
    "Curious how your team gets to the bottom of those ones at the moment?",
    "your complaints calls",
  );

/** A clean Email 2 around one sentence under test. */
const email2With = (sentence: string, claims: string[] = []) =>
  message(`One other thing I was thinking about. ${sentence} I'd imagine that's the hard bit, knowing whether a fix actually stuck. Worth a chat?`, "Worth a chat?", undefined, claims);

// ---------------------------------------------------------------------------

describe("acceptance: the rep's approved messages and the worked sequence pass with no hold", () => {
  const exemplars = standard.exemplars;

  it("carries the worked sequence (every touch kind) and the rep's two approved messages", () => {
    expect(new Set(exemplars.map((exemplar) => exemplar.touch))).toEqual(new Set(SEQUENCE));
    expect(exemplars.filter((exemplar) => exemplar.shows.includes("approved"))).toHaveLength(2);
  });

  for (const [index, exemplar] of standard.exemplars.entries()) {
    it(`${exemplar.touch} #${index + 1} passes as its touch kind: ${exemplar.shows.slice(0, 60)}`, () => {
      const approved = exemplar.shows.includes("approved");
      // The approved messages were written to a motorcycle insurer's contact centre and a PI book lead; the worked sequence to Jo at Hollin Cover.
      const who: Who = approved
        ? exemplar.touch === "email1"
          ? { first: "Rob", company: "Throttle Cover", domain: "throttlecover.example", title: "Contact centre manager" }
          : { first: "Tess", company: "Hartwell & Crane", domain: "hartwellcrane.example", title: "Head of PI" }
        : JO;
      const kinds = exemplar.touch;
      const result = run(exemplar.draft, kinds, { who, role: approved ? "runs" : "champions", ...(approved ? { lookup: { items: [], usable: false, lines: [] } } : {}), campaign: campaignFor(approved ? MOTOR_GROUP : HOME_GROUP) });
      expect(result.tierA, JSON.stringify(result.tierA)).toEqual([]);
    });
  }

  it("the rep's approved anchors are the vendored voice anchors, word for word", () => {
    const anchors = JSON.parse(readFileSync(path.join(agentsDir(), "outreach", "voice", "anchors.json"), "utf8")).anchors as { wrote: string }[];
    const approved = exemplars.filter((exemplar) => exemplar.shows.includes("approved")).map((exemplar) => (exemplar.draft.kind === "message" ? exemplar.draft.body : ""));
    expect(approved[0]).toBe(anchors[0]!.wrote);
    expect(anchors[3]!.wrote).toContain(approved[1]!);
  });
});

describe("truth check 1: a price anywhere but the call script's price answer", () => {
  it("holds a price in an email", () => {
    expect(holds(run(email2With("It's £4.99 a seat a month, month to month."), "email2"))).toContain("price-in-message");
  });

  it("holds a price in a call's own lines, outside the objection answers", () => {
    const worked = standard.exemplars.find((exemplar) => exemplar.touch === "call")!.draft;
    if (worked.kind !== "call") throw new Error("the call exemplar is a call");
    const pricey = { ...worked, talkingPoint: { ...worked.talkingPoint, oneQuestion: "Would £4.99 a seat a month be worth a look?" } };
    expect(holds(run(pricey, "call"))).toContain("price-in-message");
  });

  it("passes the complete price answer in the call script", () => {
    const call = standard.exemplars.find((exemplar) => exemplar.touch === "call")!.draft;
    expect(holds(run(call, "call"))).toEqual([]);
  });

  it("holds a price fact cited on an email even when the words dodge a figure", () => {
    expect(holds(run(email2With("There's a plan for that, priced by the seat.", ["i360.price.per-seat-plans"]), "email2"))).toContain("price-in-message");
  });
});

describe("truth check 2: a product claim that is not in the facts file", () => {
  it("holds a claim id the facts file does not have", () => {
    expect(holds(run(email2With("That's what we built Insights360 for.", ["i360.feature.made-up"]), "email2"))).toContain("claim-id");
  });

  it("holds what the facts' own never-say list forbids", () => {
    const result = run(email2With("Insights360 scores every call in real time as it happens.", ["i360.feature.auto-qa-scoring-against-tenant-rules"]), "email2");
    expect(holds(result)).toContain("never-say");
  });

  it("passes a product sentence the live facts support", () => {
    const claim = "i360.feature.auto-qa-scoring-against-tenant-rules";
    expect(holds(run(email2With("That's mostly what we built Insights360 for, it scores every call against your own QA rules.", [claim]), "email2"))).toEqual([]);
  });
});

describe("truth check 3: a quote or finding not word for word from the evidence, or with no source named", () => {
  it("holds words in quote marks that no evidence item says", () => {
    expect(holds(run(email2With('The FCA said firms "keep ignoring what their complaints tell them" when it looked at root cause work.'), "email2"))).toContain("unsupported-source-claim");
  });

  it("holds an exact fragment whose source the sentence does not name", () => {
    expect(holds(run(email2With('One point I read was that firms "did not always measure the impact" of the changes they made.'), "email2"))).toContain("unsupported-source-claim");
  });

  it("holds a finding reported in the drafter's own words", () => {
    expect(holds(run(email2With("The FCA found that most firms never check whether a fix worked."), "email2"))).toContain("unsupported-source-claim");
  });

  it("holds a finding credited to a source the evidence does not carry", () => {
    expect(holds(run(email2With("A recent industry survey found that complaint fixes rarely stick."), "email2"))).toContain("unsupported-source-claim");
  });

  it("passes an exact fragment with its source named in the sentence", () => {
    const sentence = 'When the FCA looked at root cause work across 40 firms, one of its points was that firms "did not always measure the impact" of the changes they made.';
    expect(holds(run(email2With(sentence), "email2"))).toEqual([]);
  });

  it("passes an offer to send a source's write-up, which asserts nothing", () => {
    const ask = "If it'd help I can send over the FCA's write-up on root cause work, it's a decent read.";
    expect(holds(run(message(`No worries if now's not the time Jo. ${ask}`, ask), "li_dm2"))).toEqual([]);
  });
});

describe("truth check 4: invented experience, customers or results", () => {
  it("holds a manufactured relationship", () => {
    expect(holds(run(email1With("The teams I speak to all say complaints are the hardest calls to get back to."), "email1"))).toContain("invented-experience");
  });

  it("holds invented customers", () => {
    expect(holds(run(email2With("Our clients tend to find the answer is in the call itself."), "email2"))).toContain("invented-experience");
  });

  it("holds a result claimed in the light line about the rep", () => {
    const body =
      "Saw Hollin Cover's complaints report for the first half of the year, 25% closed within three days. I'd guess the rest are the ones where someone has to go back to the call.\n\nI've been helping a few insurers cut their complaint backlog in half. Curious how your team gets to the bottom of those ones at the moment?";
    expect(holds(run(message(body, "Curious how your team gets to the bottom of those ones at the moment?", "your complaints calls"), "email1"))).toContain("invented-experience");
  });

  it("passes the one allowed light line", () => {
    expect(holds(run(email1With("Saw Hollin Cover's complaints report for the first half of the year, 25% closed within three days."), "email1"))).toEqual([]);
  });
});

describe("truth check 5: a firm, person, number or line of business that is not in the data", () => {
  it("holds a firm the data does not name", () => {
    expect(holds(run(email1With("Saw you moved over to Hollin Cover from Pinecrest Mutual last year."), "email1"))).toContain("unsourced-name");
  });

  it("holds an unattributed number that is not in the data", () => {
    expect(holds(run(email1With("With something like 400 handlers on the phones, complaints must stack up fast."), "email1"))).toContain("unsourced-number");
  });

  it("passes a number the lookup carries", () => {
    expect(holds(run(email1With("Saw Hollin Cover's complaints report for the first half of the year, 25% closed within three days."), "email1"))).toEqual([]);
  });

  describe("the line of business (re-run 3: a travel firm told it was a motor insurer)", () => {
    const EMMA: Who = { first: "Emma", company: "Wayfarer Cover", domain: "wayfarercover.example", title: "Head of Complaints" };
    const travel = { who: EMMA, campaign: campaignFor(TRAVEL_GROUP) };
    const odd = email1With("Complaints at a motor insurer must be an odd job, most of it about claims that happened months ago.");

    it("holds it when the lookup says the firm is in travel", () => {
      const result = run(odd, "email1", { ...travel, lookup: { items: [], usable: false, lines: ["travel", "insurance"] } });
      expect(holds(result)).toContain("firm-line");
      expect(result.tierA.find((finding) => finding.rule === "firm-line")!.text).toMatch(/motor/);
    });

    it("holds it when the lookup found nothing and the campaign's group is travel", () => {
      expect(holds(run(odd, "email1", { ...travel, lookup: { items: [], usable: false, lines: [] } }))).toContain("firm-line");
    });

    it("passes the firm's own line", () => {
      const fine = email1With("Complaints at a travel insurer must be an odd job, most of it about claims that happened months ago.");
      expect(holds(run(fine, "email1", { ...travel, lookup: { items: [], usable: false, lines: ["travel", "insurance"] } }))).toEqual([]);
    });

    it("holds the light line naming a line of business the campaign is not aimed at", () => {
      const aside = message(
        "Saw you look after complaints at Wayfarer Cover. Travel claims must be a strange mix, most of it paperwork and then every so often someone stuck abroad.\n\nI've been helping a few motor insurers get a proper look at calls like that. Curious how your team handles the stuck-abroad ones at the moment?",
        "Curious how your team handles the stuck-abroad ones at the moment?",
        "stuck abroad calls",
      );
      expect(holds(run(aside, "email1", { ...travel, lookup: { items: [], usable: false, lines: ["travel"] } }))).toContain("firm-line");
    });

    it("reads the light line against the firm's own lines, never the campaign's (28 Sep)", () => {
      const aside = message(
        "Saw you look after complaints at Wayfarer Cover. Travel claims must be a strange mix, most of it paperwork and then every so often someone stuck abroad.\n\nI've been helping a few travel insurers get a proper look at calls like that. Curious how your team handles the stuck-abroad ones at the moment?",
        "Curious how your team handles the stuck-abroad ones at the moment?",
        "stuck abroad calls",
      );
      // The search found the firm is a travel insurer: "travel insurers" is true of it.
      expect(holds(run(aside, "email1", { ...travel, lookup: { items: [], usable: false, lines: ["travel insurance"] } }))).toEqual([]);
      // The search found home only: "travel" is a line the firm is not known to be in, whatever the campaign says.
      expect(holds(run(aside, "email1", { ...travel, lookup: { items: [], usable: false, lines: ["home"] } }))).toContain("firm-line");
    });

    it("takes its vocabulary from the data, not a list: a lending campaign's lines work the same way", () => {
      const lending = { industries: ["Buy-to-let mortgage lending"], groups: [["Buy-to-let mortgage lending", "Residential mortgage finance"], ["Commercial property bridging finance"], ["Asset finance for vehicles"]] };
      const { own, all, sector } = lineVocabularyOf(lending);
      expect(sector).toEqual(["finance"]);
      expect(own).toEqual(expect.arrayContaining(["buy", "let", "mortgage", "lending", "residential"]));
      expect(all).toEqual(expect.arrayContaining(["mortgage", "bridging", "asset"]));
      // The confirmed group's own words never hold: "a mortgage lender" is this campaign's kind of firm.
      expect(lineClaimsIn("Must be busy at a mortgage lender right now.", all.filter((word) => !own.includes(word)))).toEqual([]);
      expect(lineClaimsIn("Must be busy at a bridging lender right now.", all)).toEqual(["bridging"]);
      expect(lineWordsOf(["Specialist and non-standard household insurance"])).toEqual(["household", "insurance"]);
    });

    it("has nothing to contradict with one group and no lookup lines", () => {
      expect(lineVocabularyOf({ industries: ["Insurance"], groups: [["Insurance"]] }).all).toEqual([]);
    });

    it("reads a line only as a firm's: ordinary words in the labels never hold (review of this PR)", () => {
      const labels = { industries: MOTOR_GROUP, groups: [MOTOR_GROUP, TRAVEL_GROUP, HOME_GROUP, CLAIMS_GROUP, ["Outsourced contact centre services", "In-house claims handling for property"]] };
      for (const sentence of [
        "Been wondering whether you handle complaints in-house or through outsourced providers, it always seems to split people.",
        "I would guess the contact centre side is where it bites hardest for your team.",
        "Been thinking about the property side of things and how much of it comes back as a complaint.",
      ]) {
        expect(holds(run(email1With(sentence), "email1", { campaign: labels, lookup: { lines: [] } })), sentence).not.toContain("firm-line");
      }
    });

    it("never takes a question as a claim about the firm", () => {
      const ask = "Is Wayfarer mostly a travel firm, or do you do motor as well?";
      const probe = message(`Saw you look after complaints at Wayfarer Cover and wondered about the split. ${ask}`, ask);
      expect(holds(run(probe, "li_dm2", { who: EMMA, campaign: campaignFor(TRAVEL_GROUP), lookup: { lines: ["travel"] } }))).not.toContain("firm-line");
    });
  });
});

describe("the review of this PR: false holds and false passes it found", () => {
  it("never lets a look-alike host pass as the source it names (Sentinel CWE-345)", () => {
    const spoof: EvidenceQuote = { ...FCA, id: "spoof", sourceName: "fca-insight-hub.com", url: "https://fca-insight-hub.com/post" };
    const sentence = 'When the FCA looked at root cause work, one of its points was that firms "did not always measure the impact" of the changes they made.';
    expect(holds(run(email2With(sentence), "email2", { evidence: [spoof] }))).toContain("unsupported-source-claim");
    expect(holds(run(email2With(sentence.replace("the FCA", "FCA Insight Hub")), "email2", { evidence: [spoof] }))).not.toContain("unsupported-source-claim");
  });

  it("never reads the rep's or the reader's own finding as a source's", () => {
    for (const sentence of ["I found most teams only get to the call once the complaint has landed.", "Saw the QA lead said it was mostly manual.", "I reckon your team reported fewer of those last year."]) {
      expect(holds(run(email2With(sentence), "email2")), sentence).not.toContain("unsupported-source-claim");
    }
  });

  it("never reads \"month to month\" as a price", () => {
    expect(holds(run(email2With("I'd guess volumes swing a lot month to month."), "email2"))).not.toContain("price-in-message");
  });

  it("lets the light line name only a kind of firm the rep has said they help (28 Sep)", () => {
    const vets = { industries: ["Veterinary practices"], groups: [["Veterinary practices"], ["Veterinary hospitals and referral centres"]] };
    const who: Who = { first: "Morgan", company: "Kestrel Vets", domain: "kestrelvets.example", title: "Practice Manager" };
    const lookup = { items: [], usable: false, lines: [] };
    const aside = (kind: string) =>
      message(
        `Saw you manage the practice at Kestrel Vets. Mornings must be a scramble, the phones going while half the team is in consults and someone is always waiting on a callback.\n\nI've been helping a few ${kind} get a proper look at calls like that. Curious how the front desk keeps up at the moment?`,
        "Curious how the front desk keeps up at the moment?",
        "the morning phones",
      );
    // "vets" and "practices" would be a claim about the rep's work nobody has confirmed; "firms" is always true.
    expect(holds(run(aside("vets"), "email1", { who, campaign: vets, lookup }))).toContain("invented-experience");
    expect(holds(run(aside("practices"), "email1", { who, campaign: vets, lookup }))).toContain("invented-experience");
    expect(holds(run(aside("firms"), "email1", { who, campaign: vets, lookup }))).toEqual([]);
  });
});

describe("the 28 Sep trigger round: real drafts", () => {
  it("holds a named source paraphrased with a few of its words but no quote marks", () => {
    // Tracey's Email 2 in the 28 Sep trigger round, word for word.
    const sentence = "One thing I keep turning over, the FCA's review of complaints handling flagged that firms often can't show whether a fix to a root cause actually worked, mostly because there's no proper record of what happened across the calls in the first place.";
    expect(unsupportedSourceClaims([sentence], [FCA])).toEqual([sentence]);
    const quoted = 'When the FCA looked at root cause work across 40 firms, one of its points was that firms "did not always measure the impact" of the changes they made.';
    expect(unsupportedSourceClaims([quoted], [FCA])).toEqual([]);
  });
});

describe("the 28 Sep final trigger round: real drafts", () => {
  it("holds a named body's claim that is not in its exact words, with or without the campaign's evidence", () => {
    for (const sentence of [
      "The FCA's complaints handling review this year said firms often can't show a fix actually worked, only that they made one.",
      "The FCA's complaints handling review this year said root causes aren't always recorded properly.",
      "The regulator wants firms to show root causes and prove a fix actually worked.",
      // Leon's Email 2 in the final round, word for word.
      "The FCA's review of complaints handling this year flagged something familiar, firms often can't show root causes were recorded consistently, or that a fix actually worked once it was made.",
    ]) {
      expect(unsupportedSourceClaims([sentence], [])).toEqual([sentence]);
      expect(unsupportedSourceClaims([sentence], [FCA])).toEqual([sentence]);
    }
  });

  it("reads only real bodies as sources, never the rep's own shorthand (Critic and Sentinel, #56 r3)", () => {
    for (const sentence of [
      "An MGA I spoke to last week said the same thing.",
      "NPS shows you the score, not the reason behind it.",
      "Every FNOL team I've sat with said the same.",
      "The CRM shows what was logged, not what was said.",
      "The MD wants a straight answer on why complaints moved.",
    ]) {
      expect(unsupportedSourceClaims([sentence], [FCA])).toEqual([]);
    }
  });

  it("never reads the rep's or reader's verb as the named body's (Critic, #56 r6)", () => {
    const sentence = "Ahead of the FCA's next complaints data return your team probably wants a clearer picture.";
    expect(unsupportedSourceClaims([sentence], [])).toEqual([]);
  });

  it("exempts a document offer only from the offer on, never a claim made before it", () => {
    for (const sentence of [
      "The FCA says most firms can't show a fix worked, happy to send over the report.",
      "The regulator wants firms to prove a fix worked, happy to share the guidance.",
    ]) {
      expect(unsupportedSourceClaims([sentence], [FCA])).toEqual([sentence]);
    }
  });

  it("keeps an offer from carrying a claim, before or inside it (Critic, #56 r4)", () => {
    for (const sentence of [
      "Happy to share the FCA review that says most firms can't show a fix worked.",
      "Per the FCA's root cause work most firms can't show a fix worked, happy to send the review.",
    ]) {
      expect(unsupportedSourceClaims([sentence], [FCA])).toEqual([sentence]);
    }
    expect(unsupportedSourceClaims(["Happy to send over the FCA's write-up on root cause work if it's useful."], [FCA])).toEqual([]);
  });

  it("reads a firm whose name is a web address as a name, not a link", () => {
    const who: Who = { first: "Alex", company: "Confused.com", domain: "confused.com", title: "Head of Complaints" };
    const ask = "How does your team get back to what was said on the call at the moment?";
    const draft = message(`Saw you look after complaints at Confused.com. Comparison calls must be a strange mix, most of them quick and then the odd one that gets complicated.\n\nI've been helping a few firms get a proper look at calls like that. ${ask}`, ask, "the complicated calls");
    expect(holds(run(draft, "email1", { who }))).not.toContain("link");
    const linked = message(`Saw insurancetimes.co.uk had a piece on your team this year, and it made me curious about the calls behind it.\n\nI've been helping a few firms get a proper look at calls like that. ${ask}`, ask, "the piece");
    expect(holds(run(linked, "email1", { who }))).toContain("link");
    // Whatever follows the address, and whatever its case.
    for (const where of ["on insurancetimes.co.uk.", "on insurancetimes.co.uk, and", "(insurancetimes.co.uk)", "at insurancetimes.co.uk/news/team", "in InsuranceTimes.co.uk", "in FT.com"]) {
      const text = `Saw a piece ${where} about your team this year, and it made me curious about the calls behind it.\n\nI've been helping a few firms get a proper look at calls like that. ${ask}`;
      expect(holds(run(message(text, ask, "the piece"), "email1", { who }))).toContain("link");
    }
  });

  it("does not read the reader's own team or a document offer as a source", () => {
    for (const sentence of [
      "When QA found the same issue twice, who picked it up?",
      "Happy to send over what the FCA said about root cause work in its review this year.",
      "Saw you took over as COO at Policy Expert earlier this year.",
    ]) {
      expect(unsupportedSourceClaims([sentence], [FCA])).toEqual([]);
    }
  });
});

describe("fix round 2: Critic's and Sentinel's probes", () => {
  const source = "unsupported-source-claim";

  it("holds a source named as holding a view, whatever the verb (check 3, back to main)", () => {
    for (const sentence of [
      "The FCA flagged that firms don't measure whether their fixes work.",
      "The FCA pointed out that most firms never check whether a fix stuck.",
      "The FCA thinks firms rarely measure the impact of what they change.",
      "The FCA's view is that firms rarely check a fix worked.",
      "The FCA found firms rarely measure the impact.",
    ]) {
      expect(holds(run(email2With(sentence), "email2")), sentence).toContain(source);
    }
  });

  it("passes the source's exact fragment, the offer of its write-up, and a claim naming no source", () => {
    for (const sentence of [
      'The FCA\'s view is that firms "did not always measure the impact" of the changes they made.',
      "I can send over the FCA's write-up on root cause work if it's useful.",
      "Happy to share the FCA's review of root cause work.",
      "Research suggests most complaints come back to one call.",
    ]) {
      expect(holds(run(email2With(sentence), "email2")), sentence).not.toContain(source);
    }
  });

  it("never reads a quote from the reader's own site as a third party's view", () => {
    const who: Who = { first: "Kit", company: "Kestrel", domain: "kestrel.example", title: "Head of Complaints" };
    const own: EvidenceQuote = { id: "own", quote: "We aim to resolve every complaint within eight weeks.", sourceName: "kestrel.example", url: "https://kestrel.example/complaints" };
    expect(holds(run(email2With("Kestrel handles its complaints in house."), "email2", { who, evidence: [FCA, own] }))).not.toContain(source);
  });

  it("never lets a same-label host on another TLD pass as the body (Sentinel, base behaviour)", () => {
    const sentence = 'The FCA said "firms did not always measure the impact" of the changes they made.';
    for (const url of ["https://fca.com/post", "https://fca.io/post", "https://fca.co.uk/post", "https://news.fca.net/post"]) {
      const spoof: EvidenceQuote = { ...FCA, id: "spoof", sourceName: hostOf(url), url };
      expect(holds(run(email2With(sentence), "email2", { evidence: [spoof] })), url).toContain(source);
    }
    const real: EvidenceQuote = { ...FCA, sourceName: "fca.org.uk" };
    expect(holds(run(email2With(sentence), "email2", { evidence: [real] }))).not.toContain(source);
    const ombudsman: EvidenceQuote = { ...FCA, id: "fos-spoof", sourceName: "ombudsman.co.uk", url: "https://ombudsman.co.uk/post" };
    expect(holds(run(email2With(sentence.replace("The FCA", "The ombudsman")), "email2", { evidence: [ombudsman] }))).toContain(source);
  });

  it("holds invented results and customers for any kind of firm (check 4)", () => {
    for (const sentence of [
      "We've helped a few insurers halve their complaint backlog.",
      "I've helped three insurers cut complaint handling time by a third.",
      "Insurers we work with tell me the same thing.",
      "Other insurers I speak to say the same.",
      "Most of the insurers I talk to struggle with this.",
      "Lenders we work with see the same pattern.",
    ]) {
      expect(holds(run(email2With(sentence), "email2")), sentence).toContain("invented-experience");
    }
  });

  it("still passes the approved light line, and \"unless I talk to\" is not a customer", () => {
    expect(holds(run(email1With("Most complaints come back to one call."), "email1"))).not.toContain("invented-experience");
    expect(holds(run(email2With("Hard to say unless I talk to the team first."), "email2"))).not.toContain("invented-experience");
    expect(holds(run(email2With("I've been helping a few insurers cut through calls like that."), "email2"))).not.toContain("invented-experience");
  });

  it("holds easy rewordings of a firm put in the wrong line (check 5)", () => {
    const EMMA: Who = { first: "Emma", company: "Wayfarer Cover", domain: "wayfarercover.example", title: "Head of Complaints" };
    const travel = { who: EMMA, campaign: campaignFor(TRAVEL_GROUP), lookup: { items: [], usable: false, lines: ["travel"] } };
    for (const sentence of ["Motor complaints at Wayfarer Cover must keep your team busy.", "Complaints on the motor side must keep your team busy."]) {
      expect(holds(run(email1With(sentence), "email1", travel)), sentence).toContain("firm-line");
    }
    expect(holds(run(email1With("Travel complaints at Wayfarer Cover must keep your team busy."), "email1", travel))).not.toContain("firm-line");
  });
});

describe("truth check 6: a colleague at the same firm already sent the same evidence item", () => {
  const sentence = 'When the FCA looked at root cause work across 40 firms, one of its points was that firms "did not always measure the impact" of the changes they made.';
  const colleague: CohortDraft = { body: `Something I read. ${sentence} Worth a chat?`, ask: "Worth a chat?", sameAccount: true, personId: "p-other", touch: "email2" };

  it("holds the same item to a second person at the firm", () => {
    expect(holds(run(email2With(sentence), "email2", {}, [colleague]))).toContain("colleague-evidence");
  });

  it("passes the same item to someone at another firm", () => {
    expect(holds(run(email2With(sentence), "email2", {}, [{ ...colleague, sameAccount: false }]))).toEqual([]);
  });
});

describe("truth check 7: a link, a gender guess or the drafting tool's name", () => {
  it("holds a link in any touch", () => {
    expect(holds(run(email2With("There's a write-up at www.fca.org.uk if it helps."), "email2"))).toContain("link");
  });

  it("holds a gendered pronoun about the prospect", () => {
    expect(holds(run(email1With("Saw Hollin Cover's complaints report, and she must be proud of the 25% closed within three days."), "email1"))).toContain("gendered-pronoun");
  });

  it("refuses the tool's name at the schema, so the touch never reaches the checks", () => {
    expect(outputSchemaFor("email2").safeParse(email2With("I found you through Relay.")).success).toBe(false);
  });

  it("passes their name and \"they\"", () => {
    expect(holds(run(email1With("Saw Hollin Cover's complaints report, and they closed 25% within three days."), "email1"))).toEqual([]);
  });
});

describe("truth check 8: a touch that is empty, the wrong shape or over its length", () => {
  const long = (count: number) => Array.from({ length: count }, (_, index) => (index === 0 ? "Complaints" : "word")).join(" ");

  it("holds each touch past its limit, and passes it at the limit", () => {
    const limits: [TouchKind, number][] = [
      ["email2", 90],
      ["breakup", 50],
      ["li_dm2", 50],
      ["li_dm", 70],
      ["email1", 100],
    ];
    for (const [kind, max] of limits) {
      const ask = "Worth a chat?";
      const over = message(`${long(max - 2)}. ${ask}`, ask, kind === "email1" ? "your complaints calls" : undefined);
      const at = message(`${long(max - 3)}. ${ask}`, ask, kind === "email1" ? "your complaints calls" : undefined);
      expect(holds(run(over, kind)), kind).toContain("length");
      expect(holds(run(at, kind)), kind).not.toContain("length");
    }
  });

  it("holds Email 1 under 50 words and the LinkedIn message under 40", () => {
    expect(holds(run(message("Saw the complaints report. Curious how it went?", "Curious how it went?", "your report"), "email1"))).toContain("length");
    expect(holds(run(message("Thanks for connecting Jo. Curious how it went?", "Curious how it went?"), "li_dm"))).toContain("length");
  });

  it("holds a connection note over 200 characters", () => {
    const ask = "Would be good to connect.";
    expect(holds(run(message(`${"Hi Jo, sent you a note about complaints at Hollin Cover. ".repeat(4)}${ask}`, ask), "li_connect"))).toContain("length");
  });

  it("holds a call script missing its voicemail or its second call, and a message where a call belongs", () => {
    const call = standard.exemplars.find((exemplar) => exemplar.touch === "call")!.draft;
    if (call.kind !== "call") throw new Error("the call exemplar is a call");
    const rest: Partial<typeof call.talkingPoint> = { ...call.talkingPoint };
    delete rest.voicemail;
    delete rest.openingLine2;
    expect(holds(run({ ...call, talkingPoint: rest as typeof call.talkingPoint }, "call"))).toEqual(expect.arrayContaining(["voicemail", "second-call"]));
    expect(holds(gateFor(email2With("A plain point."), inputFor("call"), context()))).toEqual(["kind"]);
  });
});

describe("style is advice on the card, never a hold", () => {
  const probes: [string, string, string][] = [
    ["contrast", "It isn't a sampling problem, it's a memory problem.", "contrast"],
    ["the tell list", "We can help you leverage every conversation to streamline the review.", "tells"],
    ["American spelling", "Most teams organize the review around the calls they can find.", "spelling"],
    ["an exclamation mark", "Complaints are a tough job at the best of times!", "exclamation"],
    ["a time ask", "Would you have fifteen minutes next week to talk it through.", "time-ask"],
  ];

  for (const [name, sentence, rule] of probes) {
    it(`${name}: advice, and no hold`, () => {
      const result = run(email2With(sentence), "email2");
      expect(holds(result)).toEqual([]);
      expect(advice(result)).toContain(rule);
    });
  }

  it("stacked hedges and the rep's own hedges are neither held nor flagged", () => {
    const result = run(email2With("I think it's probably fair to say I reckon it might be the hardest bit."), "email2");
    expect(result.tierA).toEqual([]);
    expect(advice(result)).not.toContain("hedges");
  });

  it("a product in Email 1 and a long subject are advice", () => {
    const result = run(
      message(
        "Saw Hollin Cover's complaints report for the first half of the year, 25% closed within three days. I'd guess the rest are the ones where someone has to go back to the call.\n\nThat's what Insights360 is for. Curious how your team gets to the bottom of those ones at the moment?",
        "Curious how your team gets to the bottom of those ones at the moment?",
        "a long subject line about your complaints",
      ),
      "email1",
    );
    expect(holds(result)).toEqual([]);
    expect(advice(result)).toEqual(expect.arrayContaining(["product-in-email1", "subject"]));
  });

  it("repetition across the campaign is advice", () => {
    const body = email1With("Saw Hollin Cover's complaints report for the first half of the year, 25% closed within three days.");
    if (body.kind !== "message") throw new Error("a message");
    const others: CohortDraft[] = ["p1", "p2"].map((personId) => ({ body: body.body, ask: body.ask, sameAccount: false, personId, touch: "email1" }));
    const result = run(body, "email1", {}, others);
    expect(holds(result)).toEqual([]);
    expect(advice(result)).toEqual(expect.arrayContaining(["cohort-opening", "cohort-ask", "cohort-sentence"]));
  });
});

describe("the checks' accounting", () => {
  it("maps every Tier A rule to one of the eight truth checks", () => {
    expect(new Set(Object.values(TRUTH_CHECKS))).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8]));
  });

  it("never holds for a rule outside the eight", () => {
    const cases: [OutreachOutput, TouchKind][] = [
      [email2With("It's £4.99 a seat a month."), "email2"],
      [email2With("The FCA found that most firms never check."), "email2"],
      [email1With("The teams I speak to say so."), "email1"],
      [email2With("There's a write-up at www.example.org if it helps."), "email2"],
    ];
    for (const [draft, kind] of cases) for (const rule of holds(run(draft, kind))) expect(TRUTH_CHECKS[rule], rule).toBeDefined();
  });
});

describe("the standard and the prompt, v3", () => {
  const prompt = readFileSync(path.join(agentsDir(), "outreach", "prompt.md"), "utf8");

  it("loads version 3: eight short rules, no gives, the tell list", () => {
    expect(standard.version).toBe(3);
    expect(standard.rules).toHaveLength(8);
    expect(standard).not.toHaveProperty("gives");
    expect(standard.bannedLexicon).not.toContain("thanks for connecting");
  });

  it("keeps the prompt to about a thousand words", () => {
    expect(prompt.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(1050);
  });

  it("writes nothing specific to one campaign into the prompt or the rules", () => {
    for (const text of [prompt, ...standard.rules]) {
      expect(text).not.toMatch(/\bFCA\b|ombudsman|22 October|general admin|\bmotor\b|£|\d,\d{3}/i);
    }
  });

  it("asks for no opt-out line anywhere", () => {
    for (const text of [prompt, ...standard.rules, readFileSync(path.join(agentsDir(), "outreach", "definition.md"), "utf8").split("(v3, signed)")[1]!]) {
      expect(text).not.toMatch(/If this isn't relevant, just reply/);
    }
  });

  it("lets \"Thanks for connecting\" open the LinkedIn message", () => {
    expect(prompt).toMatch(/"Thanks for connecting" may open it/);
    const ask = "Does your team feel that swing much, or is it fairly steady right through the year?";
    const opener = message(
      `Thanks for connecting Jo. With home and motor under one roof I'd imagine complaints come in waves, storm claims one month, renewals the next. ${ask}`,
      ask,
    );
    const result = run(opener, "li_dm");
    expect(result.tierA).toEqual([]);
    expect(advice(result)).not.toContain("tells");
  });
});
