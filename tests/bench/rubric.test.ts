import { describe, expect, it } from "vitest";

import { AGENT_KINDS } from "@/lib/agents/definitions";
import { automaticChecks, parseRubric, rubricFor } from "@/lib/bench/rubric";
import type { BenchFixture } from "@/lib/bench/fixture";

/**
 * The checklist is the rubric, parsed — never a second copy of it.
 */

describe("parseRubric", () => {
  it("reads the rows of a three-column table", () => {
    const rows = parseRubric(
      ["# Title", "", "| # | Check | Pass |", "|---|---|---|", "| 1 | Steps | five steps |", "| 2 | Cost | above zero |", ""].join("\n"),
    );
    expect(rows).toEqual([
      { n: "1", check: "Steps", pass: "five steps" },
      { n: "2", check: "Cost", pass: "above zero" },
    ]);
  });

  it("stops at the end of the first table, so a second one is not a checklist", () => {
    const rows = parseRubric(
      [
        "| # | Check | Pass |",
        "|---|---|---|",
        "| 1 | Steps | five steps |",
        "",
        "Some prose.",
        "",
        "| Model | Cost |",
        "|---|---|",
        "| opus | a lot |",
      ].join("\n"),
    );
    expect(rows).toEqual([{ n: "1", check: "Steps", pass: "five steps" }]);
  });

  it("finds no rows in a rubric with no table", () => {
    expect(parseRubric("# Nothing here\n\nJust prose.\n")).toEqual([]);
  });

  it("every signed definition has a checklist with rows", () => {
    for (const kind of AGENT_KINDS) {
      const rows = rubricFor(kind);
      expect(rows.length, kind).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.check, `${kind} row ${row.n}`).not.toBe("");
      }
    }
  });
});

const RAN: BenchFixture = {
  kind: "echo",
  name: "basic",
  source: "run",
  recordedAt: "2026-09-09T00:00:00.000Z",
  live: false,
  input: { text: "x" },
  output: { text: "X" },
  run: { steps: 3, modelSteps: 2, cost: "0.022000", durationMs: 57, replayedToolCalls: 0 },
  validation: { ok: true, errors: [] },
};

describe("automaticChecks", () => {
  it("settles the schema and nothing else for a sample, which never ran", () => {
    const checks = automaticChecks({ ...RAN, source: "sample", run: null });
    expect(checks.map((check) => check.id)).toEqual(["schema"]);
    expect(checks[0]?.passed).toBe(true);
  });

  it("counts a run by its steps, not by what it cost", () => {
    // A run that recorded three steps and rounded to nothing still ran. The
    // earlier form asked `cost > 0` and printed "Nothing ran" beside a detail
    // line reading "3 steps · $0.000000".
    const free = automaticChecks({ ...RAN, run: { ...RAN.run!, cost: "0.000000" } });
    const ran = free.find((check) => check.id === "ran");
    expect(ran?.passed).toBe(true);
    expect(ran?.detail).toContain("3");
    expect(ran?.detail).toContain("$0.000000");
  });

  it("fails the run check when nothing was recorded at all", () => {
    const none = automaticChecks({ ...RAN, run: { ...RAN.run!, steps: 0, modelSteps: 0 } });
    expect(none.find((check) => check.id === "ran")?.passed).toBe(false);
  });

  it("says what was wrong when the output does not validate", () => {
    const bad = automaticChecks({
      ...RAN,
      validation: { ok: false, errors: ["text: Expected string, received number"] },
    });
    expect(bad[0]?.passed).toBe(false);
    expect(bad[0]?.detail).toContain("Expected string");
  });
});
