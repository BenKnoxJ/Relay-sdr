import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { AGENT_KINDS, agentsDir, loadDefinition, type AgentKind } from "@/lib/agents/definitions";

/**
 * A bench fixture: one agent's output, kept on disk so it can be looked at.
 *
 * Benny-san's sign-off rule is that no agent is enabled until its output has
 * been run locally, checked against its rubric and seen on the real screen.
 * A fixture is what makes the second and third of those possible without
 * re-running the first: the run happened once, `scripts/agent.ts` wrote down
 * what came back, and the bench renders that file in the components a rep
 * would see it in.
 *
 * Two kinds of fixture, and the difference is honest rather than cosmetic:
 *
 *   * `run` — produced by `npm run agent`. It carries a `run` block, because
 *     something actually happened: steps were recorded, tokens were spent, the
 *     clock ran.
 *   * `sample` — a checked-in output with no run behind it. Four of the five
 *     signed definitions are not runnable yet (`research` is Task 12,
 *     `orchestrator` is Task 7, `leadgen` makes no model calls at all), and
 *     the bench still has to prove their output renders. `run` is `null` and
 *     says so on the screen, so a sample can never be mistaken for evidence
 *     that an agent works.
 *
 * Either way the output is validated against the definition's own schema —
 * `tests/bench/fixtures.test.ts` re-validates every checked-in fixture, so a
 * schema change breaks the fixtures rather than silently outliving them.
 */

/** A fixture name: the file's stem, and a slug so it can sit in a URL. */
export const fixtureNameSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "a fixture name is a lower-case slug");

/** What the run cost and how far it got. Absent for a `sample`. */
export const benchRunSchema = z
  .object({
    /** Every recorded step, model and tool alike. */
    steps: z.number().int().nonnegative(),
    /** Model steps, separately, because that is what the budget caps. */
    modelSteps: z.number().int().nonnegative(),
    /**
     * USD, as a string.
     *
     * A string and not a number: `AgentRun.costTotal` is `Decimal(12, 6)`
     * precisely so that money added up thousands of times does not drift, and
     * putting it through a JSON number would undo that at the first write.
     */
    cost: z.string().regex(/^\d+\.\d{6}$/, "cost is a fixed six-decimal USD string"),
    durationMs: z.number().int().nonnegative(),
    /** How many tool calls were served from a stored step instead of run. */
    replayedToolCalls: z.number().int().nonnegative(),
  })
  .strict();

export type BenchRun = z.infer<typeof benchRunSchema>;

/** The definition's own schema, applied to the output. */
export const benchValidationSchema = z
  .object({
    ok: z.boolean(),
    /** One line per issue, `path: message`. Empty when `ok`. */
    errors: z.array(z.string()).max(200),
  })
  .strict()
  .superRefine((validation, ctx) => {
    if (validation.ok && validation.errors.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["errors"],
        message: "a fixture cannot be valid and carry errors",
      });
    }
    if (!validation.ok && validation.errors.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["errors"],
        message: "an invalid fixture must say what was wrong",
      });
    }
  });

export type BenchValidation = z.infer<typeof benchValidationSchema>;

export const benchFixtureSchema = z
  .object({
    kind: z.enum(AGENT_KINDS),
    name: fixtureNameSchema,
    source: z.enum(["run", "sample"]),
    /** When the run happened, or when the sample was written down. */
    recordedAt: z.string().datetime({ offset: true }),
    /** Whether the run reached the real provider. `false` is the recorded model. */
    live: z.boolean(),
    input: z.unknown(),
    output: z.unknown(),
    run: benchRunSchema.nullable(),
    validation: benchValidationSchema,
  })
  .strict()
  .superRefine((fixture, ctx) => {
    if (fixture.output === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["output"], message: "a fixture must carry an output" });
    }
    if (fixture.input === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["input"], message: "a fixture must carry its input" });
    }
    // A `sample` has no run behind it and must not pretend to; a `run` has one
    // and must not lose it. Checked here rather than left to a reader, because
    // "did this actually run" is the one question the bench exists to answer.
    if (fixture.source === "sample" && fixture.run !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["run"], message: "a sample fixture has no run" });
    }
    if (fixture.source === "run" && fixture.run === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["run"], message: "a run fixture must record its run" });
    }
    if (fixture.source === "sample" && fixture.live) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["live"], message: "a sample fixture did not reach a provider" });
    }
  });

export type BenchFixture = z.infer<typeof benchFixtureSchema>;

/**
 * The repository root, found the way `agentsDir()` finds it.
 *
 * Derived from that function rather than walking again: one answer to "where is
 * the repository", and a deploy that moves `agents/` moves `fixtures/` with it.
 */
export function repoRoot(): string {
  return path.dirname(agentsDir());
}

export function fixturesDir(root: string = repoRoot()): string {
  return path.join(root, "fixtures", "agents");
}

/** Where a fixture lives. */
export function fixturePath(kind: AgentKind, name: string, root?: string): string {
  return path.join(fixturesDir(root), kind, `${name}.json`);
}

/**
 * Run the definition's output schema over a value, as lines a person can read.
 *
 * `safeParse`, never `parse`: the whole point of the bench is to look at output
 * that failed, and a validator that throws hands you a stack trace instead of a
 * screen.
 */
export function validateOutput(kind: AgentKind, output: unknown): BenchValidation {
  const parsed = loadDefinition(kind).output.safeParse(output);
  if (parsed.success) return { ok: true, errors: [] };
  return {
    ok: false,
    errors: parsed.error.issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`),
  };
}

/** Every fixture on disk for a kind, by name, in name order. */
export function listFixtureNames(kind: AgentKind, root?: string): string[] {
  const directory = path.join(fixturesDir(root), kind);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .sort();
}

/** Every kind that has at least one fixture, in the order the definitions list them. */
export function listFixtures(root?: string): { kind: AgentKind; names: string[] }[] {
  return AGENT_KINDS.map((kind) => ({ kind, names: listFixtureNames(kind, root) })).filter(
    (entry) => entry.names.length > 0,
  );
}

/**
 * Read one fixture, parsed.
 *
 * Throws on a file that is not a fixture. The bench catches it and shows the
 * message: a malformed fixture is a thing to fix, not a 500.
 */
export function readFixture(kind: AgentKind, name: string, root?: string): BenchFixture {
  const file = fixturePath(kind, name, root);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`bench: cannot read the fixture at ${file}`, { cause: error });
  }
  const parsed = benchFixtureSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `bench: ${file} is not a fixture: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`).join("; ")}`,
    );
  }
  if (parsed.data.kind !== kind || parsed.data.name !== name) {
    // The path is the identity. A file that disagrees with where it sits would
    // render one agent's output under another's rubric.
    throw new Error(
      `bench: ${file} says it is ${parsed.data.kind}/${parsed.data.name} but sits at ${kind}/${name}`,
    );
  }
  return parsed.data;
}

/** The JSON a fixture file holds, with a trailing newline. */
export function serialiseFixture(fixture: BenchFixture): string {
  return `${JSON.stringify(fixture, null, 2)}\n`;
}
