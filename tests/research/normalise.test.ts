import { describe, expect, it } from "vitest";

import { loadFacts } from "@/lib/facts/load";
import { liveFactIds } from "@/lib/facts/schema";
import { loadNeverSay, neverSayIssues } from "@/lib/facts/neverSay";
import { checkModuleWrite } from "@/lib/research/moduleWrite";
import { applyFixes, normaliseModule } from "@/lib/research/normalise";

import { goodPack, moduleContent } from "../agents/researchPack";

/**
 * Refuse for content, correct the mechanics (research v3 §10 note 23): the
 * slips that cost briefs E and A fourteen full-module rewrites are corrected
 * on write and reported; a refusal can be answered with fixes.
 */

const facts = loadFacts("insights360", 1).facts;
const live = liveFactIds(facts);
const liveId = [...live][0]!;
const content = (id: Parameters<typeof moduleContent>[1]): Record<string, unknown> => structuredClone(moduleContent(goodPack({ liveFactId: liveId }), id));
const now = new Date();

describe("normaliseModule", () => {
  it("leaves a clean module alone", () => {
    expect(normaliseModule("m01", content("m01")).notes).toEqual([]);
  });

  it("writes an m01 sub-segment's count or size given as a number as text, so the slip costs no rewrite (brief C v3.2)", () => {
    const m01 = content("m01") as { subSegments: Array<Record<string, unknown>> };
    m01.subSegments[0]!.countEstimate = 3;
    m01.subSegments[1]!.sizeRange = 12;
    const { content: fixed, notes } = normaliseModule("m01", m01);
    expect((fixed as typeof m01).subSegments[0]!.countEstimate).toBe("3");
    expect((fixed as typeof m01).subSegments[1]!.sizeRange).toBe("12");
    expect(notes).toEqual(["m01.subSegments.0.countEstimate: the number 3 written as text", "m01.subSegments.1.sizeRange: the number 12 written as text"]);
    // Accepted on the first write: the module's one rewrite is still unspent.
    const check = checkModuleWrite("m01", m01, { accepted: {}, liveFactIds: live, now });
    expect(check.ok).toBe(true);
  });

  it("lowers a confidence word to what its urls support, and sets domains from the urls (brief E m05, m17)", () => {
    const m05 = content("m05") as { perArchetype: Array<{ pains: Array<{ confidence: string; evidence: { urls: string[]; domains: string[] } }> }> };
    const pain = m05.perArchetype[0]!.pains[0]!;
    pain.confidence = "moderate";
    pain.evidence.urls = ["https://lawgazette.co.uk/a", "https://lawgazette.co.uk/b"];
    pain.evidence.domains = ["lawgayzette.co.uk"];
    const { content: fixed, notes } = normaliseModule("m05", m05);
    const after = (fixed as typeof m05).perArchetype[0]!.pains[0]!;
    expect(after.confidence).toBe("weak");
    expect(after.evidence.domains).toEqual(["lawgazette.co.uk"]);
    expect(notes).toEqual(expect.arrayContaining([expect.stringMatching(/confidence: lowered from moderate to weak/), expect.stringMatching(/evidence\.domains: set to the hosts/)]));
    expect(checkModuleWrite("m05", m05, { accepted: {}, liveFactIds: live, now }).ok).toBe(true);
  });

  it("writes a market-size object as one line, maps country names to codes, and fills an empty claims list (briefs E and A)", () => {
    const m01 = content("m01");
    m01.marketSize = [{ figure: "About 300 insurers", source: "https://abi.example/", note: "ABI members" }];
    expect((normaliseModule("m01", m01).content as { marketSize: string[] }).marketSize).toEqual(["About 300 insurers — ABI members (https://abi.example/)"]);
    const m04 = content("m04") as { perArchetype: Array<{ recipe: { countries: string[] } }> };
    m04.perArchetype[0]!.recipe.countries = ["UK", "United Kingdom (England, Scotland, Wales)", "ie"];
    expect((normaliseModule("m04", m04).content as typeof m04).perArchetype[0]!.recipe.countries).toEqual(["GB", "GB", "IE"]);
    const m13 = content("m13");
    delete m13.claims;
    expect(checkModuleWrite("m13", m13, { accepted: {}, liveFactIds: live, now }).ok).toBe(true);
  });

  it("still refuses content: a floor, and a never-say phrase", () => {
    const m03 = content("m03") as { archetypes: unknown[] };
    m03.archetypes = m03.archetypes.slice(0, 2);
    expect(checkModuleWrite("m03", m03, { accepted: {}, liveFactIds: live, now }).ok).toBe(false);
    const m00 = content("m00") as { hardFilters: { firmsOut: string[] } };
    m00.hardFilters.firmsOut = ["Trifle Solutions"];
    expect(checkModuleWrite("m00", m00, { accepted: {}, liveFactIds: live, neverSay: loadNeverSay("insights360", 1), now }).ok).toBe(false);
  });
});

