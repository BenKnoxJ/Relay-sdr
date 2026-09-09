import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { researchOutputSchema, type ResearchPack } from "../../agents/research/output.schema";
import { agentsDir } from "@/lib/agents/definitions";
import { scoreRubric, type RubricRow } from "@/lib/research/rubric";

/**
 * The twelve checks (research v2 §8) over the recorded bench runs of the four
 * briefs, in CI, from `fixtures/agents/research/<brief>.json` — what
 * `scripts/research-bench.ts` wrote after a live run.
 *
 * Checks 3 (provenance) and 9 (replay) have their own tests; 12 is on screen.
 * A brief that has not been recorded yet is reported, not failed: the live
 * run is the gate that produces the fixture, and this test is the gate that
 * keeps it honest afterwards.
 */

const DIR = path.join(path.dirname(agentsDir()), "fixtures", "agents", "research");

type Fixture = {
  name: string;
  breadth: "narrow" | "standard" | "wide";
  output: ResearchPack | null;
  run: { modelSteps: number; cost: string; durationMs: number } | null;
  rubric: RubricRow[];
  error: string | null;
};

const BRIEFS: Record<string, { expectInsufficient: boolean; priorFrom?: string; required: number[] }> = {
  "research-a-insurance-direct": { expectInsufficient: false, required: [1, 2, 4, 5, 6, 7, 11] },
  "research-b-print-channel": { expectInsufficient: false, required: [1, 2, 4, 5, 6, 7, 11] },
  "research-c-thin-vets": { expectInsufficient: true, required: [1, 8, 11] },
  "research-d-insurance-rerun": { expectInsufficient: false, priorFrom: "research-a-insurance-direct", required: [1, 2, 5, 6, 10, 11] },
};

function load(name: string): Fixture | null {
  const file = path.join(DIR, `${name}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Fixture) : null;
}

describe("the research rubric over the recorded briefs", () => {
  const recorded = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith(".json")) : [];
  it("reports which briefs have been recorded", () => {
    console.log(`recorded research fixtures: ${recorded.length === 0 ? "none yet" : recorded.join(", ")}`);
    expect(Array.isArray(recorded)).toBe(true);
  });

  for (const [name, spec] of Object.entries(BRIEFS)) {
    const fixture = load(name);
    const run = fixture === null ? it.skip : it;
    run(`${name}: the required checks pass`, () => {
      if (fixture === null) return;
      expect(fixture.error, `the run failed: ${fixture.error}`).toBeNull();
      expect(fixture.output).not.toBeNull();
      const pack = researchOutputSchema.parse(fixture.output);
      const prior = spec.priorFrom === undefined ? undefined : load(spec.priorFrom)?.output?.seedFirms.map((f) => f.name);
      const rows = scoreRubric({ pack, expectInsufficient: spec.expectInsufficient, ...(prior === undefined ? {} : { priorSeedFirms: prior }) });
      // The fixture's own rubric (scored with the run's steps and actuals) is
      // the fuller record; the pack-only rows here must agree with it.
      const stored = new Map(fixture.rubric.map((row) => [row.check, row]));
      const failures = spec.required
        .map((check) => stored.get(check) ?? rows.find((row) => row.check === check))
        .filter((row): row is RubricRow => row !== undefined && row.verdict === "fail");
      expect(failures, failures.map((row) => `${row.check} ${row.name}: ${row.detail}`).join("\n")).toEqual([]);
    });
  }
});
