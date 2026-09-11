import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { PackShape } from "../../agents/research/output.schema";
import { agentsDir, loadDefinition } from "@/lib/agents/definitions";
import { loadFacts } from "@/lib/facts/load";
import { scoreRubric, type RubricRow } from "@/lib/research/rubric";

import { goodPack } from "./researchPack";

/**
 * The research rubric (research v3 §8): its rows against a pack that meets
 * every floor and against copies broken one way each, then over the recorded
 * bench runs in `fixtures/agents/research/<brief>.json`.
 *
 * Row 9 (replay) is its own test; row 12 is the product owner's. A brief that has not
 * been recorded, or was recorded under the v2 contract, is reported and
 * skipped, not failed: the live run is the gate that produces the fixture.
 */

const facts = loadFacts("insights360", 1);
const LIVE_ID = [...facts.facts.facts].find((fact) => fact.status === "live")!.id;
const fresh = (): PackShape => goodPack({ liveFactId: LIVE_ID });
const row = (rows: RubricRow[], check: number): RubricRow => rows.find((r) => r.check === check)!;
type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("the research rubric, row by row", () => {
  it("passes a complete pack on every machine row, with the run's record supplied", () => {
    const pack = fresh();
    const rows = scoreRubric({
      pack,
      searches: [1, 2, 3].map((i) => ({ query: `q${i}`, purpose: "contradiction" })),
      actuals: { searches: 20, fetches: 30, fetchedChars: 200_000, seconds: 1200, modelSteps: 60, costUsd: 8 },
      budget: loadDefinition("research").budget,
      report: { provenance: [{ total: 60, failed: [] }] },
      priorSeedFirms: ["A firm nobody found"],
    });
    expect(rows.map((r) => r.check)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    const failed = rows.filter((r) => r.verdict === "fail");
    expect(failed, failed.map((r) => `${r.check} ${r.name}: ${r.detail}`).join("\n")).toEqual([]);
    for (const check of [1, 2, 3, 4, 5, 6, 7, 10, 11, 13]) expect(row(rows, check).verdict, `row ${check}`).toBe("pass");
    // Row 14 reads the locked scope; a pack built without one has none to hold.
    for (const check of [8, 9, 12, 14]) expect(row(rows, check).verdict, `row ${check}`).toBe("n/a");
  });

  it("row 2 fails a partial pack and a pack with an insufficient module", () => {
    const partial = fresh() as Loose;
    delete partial.modules.m18;
    partial.missingModules = ["m18"];
    partial.partial = true;
    expect(row(scoreRubric({ pack: partial as PackShape }), 2)).toMatchObject({ verdict: "fail", detail: expect.stringMatching(/missing m18/) });

    const thin = fresh() as Loose;
    thin.modules.m10 = { status: "insufficient", body: "Too thin.", claims: [], issues: ["entries: too few"] };
    expect(row(scoreRubric({ pack: thin as PackShape }), 2)).toMatchObject({ verdict: "fail", detail: expect.stringMatching(/insufficient m10/) });
  });

  it("row 3 fails over ten percent demoted", () => {
    expect(row(scoreRubric({ pack: fresh(), report: { provenance: [{ total: 10, failed: [1, 2] }] } }), 3).verdict).toBe("fail");
  });

  it("row 4 fails when vendor voices outnumber buyers", () => {
    const pack = fresh() as Loose;
    for (const p of pack.modules.m06.perArchetype) for (const phrase of p.phrases) phrase.notBuyer = true;
    expect(row(scoreRubric({ pack: pack as PackShape }), 4)).toMatchObject({ verdict: "fail", detail: expect.stringMatching(/^0%/) });
  });

  it("row 6 fails four pages from one domain in one module, and seed firms from one source", () => {
    const pack = fresh() as Loose;
    pack.modules.m05.perArchetype[0].pains.forEach((pain: Loose, i: number) => {
      pain.evidence = { urls: [`https://same.example/p${i}`], primary: false, domains: ["same.example"] };
    });
    expect(row(scoreRubric({ pack: pack as PackShape }), 6)).toMatchObject({ verdict: "fail", detail: expect.stringMatching(/m05 same\.example×4/) });

    const firms = fresh() as Loose;
    for (const firm of firms.modules.m04.perArchetype[0].seedFirms) firm.signal.evidence = { urls: ["https://one.example/list"], primary: false, domains: ["one.example"] };
    expect(row(scoreRubric({ pack: firms as PackShape }), 6)).toMatchObject({ verdict: "fail", detail: expect.stringMatching(/one source/) });
  });

  it("row 7 fails with fewer contradiction searches than kinds of buyer", () => {
    expect(row(scoreRubric({ pack: fresh(), searches: [{ query: "claims backlog", purpose: "survey" }] }), 7).verdict).toBe("fail");
  });

  it("row 10 fails a re-run that repeats a seed firm", () => {
    const pack = fresh() as Loose;
    const name = pack.modules.m04.perArchetype[0].seedFirms[0].name as string;
    expect(row(scoreRubric({ pack: pack as PackShape, priorSeedFirms: [name] }), 10).verdict).toBe("fail");
  });

  it("row 11 fails a run over the spend rail", () => {
    const rows = scoreRubric({ pack: fresh(), actuals: { searches: 1, fetches: 1, fetchedChars: 1, seconds: 1, modelSteps: 1, costUsd: 51 }, budget: loadDefinition("research").budget });
    expect(row(rows, 11)).toMatchObject({ verdict: "fail", detail: expect.stringMatching(/spend/) });
  });

  it("row 13 fails a summary a rep should not read", () => {
    const pack = fresh() as Loose;
    pack.modules.repSummary.lines[0] = "Every buying signal points at the July guidance.";
    expect(row(scoreRubric({ pack: pack as PackShape }), 13).verdict).toBe("fail");
  });

  it("row 8 passes a persisted stop after m01 with nothing researched after it (§10 note 28)", () => {
    const { pack, record } = stoppedAfterM01();
    expect(row(scoreRubric({ pack, record, expectInsufficient: true }), 8)).toMatchObject({ verdict: "pass", detail: expect.stringMatching(/widen by region/) });
  });

  it("row 8 fails a widened pack that only carries an insufficient block, as brief C's run would have", () => {
    const widened = fresh() as Loose;
    widened.scope = ORKNEY;
    widened.outcome = "insufficient";
    widened.insufficient = { reason: "Only two practices.", evidenceIds: [], widenings: [WIDEN_REGION], decidedAt: "2026-09-11T09:12:14Z" };
    const record = [
      { run: 0, name: "writeModule", module: "m00", accepted: true },
      { run: 0, name: "writeModule", module: "m04", accepted: true },
    ];
    const detail = row(scoreRubric({ pack: widened as PackShape, record, expectInsufficient: true }), 8);
    expect(detail.verdict).toBe("fail");
    expect(detail.detail).toMatch(/no persisted stop/);
    expect(detail.detail).toMatch(/synthesis wrote/);
    expect(detail.detail).toMatch(/outside the scope/);
  });

  it("row 8 fails a stop followed by more research, an unresolved evidence id, or a widening that does not widen", () => {
    const after = stoppedAfterM01();
    expect(row(scoreRubric({ pack: after.pack, record: [...after.record, { run: 0, name: "search" }], expectInsufficient: true }), 8).detail).toMatch(/1 research call\(s\) after the stop/);

    const loose = stoppedAfterM01();
    (loose.pack as Loose).insufficient.evidenceIds = ["not-an-item"];
    expect(row(scoreRubric({ ...loose, expectInsufficient: true }), 8).detail).toMatch(/not-an-item is not in m00 or m01/);

    const narrow = stoppedAfterM01();
    (narrow.pack as Loose).insufficient.widenings = [{ dimension: "size", text: "Smaller.", scopePatch: { size: { unit: "employees", max: 5 } } }];
    expect(row(scoreRubric({ ...narrow, expectInsufficient: true }), 8).detail).toMatch(/the rep set no size to widen/);
    expect(row(scoreRubric({ pack: fresh(), expectInsufficient: true }), 8).verdict).toBe("fail");
  });

  it("row 14 holds seed firms to the locked scope on every brief", () => {
    const inside = fresh() as Loose;
    inside.scope = { countries: ["GB"], supplied: ["countries"] };
    expect(row(scoreRubric({ pack: inside as PackShape }), 14).verdict).toBe("pass");
    const outside = fresh() as Loose;
    outside.scope = ORKNEY;
    expect(row(scoreRubric({ pack: outside as PackShape }), 14)).toMatchObject({ verdict: "fail", detail: expect.stringMatching(/names none of the brief's places \(Orkney/) });
  });
});

const ORKNEY = { countries: ["GB"], places: [{ name: "Orkney", aliases: ["Kirkwall"] }], orgTypes: ["veterinary practice"], supplied: ["countries", "places", "orgTypes"] };
const WIDEN_REGION = { dimension: "region", text: "The Highlands and Islands as well as Orkney.", scopePatch: { places: [{ name: "Orkney" }, { name: "Highlands and Islands" }] } };

/** A thin brief done right: m00 and m01 written, the scope decided `stop`, and nothing after it. */
function stoppedAfterM01(): { pack: PackShape; record: Array<{ run: number; name: string; module?: string; verdict?: string; accepted?: boolean }> } {
  const full = fresh() as Loose;
  const modules = { m00: full.modules.m00, m01: full.modules.m01 };
  const missing = Object.keys(full.modules).filter((id) => !(id in modules));
  const pack = {
    modules,
    partial: true,
    missingModules: missing,
    scope: ORKNEY,
    outcome: "insufficient",
    insufficient: { reason: "Orkney holds two veterinary practices, not ten.", evidenceIds: ["market-1"], widenings: [WIDEN_REGION], decidedAt: "2026-09-11T09:00:00Z" },
  } as unknown as PackShape;
  const record = [
    { run: 0, name: "search" },
    { run: 0, name: "writeModule", module: "m00", accepted: true },
    { run: 0, name: "writeModule", module: "m01", accepted: true },
    { run: 0, name: "decideScope", verdict: "stop", accepted: true },
  ];
  return { pack, record };
}

const DIR = path.join(path.dirname(agentsDir()), "fixtures", "agents", "research");

type Fixture = {
  name: string;
  contract?: string;
  output: (PackShape & Loose) | null;
  rubric: RubricRow[];
  error: string | null;
};

const BRIEFS: Record<string, { expectInsufficient: boolean; priorFrom?: string; required: number[] }> = {
  "research-a-insurance-direct": { expectInsufficient: false, required: [1, 2, 4, 5, 6, 7, 11, 13] },
  "research-b-print-channel": { expectInsufficient: false, required: [1, 2, 4, 5, 6, 7, 11, 13] },
  "research-c-thin-vets": { expectInsufficient: true, required: [1, 8, 11] },
  "research-d-insurance-rerun": { expectInsufficient: false, priorFrom: "research-a-insurance-direct", required: [1, 2, 5, 6, 10, 11, 13] },
  "research-e-legal-direct": { expectInsufficient: false, required: [1, 2, 4, 5, 6, 7, 11, 13] },
};

function load(name: string): Fixture | null {
  const file = path.join(DIR, `${name}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Fixture) : null;
}

/** A recording made before the v3 contract carries no `contract` and a v2 pack (no modules), or no pack at all. */
const isV3 = (fixture: Fixture): boolean => fixture.contract === "v3" || (fixture.output != null && fixture.output.modules !== undefined);

describe("the research rubric over the recorded briefs", () => {
  // The bench's recordings; the depth fixture (Signal's May pack) lives beside them and has its own test.
  const recorded = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith(".json") && !f.startsWith("signal-")) : [];
  it("reports which briefs have been recorded, and under which contract", () => {
    const lines = recorded.map((f) => {
      const fixture = JSON.parse(readFileSync(path.join(DIR, f), "utf8")) as Fixture;
      return `${f} (${isV3(fixture) ? "v3" : "recorded under research v2; re-record in Step 6"})`;
    });
    console.log(`recorded research fixtures: ${lines.length === 0 ? "none yet" : lines.join(", ")}`);
    expect(Array.isArray(recorded)).toBe(true);
  });

  for (const [name, spec] of Object.entries(BRIEFS)) {
    const fixture = load(name);
    const v2 = fixture !== null && !isV3(fixture);
    const run = fixture === null || v2 ? it.skip : it;
    const label = v2 ? `${name}: recorded under research v2; re-record in Step 6` : `${name}: the required checks pass`;
    run(label, () => {
      if (fixture === null) return;
      expect(fixture.error, `the run failed: ${fixture.error}`).toBeNull();
      expect(fixture.output).not.toBeNull();
      const pack = fixture.output as PackShape;
      const priorPack = spec.priorFrom === undefined ? undefined : load(spec.priorFrom)?.output;
      const priorModules = priorPack?.modules as Loose | undefined;
      const prior = priorModules === undefined ? undefined : ((priorModules.m04?.perArchetype ?? []) as Loose[]).flatMap((t) => (t.seedFirms as Loose[]).map((f) => f.name as string));
      const rows = scoreRubric({ pack, expectInsufficient: spec.expectInsufficient, ...(prior === undefined ? {} : { priorSeedFirms: prior }) });
      // The fixture's own rubric (scored with the run's steps, actuals and
      // report) is the fuller record; the pack-only rows here must agree with it.
      const stored = new Map(fixture.rubric.map((r) => [r.check, r]));
      const failures = spec.required
        .map((check) => stored.get(check) ?? rows.find((r) => r.check === check))
        .filter((r): r is RubricRow => r !== undefined && r.verdict === "fail");
      expect(failures, failures.map((r) => `${r.check} ${r.name}: ${r.detail}`).join("\n")).toEqual([]);
    });
  }
});
