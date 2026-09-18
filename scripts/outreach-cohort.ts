/**
 * Re-run the first-email cohort with the real model and write the report a
 * person scores, so every change to the outreach prompt or its checks is
 * measured on the same six people in the same way.
 *
 *   node --import tsx scripts/outreach-cohort.ts [--source relay_outreach_cohort_dev] \
 *       [--out <dir>] [--cap 5] [--keep]
 *   node --import tsx scripts/outreach-cohort.ts --export-fixture fixtures/outreach/cohort-2026-09-15.json
 *
 * What it does, in order:
 *
 *   1. copies `--source` (the walkthrough database at People ready, with the
 *      earlier cohort's drafts) to a throwaway `relay_cohort_<stamp>_dev` on the
 *      same server, and applies the repository's migrations to the copy; the
 *      database `DATABASE_URL` names is never the source and never written;
 *   2. removes the copy's earlier drafts, so the repetition checks read only
 *      this run's, and queues one fresh `outreach_draft` job for each person
 *      the earlier cohort drafted;
 *   3. runs the real draft handler on each job in turn: the lookup replays the
 *      recorded answers in `fixtures/tools/outreach` (`INTEGRATIONS=mock`,
 *      forced), and the model is the real one on the local worker's
 *      credential (`.env`); no Lusha, Microsoft or Zoho call is made;
 *   4. stops before a draft that could take the run past `--cap` dollars;
 *   5. writes `cohort.md` to `--out` in the 15 Sep format, with a summary, and
 *      drops the copy unless `--keep`.
 *
 * `--export-fixture` does steps 1 and 5's reading only: it writes the source's
 * recorded drafts and the inputs they were written from as a test fixture, and
 * makes no model call.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { PrismaClient } from "@prisma/client";

type Args = { source: string; out: string; cap: number; keep: boolean; exportFixture?: string };

const USAGE = "usage: outreach-cohort.ts [--source <db>] [--out <dir>] [--cap <usd>] [--keep] [--export-fixture <file>]";

/** What one more draft may cost at most, for the cap check: the dearest draft seen so far with headroom, never under this. */
const MIN_RESERVE_USD = 0.75;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { source: "relay_outreach_cohort_dev", out: path.join(homedir(), "vault", "ops", "design", "qa", `${today()}-relay-m0-cohort`), cap: 5, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--keep") {
      args.keep = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value\n${USAGE}`);
    if (flag === "--source") args.source = value;
    else if (flag === "--out") args.out = path.resolve(value);
    else if (flag === "--cap") args.cap = Number(value);
    else if (flag === "--export-fixture") args.exportFixture = path.resolve(value);
    else throw new Error(`unknown flag ${flag}\n${USAGE}`);
    i += 1;
  }
  if (!/^[a-z0-9_]+$/.test(args.source)) throw new Error("--source is a plain database name");
  if (!(args.cap > 0 && args.cap <= 20)) throw new Error("--cap is a dollar amount above 0 and at most 20");
  return args;
}

function withDatabase(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

function databaseOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}

/** A copy of `source` with the repository's migrations applied. */
async function copyDatabase(base: string, source: string): Promise<{ name: string; url: string }> {
  if (source === databaseOf(base)) throw new Error(`refusing: ${source} is the database DATABASE_URL names`);
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
  const name = `relay_cohort_${stamp}_dev`;
  const admin = new PrismaClient({ datasourceUrl: withDatabase(base, "postgres") });
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}" TEMPLATE "${source}"`);
  } finally {
    await admin.$disconnect();
  }
  const url = withDatabase(base, name);
  execFileSync("npx", ["prisma", "migrate", "deploy"], { stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url } });
  return { name, url };
}

async function dropDatabase(base: string, name: string): Promise<void> {
  const admin = new PrismaClient({ datasourceUrl: withDatabase(base, "postgres") });
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.$disconnect();
  }
}

type Finding = { rule: string; text: string };

