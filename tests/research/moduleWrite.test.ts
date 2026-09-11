import { describe, expect, it } from "vitest";

import { MODULE_IDS } from "../../agents/research/output.schema";
import { loadFacts } from "@/lib/facts/load";
import { liveFactIds } from "@/lib/facts/schema";
import { checkModuleWrite } from "@/lib/research/moduleWrite";

import { goodPack, moduleContent } from "../agents/researchPack";

/**
 * The check `writeModule` runs on each module as it is written (research v3
 * §7 "On write"): schema and floors, demotion, the per-module domain cap and
 * its primary-source carve-out, live fact ids, ids unique against what is
 * already accepted, rep words on the rep summary.
 */

const facts = loadFacts("insights360", 1).facts;
const live = liveFactIds(facts);
const liveId = [...live][0]!;
const plannedId = facts.facts.find((fact) => fact.status === "planned")!.id;
const now = new Date();

const content = (id: (typeof MODULE_IDS)[number]): Record<string, unknown> => structuredClone(moduleContent(goodPack({ liveFactId: liveId }), id));

describe("checkModuleWrite", () => {
  it("accepts every module of the complete pack, written in order, and sets the status itself", () => {
    const accepted: Record<string, unknown> = {};
    for (const id of MODULE_IDS) {
      const check = checkModuleWrite(id, content(id), { accepted, liveFactIds: live, now });
      if (!check.ok) throw new Error(`${id}: ${check.issues.join("; ")}`);
      expect(check.module.status).toBe("complete");
      accepted[id] = check.module;
    }
  });

  it("refuses a module under its floor, with the issue named", () => {
    const m03 = content("m03") as { archetypes: unknown[] };
    m03.archetypes = m03.archetypes.slice(0, 2);
    const check = checkModuleWrite("m03", m03, { accepted: {}, liveFactIds: live, now });
    if (check.ok) throw new Error("expected a refusal");
    expect(check.issues.join(" ")).toMatch(/archetypes/);
  });

  it("refuses a fourth page from one domain in a module, and exempts a primary source", () => {
    const m05 = content("m05") as { perArchetype: Array<{ pains: Array<{ evidence: { urls: string[]; domains: string[]; primary: boolean } }> }> };
    m05.perArchetype[0]!.pains.forEach((pain, i) => {
      pain.evidence = { urls: [`https://onedomain.test/page-${i}`], domains: ["onedomain.test"], primary: false };
    });
    const refused = checkModuleWrite("m05", m05, { accepted: {}, liveFactIds: live, now });
    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.issues.join(" ")).toMatch(/4 pages from onedomain\.test in this module; the cap is 3/);

    for (const pain of m05.perArchetype[0]!.pains) pain.evidence.primary = true;
    expect(checkModuleWrite("m05", m05, { accepted: {}, liveFactIds: live, now }).ok).toBe(true);
  });

  it("exempts the regulator m01 names as a primary source for later modules", () => {
    const accepted: Record<string, unknown> = {};
    const m01 = content("m01") as { bodies: Array<{ url?: string }> };
    m01.bodies = [{ ...m01.bodies[0], url: "https://onedomain.test/" } as { url?: string }];
    const first = checkModuleWrite("m01", m01, { accepted, liveFactIds: live, now });
    if (!first.ok) throw new Error(first.issues.join("; "));
    accepted.m01 = first.module;
    const m05 = content("m05") as { perArchetype: Array<{ pains: Array<{ evidence: { urls: string[]; domains: string[]; primary: boolean } }> }> };
    m05.perArchetype[0]!.pains.forEach((pain, i) => {
      pain.evidence = { urls: [`https://onedomain.test/page-${i}`], domains: ["onedomain.test"], primary: false };
    });
    expect(checkModuleWrite("m05", m05, { accepted, liveFactIds: live, now }).ok).toBe(true);
  });

  it("refuses an id another accepted module already uses", () => {
    const accepted: Record<string, unknown> = {};
    const m01 = checkModuleWrite("m01", content("m01"), { accepted, liveFactIds: live, now });
    if (!m01.ok) throw new Error(m01.issues.join("; "));
    accepted.m01 = m01.module;
    const exec = content("execSummary") as { claims: Array<{ id: string }> };
    exec.claims[0]!.id = "market-1";
    const check = checkModuleWrite("execSummary", exec, { accepted, liveFactIds: live, now });
    if (check.ok) throw new Error("expected a refusal");
    expect(check.issues.join(" ")).toMatch(/"market-1" is already used by another module/);
  });

  it("refuses a fact id that is not live", () => {
    const m15 = content("m15") as { proof: Array<{ factId: string }> };
    m15.proof[0]!.factId = plannedId;
    const check = checkModuleWrite("m15", m15, { accepted: {}, liveFactIds: live, now });
    if (check.ok) throw new Error("expected a refusal");
    expect(check.issues.join(" ")).toContain(plannedId);
  });

  it("checks rep words on the rep summary, and not on a module body the campaign agent reads", () => {
    const rep = content("repSummary") as { lines: string[] };
    rep.lines[0] = "The orchestrator will start an agent run for this persona.";
    expect(checkModuleWrite("repSummary", rep, { accepted: {}, liveFactIds: live, now }).ok).toBe(false);
    const m01 = content("m01") as { body: string };
    m01.body = "The persona and ICP analysis the orchestrator reads.";
    expect(checkModuleWrite("m01", m01, { accepted: {}, liveFactIds: live, now }).ok).toBe(true);
  });

  it("demotes a stale strong trigger on write and accepts it", () => {
    const m01 = content("m01") as { triggers: Array<{ publishedAt: string; confidence: string; evidence: { primary: boolean } }> };
    m01.triggers[0]!.publishedAt = "2024-01-15";
    m01.triggers[0]!.confidence = "strong";
    m01.triggers[0]!.evidence.primary = true;
    const check = checkModuleWrite("m01", m01, { accepted: {}, liveFactIds: live, now });
    if (!check.ok) throw new Error(check.issues.join("; "));
    expect(check.demoted).toHaveLength(1);
    expect((check.module as { triggers: Array<{ confidence: string }> }).triggers[0]!.confidence).toBe("weak");
  });

  it("lets an objection cite a planned fact as the reason it is not available, and never in factIds (§10 note 9)", () => {
    const known = new Set(facts.facts.filter((fact) => fact.status !== "retired").map((fact) => fact.id));
    const m11 = content("m11") as { perArchetype: Array<{ objections: Array<{ factIds: string[]; notYetFactIds?: string[] }> }> };
    m11.perArchetype[0]!.objections[0]!.notYetFactIds = [plannedId];
    expect(checkModuleWrite("m11", m11, { accepted: {}, liveFactIds: live, knownFactIds: known, now }).ok).toBe(true);
    m11.perArchetype[0]!.objections[0]!.notYetFactIds = ["i360.boundary.not-a-real-fact"];
    expect(checkModuleWrite("m11", m11, { accepted: {}, liveFactIds: live, knownFactIds: known, now }).ok).toBe(false);
    m11.perArchetype[0]!.objections[0]!.notYetFactIds = [];
    m11.perArchetype[0]!.objections[0]!.factIds = [plannedId];
    expect(checkModuleWrite("m11", m11, { accepted: {}, liveFactIds: live, knownFactIds: known, now }).ok).toBe(false);
  });

  it("checks references to modules already accepted on write: archetype ids and pain ids (§10 note 12)", () => {
    const accepted: Record<string, unknown> = {};
    for (const id of ["m00", "repSummary", "execSummary", "m01", "m02", "m03", "m04", "m05"] as const) {
      const check = checkModuleWrite(id, content(id), { accepted, liveFactIds: live, now });
      if (!check.ok) throw new Error(`${id}: ${check.issues.join("; ")}`);
      accepted[id] = check.module;
    }
    const m11 = content("m11") as { perArchetype: Array<{ archetypeId: string }> };
    m11.perArchetype[0]!.archetypeId = "conveyancing-volume-practice";
    const wrongKind = checkModuleWrite("m11", m11, { accepted, liveFactIds: live, now });
    if (wrongKind.ok) throw new Error("expected a refusal");
    expect(wrongKind.issues.join(" ")).toMatch(/m11 names archetype "conveyancing-volume-practice" which m03 does not define/);

    const m07 = content("m07") as { mappings: Array<{ painId: string }> };
    m07.mappings[0]!.painId = "p-invented";
    const wrongPain = checkModuleWrite("m07", m07, { accepted, liveFactIds: live, now });
    if (wrongPain.ok) throw new Error("expected a refusal");
    expect(wrongPain.issues.join(" ")).toMatch(/m07 neither maps nor lists as unmatched the pain/);

  });

  it("needs a partial mapping to say what it does not change (§10 note 25)", () => {
    const m07 = content("m07") as { mappings: Array<{ strength: string; mustNotImply?: string }> };
    m07.mappings[0]!.strength = "partial";
    delete m07.mappings[0]!.mustNotImply;
    const refused = checkModuleWrite("m07", m07, { accepted: {}, liveFactIds: live, now });
    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.issues.join(" ")).toMatch(/a partial mapping says in mustNotImply/);
    m07.mappings[0]!.mustNotImply = "Earlier visibility; it does not lower the complaint count.";
    expect(checkModuleWrite("m07", m07, { accepted: {}, liveFactIds: live, now }).ok).toBe(true);
  });

  it("checks a candidate's references against its own kind of buyer's records (§10 note 26)", () => {
    const accepted: Record<string, unknown> = {};
    for (const id of MODULE_IDS.filter((m) => m !== "m16" && m !== "m19")) {
      const check = checkModuleWrite(id, content(id), { accepted, liveFactIds: live, now });
      if (!check.ok) throw new Error(`${id}: ${check.issues.join("; ")}`);
      accepted[id] = check.module;
    }
    expect(checkModuleWrite("m16", content("m16"), { accepted, liveFactIds: live, now }).ok).toBe(true);
    const m16 = content("m16") as { candidates: Array<{ painIds: string[]; angleIds: string[]; venueIds: string[] }> };
    m16.candidates[0]!.painIds = ["regional-brokers-pain-1"];
    m16.candidates[0]!.venueIds = ["venue-nowhere"];
    const refused = checkModuleWrite("m16", m16, { accepted, liveFactIds: live, now });
    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.issues.join(" ")).toMatch(/names the pain "regional-brokers-pain-1", which is not one of its kind of buyer's/);
    expect(refused.issues.join(" ")).toMatch(/names the venue "venue-nowhere"/);
  });
});
