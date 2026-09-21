import type { Event, Job } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { completeModule, researchRawSchema, type PackShape } from "../../agents/research/output.schema";
import fixture from "../../fixtures/research/smoke-a-insurance-direct-2026-09-13.json";
import { nameFrom, toResearchBrief, type ResearchBrief } from "@/lib/campaigns/brief";
import { overviewOf } from "@/lib/campaigns/overview";
import { buyerLanguage, sourceCount, verificationQuestions } from "@/lib/campaigns/packSelectors";
import { readable, researchSections } from "@/lib/campaigns/research";
import { toCampaignResearch } from "@/lib/campaigns/view";
import type { CampaignRecord } from "@/lib/repo/campaigns";

import { briefFields, partialPack, stoppedBrief, stoppedPack } from "./campaignPacks";

/**
 * "What Relay learned" (task 19), read from the smoke-test pack (the first
 * live run through the app, anonymised; see `campaignOverview.test.ts`).
 *
 * What is pinned: the research page and the Overview read the pack the same
 * way; nothing research wrote twice is shown twice; nothing internal reaches
 * a rep; and a run cut short draws what it has and names what it lacks.
 */
const pack = researchRawSchema.parse(fixture.pack);
const research = researchSections(pack);
const overview = overviewOf(pack);
const same = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
const duplicates = (list: string[]) => list.filter((entry, index) => list.findIndex((other) => same(other) === same(entry)) !== index);

describe("readable: research's words with the internal names taken out", () => {
  it("drops a cited fact id, and a list of them", () => {
    expect(readable("Anything real-time (i360.boundary.not-real-time).")).toBe("Anything real-time.");
    expect(readable("Open prices (i360.price.per-seat-plans, i360.price.no-seat-minimum-no-annual-lock-in).")).toBe("Open prices.");
    expect(readable("the one thing it does not do (`i360.boundary.no-compliance-evidence-packs`). Next")).toBe("the one thing it does not do. Next");
  });

  it("reads a reference to the facts file as Relay's facts, and names a part of the pack as the part of the page", () => {
    expect(readable("Facts file items i360.boundary.no-a, i360.feature.b-c and i360.feature.d-e.")).toBe("Relay's facts about the product.");
    expect(readable("combined with facts file item i360.boundary.no-group-dashboard.")).toBe("combined with Relay's facts about the product.");
    expect(readable("the contact rules in m12")).toBe("the contact rules in ‘Contact rules’");
    expect(readable("for the home-claims archetypes, and the champion persona")).toBe("for the home-claims kinds of buyer, and the champion role");
  });

  it("leaves a domain, a url and ordinary words alone", () => {
    const text = "See sabre.co.uk and https://www.fca.org.uk/data/complaints-data for the m-class personal lines.";
    expect(readable(text)).toBe(text);
  });

  it("never takes a host whose middle label is a fact kind for a fact id", () => {
    for (const text of [
      "Read trust.compliance.io for the policy.",
      "See docs.integration.my-site.com today.",
      "The page https://help.proof.example-site.org/audit says so.",
      "Mail qa@team.feature.some-host.net about it.",
    ]) {
      expect(readable(text)).toBe(text);
    }
    expect(readable("Only i360.integration.3cx-automated-feed and i360.price.per-seat-plans, as the facts say.")).toBe(
      "Only a fact about the product, as the facts say.",
    );
  });
});

