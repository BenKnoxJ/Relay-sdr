import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { ToolSet } from "ai";

import { echoTools } from "../agents/echo/tools";
import { loadDefinition, AGENT_KINDS, type AgentKind } from "@/lib/agents/definitions";
import { costMicroDollars, formatMicroDollars, type PricedModel } from "@/lib/agents/pricing";
import type { RunModel } from "@/lib/agents/model";
import { credentialKind, makeModel } from "@/lib/agents/provider";
import { AgentRunFailedError, runAgent } from "@/lib/agents/run";
import type { ToolRecorder } from "@/lib/agents/tools";
import {
  benchFixtureSchema,
  fixtureNameSchema,
  fixturePath,
  repoRoot,
  serialiseFixture,
  validateOutput,
  type BenchFixture,
} from "@/lib/bench/fixture";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { mutate } from "@/lib/repo/mutate";

/**
 * The agent bench, command half.
 *
 *     npm run agent -- <kind> --brief fixtures/briefs/<name>.md [--name <slug>]
 *                      [--live --yes] [--out <path>]
 *
 * One command runs a signed definition through the **real** runtime — the same
 * `runAgent` the worker calls, recording the same steps into the same two
 * tables — and writes down what came back as a fixture the bench can render.
 *
 * Two modes, and the default is the safe one:
 *
 *   * **recorded** (default). The provider is the scripted model from
 *     `src/lib/agents/stubModel.ts`, driven by
 *     `fixtures/recorded/<kind>/<name>.json`. Nothing leaves the machine and
 *     nothing is spent, and the run is byte-identical every time — which is
 *     what makes a fixture a fixture and lets CI run this command.
 *   * **live** (`--live`). The real Messages API, on whichever credential the
 *     environment holds. It costs money, so it prints what it could cost and
 *     then refuses to start without `--yes`.
 *
 * The one thing it writes to the application database is a run: an `orgs` row
 * called `bench` created on first use, a `jobs` row to hang the run off, and
 * then whatever `runAgent` records in `agent_runs` and `agent_run_steps`. No
 * campaign, no person, no draft — the bench is not a seeding tool.
 */

/** The org every bench run is recorded under. Created on first use, never deleted. */
const BENCH_ORG_ID = "org_bench";

/** The model every bench run asks for. Pinned, because the price table is. */
const MODEL_ID: PricedModel = "claude-opus-5";

/**
 * The tool sets that exist as code today.
 *
 * `agents/<kind>/tools.ts` is the tool half of a definition, and only echo has
 * one: research's four read-only tools are Task 12, outreach's lookup is its
 * own task, and lead gen and the orchestrator declare no model-facing tools at
 * all. A kind whose definition grants tools with no builder here is refused
 * rather than run toolless, because a research run with no `search` is not
 * research and a fixture from one would be a lie about the agent.
 */
const TOOL_SETS: Partial<Record<AgentKind, (recorder: ToolRecorder) => ToolSet>> = {
  echo: (recorder) => echoTools(recorder),
};

type Args = {
  kind: AgentKind;
  brief: string;
  name: string;
  live: boolean;
  yes: boolean;
  out: string | undefined;
  recorded: string | undefined;
};

class UsageError extends Error {}