function findingsOf(value: unknown): Finding[] {
  return Array.isArray(value) ? (value as Finding[]) : [];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

const ROLE_WORD: Record<string, string> = { runs: "runs", champions: "champions", signs: "signs" };

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (existsSync(".env")) process.loadEnvFile(".env");
  const base = process.env.DATABASE_URL;
  if (base === undefined || base === "") throw new Error("DATABASE_URL is not set (the local worker's .env)");
  if (args.exportFixture === undefined && process.env.CLAUDE_CODE_OAUTH_TOKEN === undefined && process.env.ANTHROPIC_API_KEY === undefined) {
    throw new Error("no model credential in the local worker setup; stopping");
  }

  const copy = await copyDatabase(base, args.source);
  console.log(`cohort: copied ${args.source} to ${copy.name}`);
  // Every module below reads its configuration once, at import, so the copy and the recorded lookups are set first.
  process.env.DATABASE_URL = copy.url;
  process.env.DIRECT_URL = copy.url;
  // Development, so the recorded lookups (mock) are allowed at all.
  Object.assign(process.env, { INTEGRATIONS: "mock", NODE_ENV: "development" });
  for (const key of ["RELAY_OUTREACH_FIXTURE_DRAFTS", "RELAY_OUTREACH_FIXTURES", "RELAY_AGENT_STUB_MODEL", "RELAY_TOOL_RECORD", "RELAY_TOOL_FIXTURES"]) delete process.env[key];

  const { prisma } = await import("@/lib/db");
  try {
    if (args.exportFixture !== undefined) {
      await exportFixture(prisma, args.exportFixture, args.source);
      return;
    }
    await runCohort(prisma, args, copy.name);
  } finally {
    await prisma.$disconnect();
    if (args.keep) console.log(`cohort: kept ${copy.name}`);
    else await dropDatabase(base, copy.name);
  }
}

type Db = Awaited<typeof import("@/lib/db")>["prisma"];

