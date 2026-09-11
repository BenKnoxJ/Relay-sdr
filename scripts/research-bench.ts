/**
 * Run the research agent (v3) on one brief, offline or live, and write the
 * bench fixture the rubric test and the renderer read.
 *
 *   npx tsx scripts/research-bench.ts fixtures/briefs/research-a-insurance-direct.md \
 *       [--name research-a-insurance-direct] [--tools mock|live|record] \
 *       [--expect-insufficient] [--prior-from <fixture name>] [--prior-packs <eventId,...>] \
 *       [--modules m01,m02] [--record-stream]
 *
 * The model is always live (there is no recorded model script for research —
 * the point of the bench is to see what the model does). The tools are mock by
 * default, replaying `fixtures/tools/research/<name>/`; `--tools record` calls
 * the providers live and writes that directory, so a brief is recorded once
 * and replayed in CI for ever after. Needs `CLAUDE_CODE_OAUTH_TOKEN` (or the
 * API key), `DATABASE_URL` pointing at a local database, and for `record` or
 * `live` the Tavily and Firecrawl keys.
 *
 * `--modules` (the steering note plus the named modules only, so one module
 * can be tried live for cents) and `--record-stream` (keep the SDK's message
 * stream under `~/.relay/agents/research/runs/<jobId>/stream.jsonl`) are
 * parsed and validated here, and **refused** until the handler and runtime
 * seams they need exist: a run that looks restricted or recorded and is not
 * would spend a full pack's money, or lose the stream it was run to keep.
 *
 * The facts come from the repository's facts file and the knowledge set from
 * `knowledge/`, not from the brief: the brief's inline facts (a 6b
 * convenience) are ignored, and the fixture says so.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { agentsDir, loadDefinition } from "@/lib/agents/definitions";
import { rejectedAnswerText, validationIssues } from "@/lib/agents/run";
import { prisma } from "@/lib/db";
import { enqueue } from "@/lib/jobs/queue";
import { mutate } from "@/lib/repo/mutate";
import { jobActuals } from "@/lib/repo/research";
import { corpusFromSteps } from "@/lib/research/assemble";
import { createCorpus } from "@/lib/research/corpus";
import { scoreRubric, type RubricReport } from "@/lib/research/rubric";
import { researchHandler, researchJobInputSchema, type ResearchHandlerDeps } from "@/worker/handlers/research";
import { MODULE_IDS, isModuleId, type ModuleId, type PackShape } from "../agents/research/output.schema";

type Args = {
  brief: string;
  name: string;
  tools: ResearchHandlerDeps["mode"];
  expectInsufficient: boolean;
  priorFrom?: string;
  priorPacks: string[];
  modules?: ModuleId[];
  recordStream: boolean;
  /** Resume an existing bench job: every stored call and module replays, and only the unfinished part runs. */
  job?: string;
};

const USAGE =
  "usage: research-bench.ts <brief.md> [--name n] [--tools mock|live|record] [--expect-insufficient] [--prior-from <fixture name>] [--prior-packs <eventId,...>] [--modules m01,m02] [--record-stream] [--job <jobId>]";

function parseArgs(argv: string[]): Args {
  const [brief, ...rest] = argv;
  if (brief === undefined) throw new Error(USAGE);
  const args: Args = { brief, name: path.basename(brief, ".md"), tools: "mock", expectInsufficient: false, priorPacks: [], recordStream: false };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === "--expect-insufficient") {
      args.expectInsufficient = true;
      continue;
    }
    if (flag === "--record-stream") {
      args.recordStream = true;
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value\n${USAGE}`);
    if (flag === "--name") args.name = value;
    else if (flag === "--tools" && (value === "mock" || value === "live" || value === "record")) args.tools = value;
    else if (flag === "--prior-from") args.priorFrom = value;
    else if (flag === "--job") args.job = value;
    else if (flag === "--prior-packs") args.priorPacks = value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    else if (flag === "--modules") args.modules = parseModules(value);
    else throw new Error(`unknown argument ${flag} ${value}\n${USAGE}`);
    i += 1;
  }
  return args;
}

/** The steering note always runs first (§5 step 1); the named modules follow in the definition's order. */
function parseModules(value: string): ModuleId[] {
  const named = value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  const unknown = named.filter((id) => !isModuleId(id));
  if (unknown.length > 0) throw new Error(`--modules: ${unknown.join(", ")} ${unknown.length === 1 ? "is not a module" : "are not modules"}; modules are ${MODULE_IDS.join(", ")}`);
  if (named.length === 0) throw new Error("--modules needs at least one module");
  const wanted = new Set<string>(["m00", ...named]);
  return MODULE_IDS.filter((id) => wanted.has(id));
}

function inputFromBrief(markdown: string): unknown {
  const match = /```json\s*\n([\s\S]*?)\n```/.exec(markdown);
  if (match === null) throw new Error("the brief has no ```json block");
  return JSON.parse(match[1]!);
}