function parseArgs(argv: string[]): Args {
  const [kind, ...rest] = argv;
  if (kind === undefined || kind.startsWith("-")) {
    throw new UsageError(`the first argument is the agent kind, one of ${AGENT_KINDS.join(", ")}`);
  }
  if (!(AGENT_KINDS as readonly string[]).includes(kind)) {
    throw new UsageError(`${JSON.stringify(kind)} is not an agent: expected one of ${AGENT_KINDS.join(", ")}`);
  }

  let brief: string | undefined;
  let name: string | undefined;
  let out: string | undefined;
  let recorded: string | undefined;
  let live = false;
  let yes = false;

  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    // Every value-taking flag reads the next argument and refuses an empty or
    // missing one, so `--brief --live` fails with the flag named rather than
    // quietly treating `--live` as a path.
    const value = (): string => {
      const next = rest[index + 1];
      if (next === undefined || next.startsWith("--")) throw new UsageError(`${flag} needs a value`);
      index += 1;
      return next;
    };
    switch (flag) {
      case "--brief":
        brief = value();
        break;
      case "--name":
        name = value();
        break;
      case "--out":
        out = value();
        break;
      case "--recorded":
        recorded = value();
        break;
      case "--live":
        live = true;
        break;
      case "--yes":
        yes = true;
        break;
      default:
        throw new UsageError(`unknown argument ${JSON.stringify(flag)}`);
    }
  }

  if (brief === undefined) throw new UsageError("--brief is required: the markdown file holding the input");

  const resolved = name ?? path.basename(brief).replace(/\.md$/, "");
  // Checked here, before anything runs. The fixture schema enforces it too, but
  // that parse happens after `runAgent` has returned — so a brief whose stem is
  // not a slug would throw away a completed run, and with `--live` that is paid
  // output nobody can get back.
  const named = fixtureNameSchema.safeParse(resolved);
  if (!named.success) {
    throw new UsageError(
      `${JSON.stringify(resolved)} is not a fixture name: ${named.error.issues.map((issue) => issue.message).join("; ")}. Pass --name.`,
    );
  }

  return {
    kind: kind as AgentKind,
    brief,
    // The brief's own stem, so `fixtures/briefs/print-channel.md` becomes
    // `fixtures/agents/research/print-channel.json` and the two stay findable
    // from one another. `--name` is for the cases where they should differ.
    name: named.data,
    live,
    yes,
    out,
    recorded,
  };
}

/**
 * The input, out of the brief.
 *
 * A brief is a markdown file a person can read, and the input is the first
 * fenced ```json block in it. **Not** YAML front matter, which is what the task
 * brief asked for: research's input is `brief`, `facts` (an array of fact
 * objects), an optional `priorRun` and a breadth, and hand-parsing nested YAML
 * to feed a strict schema is a correctness hazard for no gain — while adding a
 * YAML parser is a dependency this repository does not otherwise need. JSON in
 * a fenced block is exact, diffable, and the prose above it is still the brief.
 */
export function inputFromBrief(markdown: string): unknown {
  const match = /^```json\s*$([\s\S]*?)^```\s*$/m.exec(markdown);
  if (match === null || match[1] === undefined) {
    throw new UsageError("the brief has no ```json block: the agent's input goes in the first one");
  }
  try {
    return JSON.parse(match[1]) as unknown;
  } catch (error) {
    throw new UsageError(`the brief's json block is not valid JSON: ${(error as Error).message}`);
  }
}

/** The org the bench records under, created on first use. */
async function ensureBenchOrg(): Promise<string> {
  const existing = await prisma.org.findUnique({ where: { id: BENCH_ORG_ID } });
  if (existing !== null) return existing.id;
  await mutate(prisma, {
    orgId: BENCH_ORG_ID,
    actor: { kind: "system" },
    kind: "org.created",
    apply: (tx) => tx.org.create({ data: { id: BENCH_ORG_ID, name: "bench" } }),
  });
  return BENCH_ORG_ID;
}

/**
 * A job row for the run to hang off.
 *
 * Written directly rather than enqueued, and the difference matters: `enqueue`
 * puts a `queued` row in front of the worker, and a worker running beside the
 * bench would claim it, find no handler for a kind called `bench`, and fail a
 * job nobody asked it to do. The bench is not asking for work to be done — the
 * work is happening here — so the row is created already `done`, purely as the
 * thing `agent_runs.job_id` points at.
 */
async function benchJob(orgId: string, kind: AgentKind, name: string): Promise<string> {
  const job = await prisma.job.create({
    data: {
      orgId,
      kind: "bench",
      idempotencyKey: `bench:${kind}:${name}:${new Date().toISOString()}`,
      status: "done",
      input: { kind, name },
    },
  });
  return job.id;
}

