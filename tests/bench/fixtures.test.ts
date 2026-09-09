import { describe, expect, it } from "vitest";

import { AGENT_KINDS, loadDefinition } from "@/lib/agents/definitions";
import { listFixtureNames, listFixtures, readFixture, validateOutput } from "@/lib/bench/fixture";

/**
 * Every checked-in fixture, re-validated against the definition it belongs to.
 *
 * This is what stops a fixture outliving its schema. A fixture is a file, and a
 * file does not notice when the contract it was written against changes — so a
 * schema tightened in `agents/<kind>/output.schema.ts` breaks this suite rather
 * than quietly leaving the bench rendering something the agent can no longer
 * produce. That is the failure mode the whole task exists to close.
 *
 * The `validation` block inside the fixture is checked against a fresh parse
 * for the same reason: it was written by the command, and a self-report nobody
 * re-derives is not evidence.
 */

describe("fixtures/agents", () => {
  it("has at least one fixture for every signed definition", () => {
    const missing = AGENT_KINDS.filter((kind) => listFixtureNames(kind).length === 0);
    expect(missing).toEqual([]);
  });

  it("every fixture parses, and its output is the shape its definition asks for", () => {
    const problems: string[] = [];
    for (const { kind, names } of listFixtures()) {
      for (const name of names) {
        const fixture = readFixture(kind, name);
        const fresh = validateOutput(kind, fixture.output);
        if (fresh.ok !== fixture.validation.ok) {
          problems.push(`${kind}/${name}: says ok=${fixture.validation.ok}, re-parses as ok=${fresh.ok}`);
        }
        if (!fresh.ok) problems.push(`${kind}/${name}: ${fresh.errors.join("; ")}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("every fixture's input is the shape its definition asks for", () => {
    const problems: string[] = [];
    for (const { kind, names } of listFixtures()) {
      for (const name of names) {
        const fixture = readFixture(kind, name);
        const parsed = loadDefinition(kind).input.safeParse(fixture.input);
        if (!parsed.success) {
          problems.push(
            `${kind}/${name}: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`).join("; ")}`,
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("a sample says so, and never claims a run", () => {
    for (const { kind, names } of listFixtures()) {
      for (const name of names) {
        const fixture = readFixture(kind, name);
        if (fixture.source === "sample") {
          expect(fixture.run, `${kind}/${name}`).toBeNull();
          expect(fixture.live, `${kind}/${name}`).toBe(false);
        } else {
          expect(fixture.run, `${kind}/${name}`).not.toBeNull();
        }
      }
    }
  });

  it("refuses a fixture that sits under the wrong name", () => {
    expect(() => readFixture("echo", "insurance-direct")).toThrow();
  });
});