type Fixture = { output?: PackShape | null };

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  const root = path.dirname(agentsDir());
  const raw = inputFromBrief(readFileSync(args.brief, "utf8")) as Record<string, unknown>;
  const jobInput = researchJobInputSchema.parse({
    brief: raw.brief,
    ...(raw.priorRun === undefined ? {} : { priorRun: raw.priorRun }),
    ...(args.priorPacks.length === 0 ? {} : { priorPackIds: args.priorPacks }),
  });
  const fixturesDir = path.join(root, "fixtures", "tools", "research", args.name);
  // `--record-stream`: every raw SDK message, one JSON line each, under the job's run directory.
  let streamFile: string | null = null;
  const deps: ResearchHandlerDeps = {
    mode: args.tools,
    fixturesDir,
    ...(args.modules === undefined ? {} : { onlyModules: args.modules }),
    ...(args.recordStream
      ? {
          onSdkMessage: (message: unknown) => {
            if (streamFile === null) return;
            appendFileSync(streamFile, `${JSON.stringify(message)}\n`);
          },
        }
      : {}),
  };
  const budget = loadDefinition("research").budget;

  // One bench org, a job of its own kind so no worker claims it.
  const orgId = "org_bench";
  if ((await prisma.org.findUnique({ where: { id: orgId } })) === null) {
    await mutate(prisma, { orgId, actor: { kind: "system" }, kind: "org.created", apply: (tx) => tx.org.create({ data: { id: orgId, name: "bench" } }) });
  }
  // `--job`: resume that job (its stored calls and modules replay for free); otherwise a new one.
  const job =
    args.job === undefined
      ? (await enqueue(prisma, { orgId, kind: "research_bench", idempotencyKey: `bench:research:${args.name}:${randomUUID()}`, input: JSON.parse(JSON.stringify(jobInput)) })).job
      : await prisma.job.findUniqueOrThrow({ where: { id: args.job } });
  if (args.recordStream) {
    const runDir = path.join(homedir(), ".relay", "agents", "research", "runs", job.id);
    mkdirSync(runDir, { recursive: true });
    streamFile = path.join(runDir, "stream.jsonl");
    console.log(`recording the SDK stream to ${streamFile}`);
  }
  const started = Date.now();
  let output: PackShape | null = null;
  let report: (RubricReport & { actuals?: { searches: number; fetches: number; fetchedChars?: number; seconds: number } }) | undefined;
  let error: string | null = null;
  let eventId: string | null = null;
  let rejected: { issues: string[]; text: string | null } | null = null;
  try {
    const result = (await researchHandler(deps)({ db: prisma, job, signal: new AbortController().signal })) as { eventId: string };
    eventId = result.eventId;
    const event = await prisma.event.findUniqueOrThrow({ where: { id: eventId } });
    const after = event.after as { pack: PackShape; report?: typeof report };
    output = after.pack;
    report = after.report;
  } catch (thrown) {
    error = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown);
    // A closing answer the schema refused is the most useful thing a failed
    // run can leave behind; the subprocess that wrote it is gone by now.
    rejected = { issues: validationIssues(thrown), text: rejectedAnswerText(thrown) };
    if (rejected.text !== null) {
      const dir = path.join(homedir(), ".relay", "agents", "research", "runs");
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "")}-${args.name}-rejected.json`);
      writeFileSync(file, `${JSON.stringify({ issues: rejected.issues, text: rejected.text }, null, 2)}\n`);
      console.error(`rejected answer written to ${file}`);
    }
  }
  const durationMs = Date.now() - started;

  const runs = await prisma.agentRun.findMany({ where: { jobId: job.id }, orderBy: { createdAt: "asc" } });
  const steps = await prisma.agentRunStep.findMany({ where: { runId: { in: runs.map((r) => r.id) } }, orderBy: [{ runId: "asc" }, { index: "asc" }] });
  const cost = runs.reduce((sum, run) => sum + Number(run.costTotal), 0);
  const searches = steps
    .filter((s) => s.kind === "tool" && s.name === "search")
    .map((s) => {
      const input = s.input as { query?: string; purpose?: string } | null;
      return { query: input?.query ?? "", ...(input?.purpose === undefined ? {} : { purpose: input.purpose }) };
    });
  const modelSteps = steps.filter((s) => s.kind === "model").length;
  const moduleWrites = steps.filter((s) => s.kind === "tool" && s.name === "writeModule").length;
  // v3.2: the whole job's totals, across resumes; the job's calls in order (row 8); the pages it read (the place check).
  const actuals = await jobActuals(prisma, { orgId, jobId: job.id });
  const runOrder = new Map(runs.map((run, i) => [run.id, i]));
  const toolSteps = steps.filter((s) => s.kind === "tool").sort((a, b) => (runOrder.get(a.runId) ?? 0) - (runOrder.get(b.runId) ?? 0) || a.index - b.index);
  const record = toolSteps.map((s) => {
    const input = s.input as { module?: unknown } | null;
    const out = s.output as { accepted?: unknown; verdict?: unknown } | null;
    return {
      run: runOrder.get(s.runId) ?? 0,
      name: s.name,
      ...(typeof input?.module === "string" ? { module: input.module } : {}),
      ...(typeof out?.verdict === "string" ? { verdict: out.verdict } : {}),
      ...(typeof out?.accepted === "boolean" ? { accepted: out.accepted } : {}),
    };
  });
  const corpus = createCorpus();
  corpusFromSteps(corpus, toolSteps);
  const pageText = (url: string): string | undefined => (corpus.has(url) ? corpus.textFor(url) : undefined);

  // Row 10 (§10 note 29): the prior pack's seed firms by identity and the geography it covered.
  let prior: { seedFirms: Array<{ name: string; domain?: string }>; countries: string[]; places: string[] } | undefined;
  if (args.priorFrom !== undefined) {
    const recorded = JSON.parse(readFileSync(path.join(root, "fixtures", "research",`${args.priorFrom}.json`), "utf8")) as Fixture;
    if (recorded.output != null && recorded.output.modules === undefined) throw new Error(`--prior-from ${args.priorFrom} was recorded under research v2; re-record it first`);
    const m04 = (recorded.output?.modules as { m04?: { perArchetype?: Array<{ recipe: { countries: string[] }; seedFirms: Array<{ name: string; domain?: string }> }> } } | undefined)?.m04;
    const targets = m04?.perArchetype ?? [];
    prior = {
      seedFirms: targets.flatMap((t) => t.seedFirms.map((f) => ({ name: f.name, ...(f.domain === undefined ? {} : { domain: f.domain }) }))),
      countries: [...new Set(targets.flatMap((t) => t.recipe.countries))],
      places: (recorded.output?.scope?.places ?? []).map((p) => p.name),
    };
  }
  const rubric =
    output === null
      ? []
      : scoreRubric({
          pack: output,
          searches,
          actuals: { searches: actuals.searches, fetches: actuals.fetches, fetchedChars: actuals.fetchedChars, seconds: actuals.elapsedSeconds, modelSteps: actuals.modelSteps, costUsd: actuals.costUsd },
          budget,
          expectInsufficient: args.expectInsufficient,
          record,
          pageText,
          ...(report === undefined ? {} : { report }),
          ...(prior === undefined ? {} : { prior }),
          ...(jobInput.priorRun === undefined ? {} : { widenedBy: jobInput.priorRun.widenedBy }),
          ...(args.modules === undefined ? {} : { onlyModules: args.modules }),
        });

  const fixture = {
    kind: "research",
    contract: "v3.2",
    name: args.name,
    source: "run",
    recordedAt: new Date().toISOString(),
    live: true,
    tools: args.tools,
    factsNote: "facts from facts/insights360.v2.json and the knowledge set from knowledge/insights360/v1 (the brief's inline facts are ignored)",
    input: jobInput,
    output,
    report: report ?? null,
    // The whole job, across every run and resume; `cost` is summed from the steps, so an unfinished run counts too.
    run: { steps: steps.length, modelSteps, toolSteps: toolSteps.length, moduleWrites, attempts: runs.length, cost: actuals.costUsd.toFixed(6), runsCostTotal: cost.toFixed(6), durationMs, jobId: job.id, eventId, actuals },
    record,
    error,
    rejectedIssues: rejected?.issues ?? null,
    rubric,
  };
  const out = path.join(root, "fixtures", "research",`${args.name}.json`);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);

  console.log(`# research bench — ${args.name} (${args.tools} tools, v3)`);
  console.log(`- job ${job.id} · runs ${runs.length} · steps ${steps.length} (${modelSteps} model, ${fixture.run.toolSteps} tool, ${moduleWrites} module writes) · cost $${cost.toFixed(4)} · ${Math.round(durationMs / 1000)}s`);
  console.log(`- ${error === null ? `event ${eventId}` : `FAILED: ${error}`}`);
  if (output !== null) console.log(`- ${output.partial ? `PARTIAL, missing ${output.missingModules.join(", ")}` : "every module written"}`);
  console.log(`- fixture: ${path.relative(root, out)}${existsSync(fixturesDir) ? ` · tool recordings: ${path.relative(root, fixturesDir)}` : ""}`);
  if (rubric.length > 0) {
    console.log("\n| # | check | verdict | detail |\n|---|---|---|---|");
    for (const row of rubric) console.log(`| ${row.check} | ${row.name} | ${row.verdict} | ${row.detail} |`);
  }
  return error === null ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
