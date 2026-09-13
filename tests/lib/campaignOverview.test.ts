import { describe, expect, it } from "vitest";

import { completeModule, planCards, researchRawSchema } from "../../agents/research/output.schema";
import fixture from "../../fixtures/research/smoke-a-insurance-direct-2026-09-13.json";
import { deriveResearch } from "@/lib/campaigns/derive";
import { overviewOf } from "@/lib/campaigns/overview";
import {
  buyerLanguage,
  researchContradictions,
  researchGaps,
  seedFirmsByGroup,
  sourceCount,
  topCandidate,
  verificationQuestions,
} from "@/lib/campaigns/packSelectors";

/**
 * The campaign Overview, read from the first live Research run through the app
 * (the smoke test of 2026-09-13, brief A: claims operations at mid-sized UK
 * insurers). The fixture is that run's pack with the quoted people's names and
 * their personal post links replaced; everything else is as research wrote it.
 *
 * Each test pins one mapping the first campaign page got wrong.
 */
const pack = researchRawSchema.parse(fixture.pack);
const overview = overviewOf(pack);
const m16 = completeModule(pack, "m16")!;
const rankOne = m16.candidates.slice().sort((a, b) => a.rank - b.rank)[0]!;
const summary = completeModule(pack, "repSummary")!;

describe("the smoke-test fixture", () => {
  it("is the complete live pack, with the quoted people made anonymous", () => {
    expect(pack.outcome ?? fixture.outcome).toBe("complete");
    expect(pack.partial).toBe(false);
    expect(Object.keys(pack.modules)).toHaveLength(22);

    const text = JSON.stringify(fixture);
    const speakers = [...text.matchAll(/"speaker":\s*"([^"]+)"/g)].map((match) => match[1]);
    expect(speakers.length).toBeGreaterThan(0);
    for (const speaker of speakers) expect(speaker).toMatch(/^Practitioner \d+$/);
    for (const url of text.match(/https:\/\/www\.linkedin\.com\/(posts|pulse|in)\/[^"]+/g) ?? []) {
      expect(url).toMatch(/^https:\/\/www\.linkedin\.com\/posts\/example-author-\d+$/);
    }
  });
});

describe("Start with", () => {
  it("is research's rank-1 campaign, with its own dated reason, not the strongest trigger in the whole market", () => {
    expect(topCandidate(pack)?.id).toBe(rankOne.id);
    expect(overview.startWith?.groupName).toBe(completeModule(pack, "m03")!.archetypes.find((a) => a.id === rankOne.archetypeId)!.name);
    expect(overview.startWith?.whyNow).toBe(rankOne.whyNow);
    expect(overview.startWith?.whyNow).toContain("22 October 2026");
    expect(overview.startWith?.wrongIf).toBe(rankOne.wrongIf);

    // What the first page showed as this hook's "why now": the market's
    // strongest trigger, a home and travel super-complaint, beside a motor hook.
    const marketWide = planCards(pack).hook?.whyNow.text ?? "";
    expect(marketWide).toContain("super-complaint");
    expect(overview.startWith?.whyNow).not.toBe(marketWide);
  });

  it("shows the lead angle as words, looked up when research names it by id", () => {
    expect(rankOne.leadAngle).not.toMatch(/\s/);
    const angle = completeModule(pack, "m09")!.perArchetype.find((p) => p.archetypeId === rankOne.archetypeId)!.angles.find((a) => a.id === rankOne.leadAngle)!;
    expect(overview.startWith?.angle).toBe(angle.text);
    expect(overview.startWith?.angle).toMatch(/\s/);
  });
});

describe("Pains and buyer language", () => {
  it("is the rank-1 group's own pains, not the summary's who-to-reach line", () => {
    const own = completeModule(pack, "m05")!.perArchetype.find((p) => p.archetypeId === rankOne.archetypeId)!.pains;
    expect(overview.pain?.pains.map((pain) => pain.id)).toEqual(own.slice(0, 3).map((pain) => pain.id));
    expect(JSON.stringify(overview.pain)).not.toContain(summary.lines[0]!);
  });

  it("never counts a regulator's or a supplier's words as the buyer's", () => {
    for (const group of completeModule(pack, "m03")!.archetypes) {
      const { buyer, others } = buyerLanguage(pack, group.id);
      expect(buyer.every((phrase) => !phrase.notBuyer)).toBe(true);
      expect(others.every((phrase) => phrase.notBuyer)).toBe(true);
    }
    expect(overview.pain?.buyerWords.every((phrase) => !phrase.notBuyer)).toBe(true);
    expect(overview.pain?.otherVoices.every((phrase) => phrase.notBuyer)).toBe(true);
    expect(overview.pain?.otherVoices.length).toBeGreaterThan(0);
  });
});

describe("the rest of the Overview", () => {
  it("counts the pack's own sources, not only those the cards happen to cite", () => {
    expect(sourceCount(pack)).toBe(completeModule(pack, "m19")!.sources.length);
    expect(overview.sources).toBe(78);
  });

  it("keeps the five summary lines and research's view as written", () => {
    expect(overview.inShort.lines).toEqual(summary.lines);
    expect(overview.inShort.lines).toHaveLength(5);
    expect(overview.inShort.verdict).toBe(completeModule(pack, "execSummary")!.verdict);
  });

  it("asks at most three questions, each research's own, with no url and no search in them", () => {
    const asked = researchGaps(pack).flatMap((gap) => (gap.askOnFirstCall === undefined ? [] : [gap.askOnFirstCall]));
    expect(overview.checkFirst.questions).toHaveLength(3);
    for (const { question } of overview.checkFirst.questions) {
      expect(asked).toContain(question);
      expect(question).not.toMatch(/https?:\/\//);
    }
    expect(verificationQuestions(pack, 1)).toHaveLength(1);
    expect(overview.checkFirst.summary).toBe(summary.lines[3]);
    expect(overview.checkFirst.summary).toMatch(/^Biggest unknown/);
  });

  it("keeps each example firm with its group and its size as research knows it", () => {
    const groups = seedFirmsByGroup(pack);
    expect(groups).toHaveLength(4);
    expect(overview.firms.flatMap((group) => group.firms)).toHaveLength(8);
    const unknown = overview.firms.flatMap((group) => group.firms).filter((firm) => firm.size.status === "unknown");
    expect(unknown).toHaveLength(3);
    expect(new Set(overview.firms.map((group) => group.groupName))).toEqual(new Set(completeModule(pack, "m03")!.archetypes.map((a) => a.name)));
  });

  it("keeps every gap and contradiction whole for the research view", () => {
    expect(overview.gaps).toHaveLength(11);
    expect(overview.gaps.every((gap) => gap.whyItMatters.length > 0)).toBe(true);
    expect(overview.gaps.filter((gap) => gap.askOnFirstCall !== undefined)).toHaveLength(6);
    expect(overview.contradictions).toEqual(researchContradictions(pack));
    expect(overview.contradictions.every((entry) => entry.meaning.length > 0)).toBe(true);
  });

  it("ranks the buyer groups as research ranks the campaigns, rank 1 first", () => {
    expect(overview.groups[0]?.id).toBe(rankOne.archetypeId);
    expect(overview.groups.filter((group) => group.first)).toHaveLength(1);
    expect(overview.groups.every((group) => group.roles.length > 0)).toBe(true);
  });

  it("comes with a finished plan from the stored Event, and not with a stop", () => {
    const view = deriveResearch({ status: "done", error: null }, { after: fixture });
    expect(view.state).toBe("planReady");
    if (view.state !== "planReady") return;
    expect(view.overview).toEqual(overview);
  });
});