describe("The market and why now", () => {
  const events = research.market.timeline.filter((entry) => entry.kind === "event");
  const triggers = research.market.timeline.filter((entry) => entry.kind === "trigger");

  it("puts every dated event on the timeline once, in date order", () => {
    const m13 = completeModule(pack, "m13")!.entries;
    expect(events.map((entry) => entry.key).sort()).toEqual(m13.map((entry) => entry.id).sort());
    const dates = research.market.timeline.map((entry) => entry.date ?? "9999");
    expect(dates).toEqual([...dates].sort());
  });

  it("shows every trigger once: under the event of its day, or on its own when no event has that day", () => {
    const shown = [...triggers.map((entry) => entry.key), ...events.flatMap((entry) => (entry.kind === "event" ? entry.alsoReported.map((item) => item.id) : []))];
    expect(shown.sort()).toEqual(completeModule(pack, "m01")!.triggers.map((trigger) => trigger.id).sort());
    for (const trigger of triggers) expect(events.some((event) => event.date === trigger.date)).toBe(false);
    // The FCA's 18 December 2025 statement is one event, with the two triggers research read from it under it.
    const december = events.find((event) => event.date === "2025-12-18");
    expect(december?.kind === "event" ? december.alsoReported : []).toHaveLength(2);
  });

  it("does not say a coming date twice: a line research dated to a day the timeline has is not repeated", () => {
    const lines = completeModule(pack, "m01")!.nextSixMonths;
    expect(lines).toHaveLength(5);
    expect(research.market.timeline.filter((entry) => entry.date === "2026-10-22")).toHaveLength(1);
    expect(research.market.alsoExpected.some((line) => line.startsWith("22 October 2026"))).toBe(false);
    expect(research.market.alsoExpected).toEqual(lines.filter((line) => line.startsWith("Through 2026") || line.startsWith("Q3 2026")));
  });

  it("splits what has happened from what is coming at the day research read its sources", () => {
    expect(research.researchedOn).toBe("2026-09-13");
    expect(research.market.timeline.find((entry) => entry.date === "2026-07-31")?.comingUp).toBe(false);
    expect(research.market.timeline.find((entry) => entry.date === "2026-09-24")?.comingUp).toBe(true);
  });

  it("marks a venue that is also a dated event as on the timeline, and only then", () => {
    const venues = research.gather.kinds.flatMap((kind) => kind.entries);
    expect(venues.find((venue) => venue.name.startsWith("CILA"))?.onTimeline).toBe(true);
    expect(venues.find((venue) => venue.name.startsWith("FCA Good and Poor"))?.onTimeline).toBe(false);
  });
});

describe("Who to target", () => {
  it("lists the groups in the Overview's order, with the rank-1 group's own reason", () => {
    expect(research.who.groups.map((group) => group.name)).toEqual(overview.groups.map((group) => group.name));
    expect(research.who.groups[0]?.rank).toBe(1);
    expect(research.who.groups[0]?.whyNow).toBe(overview.startWith?.whyNow);
  });

  it("shows a boundary two groups echo, and no part of the market states, once, under the first", () => {
    const twice = JSON.parse(JSON.stringify(pack)) as PackShape;
    const m04 = completeModule(twice, "m04")!;
    const line = "Firms that are part of a wider group must be sized as the UK claims unit, not the group.";
    m04.perArchetype[1]!.hardFiltersEchoed.push(line);
    m04.perArchetype[2]!.hardFiltersEchoed.push(line);
    const drawn = researchSections(twice).who.groupBoundaries;
    expect(drawn.flatMap((entry) => entry.lines).filter((shown) => shown === line)).toHaveLength(1);
  });

  it("shows each hard boundary once, however many parts of the pack echo it", () => {
    const b = research.who.boundaries!;
    const lines = [...b.geography, ...(b.size === null ? [] : [b.size]), ...b.sectorsIn, ...b.sectorsOut, ...b.firmsOut, ...b.other, ...research.who.groupBoundaries.flatMap((entry) => entry.lines)];
    expect(duplicates(lines)).toEqual([]);
    const shown = new Set([...lines, ...research.prove.dontClaim.lead, ...research.prove.dontClaim.product, ...research.prove.dontClaim.brand].map(same));
    for (const targeting of completeModule(pack, "m04")!.perArchetype) {
      for (const echoed of targeting.hardFiltersEchoed) expect(shown.has(same(readable(echoed)))).toBe(true);
    }
  });
});

describe("Pains and buyer language", () => {
  it("never puts anyone else's words under the buyer's, and names whose they are", () => {
    for (const group of research.pains.groups) {
      expect(group.buyerWords.every((phrase) => !phrase.notBuyer)).toBe(true);
      expect(group.otherVoices.every(({ phrase, voice }) => phrase.notBuyer && voice !== "practitioner")).toBe(true);
    }
    const first = research.pains.groups[0]!;
    const own = buyerLanguage(pack, completeModule(pack, "m03")!.archetypes.find((group) => group.name === first.name)!.id);
    expect(first.buyerWords.map((phrase) => phrase.id)).toEqual(own.buyer.map((phrase) => phrase.id));
    expect(first.otherVoices.map(({ phrase }) => phrase.id)).toEqual(own.others.map((phrase) => phrase.id));
  });

  it("gives the rank-1 group the Overview's pains", () => {
    expect(research.pains.groups[0]?.pains.map((pain) => pain.id)).toEqual(overview.pain?.pains.map((pain) => pain.id));
  });
});

