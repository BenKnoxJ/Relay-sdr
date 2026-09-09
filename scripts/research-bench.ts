/**
 * Run the research agent on one brief, offline or live, and write the bench
 * fixture the `/bench` page and the rubric test read.
 *
 *   npx tsx scripts/research-bench.ts fixtures/briefs/research-a-insurance-direct.md \
 *       [--name research-a-insurance-direct] [--tools mock|live|record] [--breadth narrow|standard|wide]
 *
 * The model is always live (there is no recorded model script for research —
 * the point of the bench is to see what the model does). The tools are mock by
 * default, replaying `fixtures/tools/research/<name>/`; `--tools record` calls
 * the providers live and writes that directory, so a brief is recorded once
 * and replayed in CI for ever after. Needs `CLAUDE_CODE_OAUTH_TOKEN` (or the
 * API key), `DATABASE_URL` pointing at a local database, and for `record` or
 * `live` the Tavily and Firecrawl keys.
 *
 * The facts come from the repository's facts file, not from the brief: the
 * brief's inline facts (a 6b convenience) are ignored, and the fixture says so.
 * Stands in for `npm run agent -- research` until PR #14 merges; it writes the
 * same fixture shape.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { agentsDir, loadDefinition } from "@/lib/agents/definitions";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { enqueue } from "@/lib/jobs/queue";
import { mutate } from "@/lib/repo/mutate";
import { deriveBreadth, budgetFor } from "@/lib/research/breadth";
import { scoreRubric } from "@/lib/research/rubric";
import { researchHandler, researchJobInputSchema, type ResearchHandlerDeps } from "@/worker/handlers/research";
import type { ResearchPack } from "../agents/research/output.schema";

type Args = { brief: string; name: string; tools: ResearchHandlerDeps["mode"]; breadth?: "narrow" | "standard" | "wide"; expectInsufficient: boolean; priorFrom?: string };

function parseArgs(argv: string[]): Args {
  const [brief, ...rest] = argv;
  if (brief === undefined) throw new Error("usage: research-bench.ts <brief.md> [--name n] [--tools mock|live|record] [--breadth b] [--expect-insufficient] [--prior-from <fixture name>]");
  const args: Args = { brief, name: path.basename(brief, ".md"), tools: "mock", expectInsufficient: false };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (flag === "--expect-insufficient") {
      args.expectInsufficient = true;
      continue;
    }
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === "--name") args.name = value;
    else if (flag === "--tools" && (value === "mock" || value === "live" || value === "record")) args.tools = value;
    else if (flag === "--breadth" && (value === "narrow" || value === "standard" || value === "wide")) args.breadth = value;
    else if (flag === "--prior-from") args.priorFrom = value;
    else throw new Error(`unknown argument ${flag} ${value}`);
    i += 1;
  }
  return args;
}

function inputFromBrief(markdown: string): unknown {
  const match = /```json\s*\n([\s\S]*?)\n```/.exec(markdown);
  if (match === null) throw new Error("the brief has no ```json block");
  return JSON.parse(match[1]!);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const root = path.dirname(agentsDir());
  const raw = inputFromBrief(readFileSync(args.brief, "utf8")) as Record<string, unknown>;
  const jobInput = researchJobInputSchema.parse({
    brief: raw.brief,
    ...(raw.priorRun === undefined ? {} : { priorRun: raw.priorRun }),
    ...(args.breadth === undefined ? (raw.breadth === undefined ? {} : { breadth: raw.breadth }) : { breadth: args.breadth }),
  });
  const breadth = jobInput.breadth ?? deriveBreadth(jobInput);
  const fixturesDir = path.join(root, "fixtures", "tools", "research", args.name);
  const e = env();
  const deps: ResearchHandlerDeps = {
    mode: args.tools,
    fixturesDir,
    priorKnowledgeDir: e.RELAY_PRIOR_KNOWLEDGE_DIR ?? path.join(root, "fixtures", "prior-knowledge"),
  };

  // One bench org, a job of its own kind so no worker claims it.
  const orgId = "org_bench";
  if ((await prisma.org.findUnique({ where: { id: orgId } })) === null) {
    await mutate(prisma, { orgId, actor: { kind: "system" }, kind: "org.created", apply: (tx) => tx.org.create({ data: { id: orgId, name: "bench" } }) });
  }
  const { job } = await enqueue(prisma, { orgId, kind: "research_bench", idempotencyKey: `bench:research:${args.name}:${randomUUID()}`, input: JSON.parse(JSON.stringify(jobInput)) });
  const started = Date.now();
  let output: ResearchPack | null = null;
  let error: string | null = null;
  let eventId: string | null = null;
  try {
    const result = (await researchHandler(deps)({ db: prisma, job, signal: new AbortController().signal })) as { eventId: string };
    eventId = result.eventId;
    const event = await prisma.event.findUniqueOrThrow({ where: { id: eventId } });
    output = (event.after as { pack: ResearchPack }).pack;
  } catch (thrown) {
    error = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown);
  }
  const durationMs = Date.now() - started;

  const runs = await prisma.agentRun.findMany({ where: { jobId: job.id }, orderBy: { createdAt: "asc" } });
  const steps = await prisma.agentRunStep.findMany({ where: { runId: { in: runs.map((r) => r.id) } }, orderBy: [{ runId: "asc" }, { index: "asc" }] });
  const cost = runs.reduce((sum, run) => sum + Number(run.costTotal), 0);
  const searchQueries = steps.filter((s) => s.kind === "tool" && s.name === "search").map((s) => (s.input as { query?: string } | null)?.query ?? "");
  const event = eventId === null ? null : await prisma.event.findUniqueOrThrow({ where: { id: eventId } });
  const report = (event?.after as { report?: { actuals?: { searches: number; fetches: number; seconds: number } } } | undefined)?.report;

  let priorSeedFirms: string[] | undefined;
  if (args.priorFrom !== undefined) {
    const prior = JSON.parse(readFileSync(path.join(root, "fixtures", "agents", "research", `${args.priorFrom}.json`), "utf8")) as { output: ResearchPack | null };
    priorSeedFirms = prior.output?.seedFirms.map((f) => f.name) ?? [];
  }
  const rubric =
    output === null
      ? []
      : scoreRubric({
          pack: output,
          searchQueries,
          actuals: { ...(report?.actuals ?? { searches: 0, fetches: 0, seconds: Math.round(durationMs / 1000) }), modelSteps: steps.filter((s) => s.kind === "model").length, costUsd: cost },
          budget: budgetFor(breadth),
          expectInsufficient: args.expectInsufficient,
          ...(priorSeedFirms === undefined ? {} : { priorSeedFirms }),
        });

  const validation = output === null ? { ok: false, errors: [error ?? "no output"] } : { ok: loadDefinition("research").output.safeParse(output).success, errors: [] as string[] };
  const fixture = {
    kind: "research",
    name: args.name,
    source: "run",
    recordedAt: new Date().toISOString(),
    live: true,
    tools: args.tools,
    factsNote: "facts from facts/insights360.v1.json (the brief's inline facts are ignored)",
    breadth,
    input: jobInput,
    output,
    run: { steps: steps.length, modelSteps: steps.filter((s) => s.kind === "model").length, toolSteps: steps.filter((s) => s.kind === "tool").length, attempts: runs.length, cost: cost.toFixed(6), durationMs, replayedToolCalls: 0, jobId: job.id, eventId },
    validation,
    error,
    rubric,
  };
  const out = path.join(root, "fixtures", "agents", "research", `${args.name}.json`);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);

  console.log(`# research bench — ${args.name} (${args.tools} tools, ${breadth})`);
  console.log(`- job ${job.id} · runs ${runs.length} · steps ${steps.length} (${fixture.run.modelSteps} model, ${fixture.run.toolSteps} tool) · cost $${cost.toFixed(4)} · ${Math.round(durationMs / 1000)}s`);
  console.log(`- ${error === null ? `event ${eventId}` : `FAILED: ${error}`}`);
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