describe("applyFixes", () => {
  it("reads a bracketed path as the dotted one: claims[1].text is claims.1.text (brief D v3.2 rerun)", () => {
    const base = { claims: [{ text: "first" }, { text: "second" }] };
    const { content: fixed, errors } = applyFixes(base, [{ path: "claims[1].text", value: "fixed" }]);
    expect(errors).toEqual([]);
    expect(fixed).toEqual({ claims: [{ text: "first" }, { text: "fixed" }] });
    expect(applyFixes(base, [{ path: "claims[5].text", value: "x" }]).errors).toEqual(["claims[5].text: no 5 to fix"]);
  });

  it("sets a field by the path a refusal names, removes one with null, and names a path that does not exist", () => {
    const base = { perArchetype: [{ pains: [{ role: "x".repeat(10) }, { role: "y" }] }], extra: 1 };
    const { content: fixed, errors } = applyFixes(base, [
      { path: "perArchetype.0.pains.0.role", value: "Head of claims" },
      { path: "extra", value: null },
      { path: "perArchetype.5.pains.0.role", value: "z" },
    ]);
    expect(fixed).toEqual({ perArchetype: [{ pains: [{ role: "Head of claims" }, { role: "y" }] }] });
    expect(errors).toEqual([expect.stringMatching(/perArchetype\.5\.pains\.0\.role: no 5/)]);
    expect(base.perArchetype[0]!.pains[0]!.role).toBe("x".repeat(10));
  });
});

describe("the never-say lint reads the rest of the sentence", () => {
  const list = loadNeverSay("insights360", 1);
  it("does not fire on an honest statement of a gap (brief A, m02)", () => {
    expect(neverSayIssues([{ where: "m02.body", text: "Insights360's facts file marks SSO, SCIM, PII redaction and in-app audio playback as not shipped." }], list)).toEqual([]);
  });
  it("still fires on the claim itself", () => {
    expect(neverSayIssues([{ where: "m09", text: "Insights360 offers in-app audio playback for every call." }], list).length).toBeGreaterThan(0);
  });

  it("assigns stable ids where a model left them out (§10 note 26)", () => {
    const m09 = content("m09") as { perArchetype: Array<{ archetypeId: string; angles: Array<{ id?: string; rank: number }> }> };
    for (const angle of m09.perArchetype[0]!.angles) delete angle.id;
    const fixed = normaliseModule("m09", m09).content as typeof m09;
    expect(fixed.perArchetype[0]!.angles.map((a) => a.id)).toEqual([1, 2, 3, 4, 5].map((r) => `claims-teams-angle-${r}`));
    const m13 = content("m13") as { entries: Array<{ id?: string }> };
    delete m13.entries[0]!.id;
    expect((normaliseModule("m13", m13).content as typeof m13).entries[0]!.id).toMatch(/^event-/);
  });
});