describe("What to say", () => {
  it("leads each group with the angle the Overview leads with, and shows no angle twice", () => {
    const first = research.say.groups[0]!;
    expect(first.angles[0]?.lead).toBe(true);
    expect(first.angles[0]?.text).toBe(overview.startWith?.angle);
    for (const group of research.say.groups) {
      expect(group.angles.filter((angle) => angle.lead)).toHaveLength(1);
      expect(duplicates(group.angles.map((angle) => angle.text))).toEqual([]);
    }
  });

  it("shows a line from the sources once, under the first group it is for", () => {
    expect(duplicates(research.say.groups.flatMap((group) => group.verbatim.map((line) => line.quote ?? line.text)))).toEqual([]);
    const all = completeModule(pack, "m09")!.perArchetype.flatMap((group) => group.verbatim);
    expect(research.say.groups.flatMap((group) => group.verbatim)).toHaveLength(all.length - 1);
  });
});

describe("What we can answer and prove", () => {
  it("puts every constraint research wrote in one Don't claim, each once", () => {
    const d = research.prove.dontClaim;
    expect(d.lead).toEqual(completeModule(pack, "m00")!.mustNotLead.map(readable));
    expect(d.product).toEqual(completeModule(pack, "execSummary")!.productConstraints.map(readable));
    expect(d.brand).toEqual(completeModule(pack, "m09")!.brandConstraints.map(readable));
    expect(d.imply.map((entry) => entry.text)).toEqual(completeModule(pack, "m07")!.mappings.flatMap((mapping) => (mapping.mustNotImply === undefined ? [] : [readable(mapping.mustNotImply)])));
    expect(duplicates([...d.lead, ...d.product, ...d.brand, ...d.imply.map((entry) => entry.text), ...d.proof.map((entry) => entry.text)])).toEqual([]);
    // A capability's limit is only there: the answer itself carries none.
    for (const group of research.prove.groups) for (const answer of group.answers) expect(Object.keys(answer)).not.toContain("mustNotImply");
  });

  it("answers or names as unanswered every pain, pointing at it by place", () => {
    const refs = research.prove.groups.flatMap((group) => [...group.answers, ...group.unanswered].map((entry) => entry.pain));
    const pains = completeModule(pack, "m05")!.perArchetype.flatMap((group) => group.pains);
    expect(refs).toHaveLength(pains.length);
    expect(refs.every((ref) => ref !== null)).toBe(true);
    expect(new Set(refs.map((ref) => `${ref!.group}-${ref!.pain}`)).size).toBe(pains.length);
  });
});