/** The recorded provider script for a run, or a refusal naming the file. */
function recordedScript(kind: AgentKind, name: string, override: string | undefined): string {
  const file = override ?? path.join(repoRoot(), "fixtures", "recorded", kind, `${name}.json`);
  if (!existsSync(file)) {
    throw new UsageError(
      `no recording at ${file}. A run without --live replays a scripted provider; record one, or re-run with --live.`,
    );
  }
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("model" in parsed)) {
    throw new UsageError(`${file} is not a recording: it needs a "model" object holding the scripted calls`);
  }
  return JSON.stringify((parsed as { model: unknown }).model);
}

/**
 * What a live run could cost, before it is allowed to spend anything.
 *
 * A ceiling and not a forecast, and it says so: the definition's model-step cap
 * times an assumed envelope per call. The point is to make an order of
 * magnitude visible — pennies or pounds — before `--yes`.
 */
const ASSUMED_TOKENS_PER_CALL = { in: 20_000, out: 2_000 };

export function liveCeilingUsd(model: PricedModel, maxModelSteps: number): string {
  // Through `costMicroDollars`, not a second arithmetic: the estimate a person
  // reads before saying yes should come from the same table that will charge
  // them, or the two drift and the estimate becomes fiction.
  const perCall = costMicroDollars(
    {
      tokensIn: ASSUMED_TOKENS_PER_CALL.in,
      tokensInUncached: ASSUMED_TOKENS_PER_CALL.in,
      tokensCacheRead: 0,
      tokensCacheWrite: 0,
      tokensCacheWrite1h: 0,
      tokensOut: ASSUMED_TOKENS_PER_CALL.out,
    },
    model,
  );
  return formatMicroDollars(perCall * BigInt(maxModelSteps));
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const definition = loadDefinition(args.kind);

  if (definition.prompt === null) {
    throw new UsageError(
      `${args.kind} makes no model calls, so there is nothing to run. Its output goes on the bench as a sample fixture.`,
    );
  }
  const declared = definition.tools.length;
  const builder = TOOL_SETS[args.kind];
  if (declared > 0 && builder === undefined) {
    throw new UsageError(
      `${args.kind} grants ${declared} tool(s) (${definition.tools.join(", ")}) and no tool set exists in code yet, so a run would be toolless and the fixture would misrepresent the agent.`,
    );
  }

  const briefPath = path.resolve(args.brief);
  if (!existsSync(briefPath)) throw new UsageError(`no brief at ${briefPath}`);
  const rawInput = inputFromBrief(readFileSync(briefPath, "utf8"));

  const parsedInput = definition.input.safeParse(rawInput);
  if (!parsedInput.success) {
    // Refused before a row is written or a token spent: the input is the one
    // thing that can be checked for free.
    process.stderr.write(`the brief does not match the ${args.kind} input schema:\n`);
    for (const issue of parsedInput.error.issues) {
      process.stderr.write(`  ${issue.path.join(".") || "$"}: ${issue.message}\n`);
    }
    return 1;
  }

  const source = env();
  let model: RunModel;
  if (args.live) {
    if (credentialKind(source) === "none") {
      throw new UsageError(
        "--live needs a credential: set CLAUDE_CODE_OAUTH_TOKEN (the subscription token) or ANTHROPIC_API_KEY.",
      );
    }
    const ceiling = liveCeilingUsd(MODEL_ID, definition.budget.maxModelSteps);
    process.stdout.write(
      `live run: ${args.kind} on ${MODEL_ID}, at most ${definition.budget.maxModelSteps} model call(s).\n` +
        `at ${ASSUMED_TOKENS_PER_CALL.in} in / ${ASSUMED_TOKENS_PER_CALL.out} out per call that is up to about $${ceiling}.\n`,
    );
    if (!args.yes) {
      process.stderr.write("refusing to spend without --yes.\n");
      return 1;
    }
    model = makeModel(MODEL_ID, source);
  } else {
    // The scripted provider is refused by `env()` outside an explicitly
    // development or test environment, and this says so before the parse does,
    // naming the flag that reaches a provider instead.
    if (source.NODE_ENV !== "development" && source.NODE_ENV !== "test") {
      throw new UsageError(
        `a recorded run replays a scripted provider, which is only permitted when NODE_ENV is explicitly "development" or "test" (this resolved to "${source.NODE_ENV}"). Use --live to reach a real provider.`,
      );
    }
    model = makeModel(MODEL_ID, {
      ...source,
      RELAY_AGENT_STUB_MODEL: recordedScript(args.kind, args.name, args.recorded),
    });
  }

  const orgId = await ensureBenchOrg();
  const jobId = await benchJob(orgId, args.kind, args.name);

  const startedAt = Date.now();
  let fixture: BenchFixture;
  let failed = false;
  try {
    const result = await runAgent({
      definition,
      input: parsedInput.data,
      ctx: {
        db: prisma,
        orgId,
        jobId,
        model,
        modelId: MODEL_ID,
        ...(builder === undefined ? {} : { tools: builder }),
      },
    });
    fixture = {
      kind: args.kind,
      name: args.name,
      source: "run",
      recordedAt: new Date().toISOString(),
      live: args.live,
      input: parsedInput.data,
      output: result.object,
      run: {
        steps: result.steps.length,
        modelSteps: result.steps.filter((step) => step.kind === "model").length,
        cost: result.run.costTotal.toFixed(6),
        durationMs: Date.now() - startedAt,
        replayedToolCalls: result.replayedToolCalls,
      },
      // Re-validated here rather than trusted from the runtime: the bench's job
      // is to check, and a validation block copied from the thing being checked
      // proves nothing.
      validation: validateOutput(args.kind, result.object),
    };
  } catch (error) {
    if (!(error instanceof AgentRunFailedError)) throw error;
    failed = true;
    const run = await prisma.agentRun.findUnique({ where: { id: error.runId } });
    const steps = await prisma.agentRunStep.count({ where: { runId: error.runId } });
    const modelSteps = await prisma.agentRunStep.count({ where: { runId: error.runId, kind: "model" } });
    fixture = {
      kind: args.kind,
      name: args.name,
      source: "run",
      recordedAt: new Date().toISOString(),
      live: args.live,
      input: parsedInput.data,
      // There is no output to keep: `runAgent` never returns an answer it
      // refused, by design. What the run cost is kept, because it was spent.
      output: null,
      run: {
        steps,
        modelSteps,
        cost: run?.costTotal.toFixed(6) ?? "0.000000",
        durationMs: Date.now() - startedAt,
        replayedToolCalls: 0,
      },
      validation: { ok: false, errors: [`${error.reason}: ${error.message}`] },
    };
  }

  // Parsed before it is written. A fixture the bench cannot read is worse than
  // no fixture, and this is the only place that makes one.
  const checked = benchFixtureSchema.parse(fixture);
  const file = args.out === undefined ? fixturePath(args.kind, args.name) : path.resolve(args.out);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, serialiseFixture(checked));

  const cost = checked.run === null ? "0.000000" : checked.run.cost;
  process.stdout.write(`${checked.validation.ok ? "ok" : "FAILED"} ${args.kind}/${args.name} → ${file}\n`);
  process.stdout.write(`  ${checked.run?.steps ?? 0} step(s), $${cost}, ${checked.run?.durationMs ?? 0}ms\n`);
  for (const line of checked.validation.errors) process.stderr.write(`  ${line}\n`);

  return failed || !checked.validation.ok ? 1 : 0;
}

main(process.argv.slice(2))
  .then(async (code) => {
    await prisma.$disconnect();
    process.exitCode = code;
  })
  .catch(async (error: unknown) => {
    await prisma.$disconnect().catch(() => undefined);
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      process.stderr.write(
        "usage: npm run agent -- <kind> --brief <path> [--name <slug>] [--live --yes] [--out <path>]\n",
      );
    } else {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    }
    process.exitCode = 1;
  });