/** The six people and their campaign, read off the earlier cohort's jobs. */
async function earlierCohort(db: Db) {
  const jobs = await db.job.findMany({ where: { kind: "outreach_draft" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  if (jobs.length === 0) throw new Error("the source has no earlier cohort to repeat");
  const people = [...new Set(jobs.map((job) => (job.input as { campaignPersonId: string }).campaignPersonId))];
  const first = jobs[0]!;
  if (jobs.some((job) => job.campaignId !== first.campaignId || job.briefVersion !== first.briefVersion)) throw new Error("the earlier cohort spans more than one campaign version");
  return { people, template: first };
}

async function runCohort(db: Db, args: Args, copyName: string): Promise<void> {
  const { enqueue } = await import("@/lib/jobs/queue");
  const { outreachDraftHandler, defaultOutreachDeps } = await import("@/worker/handlers/outreachDraft");
  const { people, template } = await earlierCohort(db);
  const campaignId = template.campaignId!;
  // The earlier drafts go, so the repetition checks read this run's drafts only (a throwaway copy).
  await db.outreachDraft.deleteMany({ where: { campaignId } });

  const handler = outreachDraftHandler(defaultOutreachDeps());
  const stamp = copyName;
  const draftIds: string[] = [];
  const skipped: string[] = [];
  let spent = 0;
  let dearest = 0;
  for (const campaignPersonId of people) {
    const reserve = Math.max(MIN_RESERVE_USD, dearest * 1.5);
    if (spent + reserve > args.cap) {
      skipped.push(campaignPersonId);
      continue;
    }
    const { job } = await enqueue(db, {
      orgId: template.orgId,
      ...(template.ownerUserId === null ? {} : { ownerUserId: template.ownerUserId }),
      kind: "outreach_draft",
      idempotencyKey: `cohort:${stamp}:${campaignPersonId}`,
      input: { requestId: `cohort-${stamp}`, campaignPersonId, attempt: 1 },
      campaignId,
      briefVersion: template.briefVersion!,
    });
    const started = Date.now();
    const result = (await handler({ db, job, signal: new AbortController().signal })) as { draftId: string };
    const draft = await db.outreachDraft.findUniqueOrThrow({ where: { id: result.draftId } });
    const cost = Number(draft.costUsd);
    spent += cost;
    dearest = Math.max(dearest, cost);
    draftIds.push(draft.id);
    console.log(`cohort: ${draft.state} · ${draft.generations} generation(s) · $${cost.toFixed(3)} · ${Math.round((Date.now() - started) / 1000)}s`);
  }

  const report = await renderReport(db, draftIds, skipped, args, spent);
  mkdirSync(args.out, { recursive: true });
  writeFileSync(path.join(args.out, "cohort.md"), report);
  console.log(`cohort: wrote ${path.join(args.out, "cohort.md")} · spent $${spent.toFixed(3)}`);
}

async function renderReport(db: Db, draftIds: string[], skipped: string[], args: Args, spent: number): Promise<string> {
  const { previewFields } = await import("@/lib/outreach/adapter");
  const { loadDefinition } = await import("@/lib/agents/definitions");
  const drafts = await db.outreachDraft.findMany({ where: { id: { in: draftIds } }, include: { campaignPerson: true } });
  drafts.sort((a, b) => draftIds.indexOf(a.id) - draftIds.indexOf(b.id));
  const runs = await db.agentRun.findMany({ where: { jobId: { in: drafts.map((draft) => draft.jobId) }, kind: "outreach" }, select: { jobId: true, status: true, error: true } });
  const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim() !== "";
  const sha = dirty ? `${head}, with uncommitted changes` : head;
  const model = loadDefinition("outreach").model;

  const rows: string[] = [];
  const sections: string[] = [];
  for (const draft of drafts) {
    const preview = previewFields(draft.campaignPerson.preview);
    const role = ROLE_WORD[draft.campaignPerson.rolePart ?? ""] ?? "related";
    const tierA = findingsOf(draft.findings);
    const tierB = findingsOf(draft.advice);
    const lookup = draft.lookup as { usable?: boolean; items?: unknown[] } | null;
    const itemCount = lookup?.items?.length ?? 0;
    const jobRuns = runs.filter((run) => run.jobId === draft.jobId);
    const shapeMisses = jobRuns.filter((run) => run.status === "failed").length;
    rows.push(
      `| ${preview.name} | ${role} | ${draft.state} | ${draft.generations} | ${shapeMisses} | $${Number(draft.costUsd).toFixed(3)} | ${tierA.map((finding) => finding.rule).join(", ") || "none"} |`,
    );
    const body = draft.body ?? "(no body: the draft could not be written)";
    sections.push(
      [
        `## ${preview.name} · ${preview.title}, ${preview.company} · role: ${role} · state: **${draft.state}** · generations: ${draft.generations} · cost $${Number(draft.costUsd).toFixed(3)}`,
        "",
        `**Subject:** ${draft.subject ?? "(none)"}`,
        "",
        "```",
        body,
        "```",
        "",
        `**Ask:** ${draft.ask ?? "(none)"}`,
        "",
        `**Opener:** \`${JSON.stringify(draft.opener)}\`  `,
        `**Claims:** \`${JSON.stringify(draft.claims)}\`  `,
        `**Gate findings (Tier A):** ${tierA.map((finding) => `${finding.rule}: ${finding.text}`).join("; ") || "none"}  `,
        `**Advice (Tier B):** ${tierB.map((finding) => JSON.stringify(finding)).join("; ") || "none"}  `,
        `**Generations that did not come back in shape:** ${shapeMisses}${jobRuns.filter((run) => run.status === "failed").map((run) => ` (${run.error ?? ""})`).join("")}  `,
        `**Lookup:** ${lookup?.usable === true ? `usable, ${itemCount} item(s)` : "nothing usable (role problem used)"}`,
        "",
      ].join("\n"),
    );
  }

  const count = (state: string) => drafts.filter((draft) => draft.state === state).length;
  const costs = drafts.map((draft) => Number(draft.costUsd));
  const shapeFailed = drafts.filter((draft) => findingsOf(draft.findings).some((finding) => finding.rule === "shape")).length;
  const missedGenerations = runs.filter((run) => run.status === "failed").length;
  return [
    `# Relay Outreach: first-email cohort (${today()})`,
    "",
    `Real model drafts (${model ?? "no model"}), lookup on the recorded fixtures (\`fixtures/tools/outreach\`), gates live, commit \`${sha}\`. A throwaway copy of \`${args.source}\` with the earlier drafts removed; the same people the earlier cohort drafted, one at a time. Written by \`scripts/outreach-cohort.ts\`, spend capped at $${args.cap.toFixed(2)}. Nothing was approved, sent or bought.`,
    "",
    "## Summary",
    "",
    `- **Pass** (to review): ${count("to_review")} of ${drafts.length + skipped.length}`,
    `- **Hold** (needs you): ${count("needs_you")}`,
    `- **Fail** (not written): ${count("failed")}; of those, for shape: ${shapeFailed}`,
    `- **Generations that did not come back in shape:** ${missedGenerations}`,
    `- **Not run** (would pass the cap): ${skipped.length}`,
    `- **Cost:** total $${spent.toFixed(3)}, median per draft $${median(costs).toFixed(3)}`,
    "",
    "| Person | Role | State | Generations | Out of shape | Cost | Tier A rules |",
    "|---|---|---|---|---|---|---|",
    ...rows,
    "",
    ...sections,
  ].join("\n");
}

/** The source's recorded drafts and the inputs they were written from, as a test fixture. */
async function exportFixture(db: Db, file: string, source: string): Promise<void> {
  const { buildOutreachInput } = await import("@/lib/outreach/adapter");
  const { storedPack } = await import("@/lib/campaigns/derive");
  const { findConfirmEvent, handoffOf } = await import("@/lib/repo/leadgen");
  const { findResearchCompletedForJob } = await import("@/lib/repo/research");
  const { latestResearchJob } = await import("@/lib/repo/campaigns");
  const { voiceFor } = await import("@/lib/repo/outreach");
  const { loadFacts } = await import("@/lib/facts/load");
  const { loadStandard } = await import("@/lib/outreach/standard");

  const drafts = await db.outreachDraft.findMany({ include: { campaignPerson: { include: { person: { select: { email: true } } } } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const first = drafts[0];
  if (first === undefined) throw new Error("the source has no drafts");
  const campaign = await db.campaign.findUniqueOrThrow({ where: { id: first.campaignId } });
  const scope = { orgId: campaign.orgId, campaignId: campaign.id, briefVersion: first.briefVersion };
  const handoff = handoffOf((await findConfirmEvent(db, scope))!);
  const researchJob = await latestResearchJob(db, campaign);
  const pack = storedPack((await findResearchCompletedForJob(db, { orgId: campaign.orgId, jobId: researchJob!.id }))!.after)!;
  const facts = loadFacts("insights360", 2).facts;
  const voice = await voiceFor(db, { orgId: campaign.orgId, userId: first.ownerUserId });

  const people = drafts.map((draft) => {
    const input = buildOutreachInput({
      row: draft.campaignPerson,
      email: draft.campaignPerson.person!.email!,
      handoff,
      pack,
      facts,
      voice,
      standard: loadStandard(),
      lookup: draft.lookup as never,
      recentDrafts: [],
      now: draft.createdAt,
    });
    const opener = draft.opener as { ref: string; kind: string } | null;
    return {
      name: input.person.name,
      state: draft.state,
      findings: findingsOf(draft.findings).map((finding) => finding.rule),
      // The inputs without the parts every person shares and the tests load themselves.
      input: { ...input, pack: undefined, facts: undefined, standard: undefined },
      draft:
        draft.body === null || opener === null
          ? null
          : { kind: "message", ...(draft.subject === null ? {} : { subject: draft.subject }), body: draft.body, ask: draft.ask, opener: { ref: opener.ref, kind: opener.kind }, claims: draft.claims },
    };
  });
  const slice = buildOutreachInput({ row: first.campaignPerson, email: "x@example.com", handoff, pack, facts, voice, standard: loadStandard(), lookup: { items: [], usable: false, searches: 0, fetches: 0 }, recentDrafts: [], now: first.createdAt }).pack;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ source, facts: { product: "insights360", version: 2 }, pack: slice, people }, null, 2)}\n`);
  console.log(`cohort: wrote ${file} (${people.length} people)`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