describe("Example companies, gaps and sources", () => {
  it("keeps every example firm with its group, and an unknown size unknown", () => {
    const firms = research.companies.groups.flatMap((group) => group.firms);
    expect(firms).toHaveLength(8);
    expect(firms.filter((firm) => firm.size.status === "unknown")).toHaveLength(3);
    expect(research.companies.groups.map((group) => group.name)).toEqual(overview.groups.map((group) => group.name));
  });

  it("shows every gap and contradiction once, grouped by what it means, with why it matters and what to ask", () => {
    const findings = research.gaps.groups.flatMap((group) => group.findings);
    const gaps = findings.flatMap((finding) => (finding.kind === "gap" ? [finding.gap] : []));
    const contradictions = findings.flatMap((finding) => (finding.kind === "contradiction" ? [finding.contradiction] : []));
    expect(gaps.map((gap) => gap.id).sort()).toEqual(completeModule(pack, "m18")!.unknowns.map((gap) => gap.id).sort());
    expect(contradictions.map((entry) => entry.id).sort()).toEqual(completeModule(pack, "m17")!.entries.map((entry) => entry.id).sort());
    expect(gaps.every((gap) => gap.whyItMatters.length > 0)).toBe(true);
    expect(contradictions.every((entry) => entry.meaning.length > 0)).toBe(true);
    expect(gaps.flatMap((gap) => (gap.askOnFirstCall === undefined ? [] : [gap.askOnFirstCall])).sort()).toEqual(
      verificationQuestions(pack, Number.POSITIVE_INFINITY).map((question) => readable(question.question)).sort(),
    );
    expect(research.gaps.groups.map((group) => group.kind)).toEqual(["ask", "conflict", "careful", "verify", "unreadable"]);
  });

  it("counts the pack's own 78 sources and lists every one", () => {
    expect(research.sources).toBe(78);
    expect(research.sources).toBe(sourceCount(pack));
    expect(research.sourceList).toHaveLength(78);
  });

  it("lists sources by title with no person named in the fixture's personal posts", () => {
    const posts = research.sourceList.filter((source) => /linkedin\.com\/posts\//.test(source.url));
    expect(posts.length).toBeGreaterThan(0);
    for (const post of posts) expect(post.title).not.toMatch(/[A-Z][a-z]+ [A-Z][a-z]+ posted on/);
  });
});

describe("A pack a limit cut short", () => {
  const partial = partialPack();
  const drawn = researchSections(partial);

  it("draws what was written, names what was not, and invents nothing in its place", () => {
    expect(drawn.partial).toEqual(partial.missingModules);
    expect(drawn.unwritten.pains).toEqual(["m05", "m06"]);
    expect(drawn.pains.groups).toEqual([]);
    expect(drawn.market.timeline).toEqual([]);
    expect(drawn.market.theCase).not.toBeNull();
    expect(drawn.competition.competitors).toEqual([]);
    expect(drawn.competition.doNothing).toBeNull();
    expect(drawn.contact.channels).toEqual([]);
    expect(drawn.companies.groups).toEqual([]);
    expect(drawn.gaps.groups).toEqual([]);
    // No campaign was ranked, so no group has a rank, a reason or a lead angle.
    expect(drawn.who.groups.every((group) => group.rank === null && group.whyNow === null)).toBe(true);
    expect(drawn.say.groups.every((group) => group.angles.every((angle) => !angle.lead))).toBe(true);
    expect(drawn.unwritten.sources).toEqual([]);
    expect(drawn.sources).toBe(sourceCount(partial));
  });

  it("counts the urls research cited when the source list itself was not written", () => {
    const modules = Object.fromEntries(Object.entries(pack.modules).filter(([part]) => part !== "m19")) as PackShape["modules"];
    const cut: PackShape = { ...pack, modules, partial: true, missingModules: ["m19"] };
    const drawnCut = researchSections(cut);
    expect(drawnCut.sourceList).toEqual([]);
    expect(drawnCut.researchedOn).toBeNull();
    expect(drawnCut.sources).toBe(sourceCount(cut));
    expect(drawnCut.unwritten.sources).toEqual(["m19"]);
  });
});

describe("the research page's data, from a stored campaign", () => {
  const record = (brief: ResearchBrief, job: Job["status"], pack: PackShape | null) =>
    ({
      campaign: { id: "camp_1", orgId: "org", ownerUserId: "user", name: nameFrom(brief.who), briefVersion: 1, brief, startRequestId: "req", researchFromCampaignId: null, researchFromBriefVersion: null, playId: null, createdAt: new Date(), updatedAt: new Date() },
      job: { id: "job_1", status: job, error: null } as Job,
      event: pack === null ? null : ({ id: "event_1", after: { jobId: "job_1", pack: JSON.parse(JSON.stringify(pack)) } } as unknown as Event),
    }) as unknown as CampaignRecord;
  const brief = toResearchBrief(briefFields());

  it("is there for a finished plan, complete or partial", () => {
    expect(toCampaignResearch(record(brief, "done", pack)).research?.sources).toBe(78);
    expect(toCampaignResearch(record(brief, "done", partialPack())).research?.partial.length).toBeGreaterThan(0);
  });

  it("is null while research reads, on a stop, and when nothing readable came back", () => {
    expect(toCampaignResearch(record(brief, "running", null)).research).toBeNull();
    expect(toCampaignResearch(record(stoppedBrief() as ResearchBrief, "done", stoppedPack())).research).toBeNull();
    expect(toCampaignResearch(record(brief, "done", null)).research).toBeNull();
  });
});
