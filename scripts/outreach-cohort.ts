/**
 * Re-run the outreach cohort with the real model and write the report a
 * person scores, so every change to the outreach prompt or its checks is
 * measured on the same six people in the same way. Since P2 (21 Sep 2026) each
 * person's job drafts the whole sequence and humanizes it, and the report shows
 * every touch's drafted and humanized text side by side.
 *
 *   node --import tsx scripts/outreach-cohort.ts [--source relay_outreach_cohort_dev] \
 *       [--out <dir>] [--cap 5] [--people <n>] [--keep]
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
 *   5. writes `cohort.md` to `--out`: pass, hold and fail per touch kind, cost
 *      per person split between draft and humanizer, and every touch's text
 *      grouped by person; then drops the copy unless `--keep`.
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

type Args = { source: string; out: string; cap: number; keep: boolean; people?: number; exportFixture?: string };

const USAGE = "usage: outreach-cohort.ts [--source <db>] [--out <dir>] [--cap <usd>] [--people <n>] [--keep] [--export-fixture <file>]";

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
    else if (flag === "--people") args.people = Number(value);
    else if (flag === "--export-fixture") args.exportFixture = path.resolve(value);
    else throw new Error(`unknown flag ${flag}\n${USAGE}`);
    i += 1;
  }
  if (!/^[a-z0-9_]+$/.test(args.source)) throw new Error("--source is a plain database name");
  if (!(args.cap > 0 && args.cap <= 20)) throw new Error("--cap is a dollar amount above 0 and at most 20");
  if (args.people !== undefined && !(Number.isInteger(args.people) && args.people > 0)) throw new Error("--people is a whole number above 0");
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
  try {
    execFileSync("npx", ["prisma", "migrate", "deploy"], { stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url } });
  } catch (error) {
    // `main`'s cleanup only covers a copy it was handed, so a copy that could not be migrated goes here.
    console.error(`cohort: migrations failed on ${name}; dropping it`);
    await dropDatabase(base, name).catch((dropError: unknown) => {
      console.error(`cohort: could not drop ${name}: ${dropError instanceof Error ? dropError.message : String(dropError)}`);
    });
    throw error;
  }
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

  let prisma: Db | undefined;
  try {
    ({ prisma } = await import("@/lib/db"));
    if (args.exportFixture !== undefined) {
      await exportFixture(prisma, args.exportFixture, args.source);
      return;
    }
    await runCohort(prisma, args, copy.name);
  } finally {
    await prisma?.$disconnect();
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
  const earlier = await earlierCohort(db);
  // `--people n`: the first n of the earlier cohort, for a cheaper check.
  const people = args.people === undefined ? earlier.people : earlier.people.slice(0, args.people);
  const { template } = earlier;
  const campaignId = template.campaignId!;
  // The earlier drafts go, so the repetition checks read this run's drafts only (a throwaway copy).
  await db.outreachDraft.deleteMany({ where: { campaignId } });

  const handler = outreachDraftHandler(defaultOutreachDeps());
  const stamp = copyName;
  const jobIds: string[] = [];
  const skipped: string[] = [];
  const errors: CohortError[] = [];
  let spent = 0;
  let dearest = 0;
  for (const campaignPersonId of people) {
    const reserve = Math.max(MIN_RESERVE_USD, dearest * 1.5);
    if (spent + reserve > args.cap) {
      skipped.push(campaignPersonId);
      continue;
    }
    let jobId: string | undefined;
    const started = Date.now();
    try {
      // No touch: the job drafts the person's whole sequence, as Write outreach does.
      const { job } = await enqueue(db, {
        orgId: template.orgId,
        ...(template.ownerUserId === null ? {} : { ownerUserId: template.ownerUserId }),
        kind: "outreach_draft",
        idempotencyKey: `cohort:${stamp}:${campaignPersonId}`,
        input: { requestId: `cohort-${stamp}`, campaignPersonId, attempt: 1 },
        campaignId,
        briefVersion: template.briefVersion!,
      });
      jobId = job.id;
      await handler({ db, job, signal: new AbortController().signal });
      const drafts = await db.outreachDraft.findMany({ where: { jobId: job.id } });
      const cost = drafts.reduce((sum, draft) => sum + Number(draft.costUsd), 0);
      spent += cost;
      dearest = Math.max(dearest, cost);
      jobIds.push(job.id);
      console.log(`cohort: ${drafts.map((draft) => `${draft.touch} ${draft.state}`).join(" · ")} · $${cost.toFixed(3)} · ${Math.round((Date.now() - started) / 1000)}s`);
    } catch (error) {
      // One bad job costs that person's row, not the run: what it spent still counts against the cap.
      const runs = jobId === undefined ? [] : await db.agentRun.findMany({ where: { jobId }, select: { costTotal: true } });
      const cost = runs.reduce((sum, run) => sum + Number(run.costTotal), 0);
      spent += cost;
      dearest = Math.max(dearest, cost);
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ campaignPersonId, message, cost });
      console.error(`cohort: error · $${cost.toFixed(3)} · ${message}`);
    }
  }

  const report = await renderReport(db, jobIds, skipped, errors, args, spent);
  mkdirSync(args.out, { recursive: true });
  writeFileSync(path.join(args.out, "cohort.md"), report);
  console.log(`cohort: wrote ${path.join(args.out, "cohort.md")} · spent $${spent.toFixed(3)}`);
}

type CohortError = { campaignPersonId: string; message: string; cost: number };

type Prose = { subject?: string; body?: string; ask?: string; openingLine?: string; oneQuestion?: string; listenFor?: string; voicemail?: string; objections?: { objection: string; answer: string }[] };
type HumanizerLog = { ran?: boolean; skipped?: string; error?: string; touches?: Record<string, { drafted?: Prose; humanized?: Prose | null; kept?: string; reason?: string }> };
type DraftedAfter = { cost?: { draftUsd?: number; humanizerUsd?: number }; humanizer?: HumanizerLog; redraftError?: string };

const TOUCH_NAME: Record<string, string> = {
  email1: "Email 1",
  email2: "Email 2 (follow-up)",
  breakup: "Email 3 (last email)",
  li_connect: "LinkedIn connection note",
  li_dm: "LinkedIn message",
  li_dm2: "LinkedIn follow-up",
  call: "Call script",
};

/** The emails with a subject line; a LinkedIn message, the follow-up in Email 1's thread and a call have none. */
const WITH_SUBJECT = new Set(["email1", "breakup"]);

function proseLines(prose: Prose | null | undefined, touch: string): string {
  if (prose === null || prose === undefined) return "(none)";
  if (prose.body !== undefined) return [prose.subject === undefined || !WITH_SUBJECT.has(touch) ? null : `Subject: ${prose.subject}`, prose.body].filter((line) => line !== null).join("\n\n");
  return [
    `Open with: ${prose.openingLine ?? ""}`,
    `Ask: ${prose.oneQuestion ?? ""}`,
    `Listen for: ${prose.listenFor ?? ""}`,
    ...(prose.voicemail === undefined ? [] : [`Voicemail: ${prose.voicemail}`]),
    ...(prose.objections ?? []).map((pair) => `If they say: ${pair.objection}\nSay: ${pair.answer}`),
  ].join("\n\n");
}

async function renderReport(db: Db, jobIds: string[], skipped: string[], errors: CohortError[], args: Args, spent: number): Promise<string> {
  const { previewFields } = await import("@/lib/outreach/adapter");
  const { loadDefinition } = await import("@/lib/agents/definitions");
  const { SEQUENCE } = await import("../agents/outreach/input.schema");
  const drafts = await db.outreachDraft.findMany({ where: { jobId: { in: jobIds } }, include: { campaignPerson: true } });
  const events = await db.event.findMany({ where: { kind: "outreach.drafted" } });
  const afterOf = (jobId: string): DraftedAfter => (events.find((event) => (event.after as { jobId?: string } | null)?.jobId === jobId)?.after ?? {}) as DraftedAfter;
  const runs = await db.agentRun.findMany({ where: { jobId: { in: jobIds }, kind: "outreach" }, select: { jobId: true, status: true, error: true } });
  const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim() !== "";
  const sha = dirty ? `${head}, with uncommitted changes` : head;
  const definition = loadDefinition("outreach");

  const personRows: string[] = [];
  const sections: string[] = [];
  const draftCosts: number[] = [];
  const humanCosts: number[] = [];
  const totals: number[] = [];
  for (const jobId of jobIds) {
    const own = drafts.filter((draft) => draft.jobId === jobId).sort((a, b) => SEQUENCE.indexOf(a.touch as never) - SEQUENCE.indexOf(b.touch as never));
    const first = own[0];
    if (first === undefined) continue;
    const preview = previewFields(first.campaignPerson.preview);
    const role = ROLE_WORD[first.campaignPerson.rolePart ?? ""] ?? "related";
    const after = afterOf(jobId);
    const draftUsd = after.cost?.draftUsd ?? 0;
    const humanizerUsd = after.cost?.humanizerUsd ?? 0;
    draftCosts.push(draftUsd);
    humanCosts.push(humanizerUsd);
    totals.push(draftUsd + humanizerUsd);
    const jobRuns = runs.filter((run) => run.jobId === jobId);
    const humanizer = after.humanizer ?? {};
    const lookup = first.lookup as { usable?: boolean; items?: unknown[] } | null;
    personRows.push(
      `| ${preview.name} | ${role} | ${own.map((draft) => `${draft.touch}: ${draft.state}`).join(", ")} | ${jobRuns.length} | $${draftUsd.toFixed(3)} | $${humanizerUsd.toFixed(3)} | $${(draftUsd + humanizerUsd).toFixed(3)} |`,
    );
    const touchSections = own.map((draft) => {
      const log = humanizer.touches?.[draft.touch];
      const tierA = findingsOf(draft.findings);
      const tierB = findingsOf(draft.advice);
      return [
        `### ${TOUCH_NAME[draft.touch] ?? draft.touch} · **${draft.state}** · generations: ${draft.generations}${log?.kept === undefined ? "" : ` · kept: ${log.kept}`}`,
        "",
        "**Drafted:**",
        "",
        "```",
        log === undefined ? (draft.body ?? "(not written)") : proseLines(log.drafted, draft.touch),
        "```",
        "",
        "**Humanized:**",
        "",
        "```",
        log === undefined ? `(no humanizer pass: ${humanizer.skipped ?? humanizer.error ?? "not run"})` : proseLines(log.humanized, draft.touch),
        "```",
        "",
        ...(log?.reason === undefined ? [] : [`**Humanized version not kept:** ${log.reason}  `]),
        `**Stored (what the rep sees):** ${draft.subject === null ? "" : `subject "${draft.subject}"; `}ask "${draft.ask ?? "(none)"}"  `,
        `**Opener:** \`${JSON.stringify(draft.opener)}\` · **Claims:** \`${JSON.stringify(draft.claims)}\`  `,
        `**Gate findings (Tier A):** ${tierA.map((finding) => `${finding.rule}: ${finding.text}`).join("; ") || "none"}  `,
        `**Advice (Tier B):** ${tierB.map((finding) => `${finding.rule}: ${finding.text}`).join("; ") || "none"}`,
        "",
      ].join("\n");
    });
    sections.push(
      [
        `## ${preview.name} · ${preview.title}, ${preview.company} · role: ${role}`,
        "",
        `Model runs: ${jobRuns.length} (${jobRuns.map((run) => run.status).join(", ")}${jobRuns.some((run) => run.error !== null) ? `; errors: ${jobRuns.flatMap((run) => (run.error === null ? [] : [run.error.slice(0, 200)])).join(" | ")}` : ""}) · cost: draft $${draftUsd.toFixed(3)}, humanizer $${humanizerUsd.toFixed(3)} · lookup: ${lookup?.usable === true ? `usable, ${lookup.items?.length ?? 0} item(s)` : "nothing usable (role problem used)"}${after.redraftError === undefined ? "" : ` · corrective call error: ${after.redraftError}`}`,
        "",
        ...touchSections,
      ].join("\n"),
    );
  }
  const errored = await db.campaignPerson.findMany({ where: { id: { in: errors.map((error) => error.campaignPersonId) } } });
  for (const error of errors) {
    const row = errored.find((candidate) => candidate.id === error.campaignPersonId);
    const preview = row === undefined ? null : previewFields(row.preview);
    const role = ROLE_WORD[row?.rolePart ?? ""] ?? "related";
    const name = preview?.name ?? error.campaignPersonId;
    personRows.push(`| ${name} | ${role} | error | n/a | n/a | n/a | $${error.cost.toFixed(3)} |`);
    sections.push([`## ${name} · role: ${role} · **error** · cost $${error.cost.toFixed(3)}`, "", `**Error:** ${error.message.replace(/\s+/g, " ").slice(0, 500)}`, ""].join("\n"));
  }

  const kindRows = SEQUENCE.map((kind) => {
    const own = drafts.filter((draft) => draft.touch === kind);
    const count = (state: string) => own.filter((draft) => draft.state === state).length;
    const kept = own.filter((draft) => afterOf(draft.jobId).humanizer?.touches?.[kind]?.kept === "humanized").length;
    const rules = [...new Set(own.flatMap((draft) => findingsOf(draft.findings).map((finding) => finding.rule)))];
    return `| ${TOUCH_NAME[kind]} | ${count("to_review")} | ${count("needs_you")} | ${count("failed")} | ${kept} of ${own.length} | ${rules.join(", ") || "none"} |`;
  });
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  return [
    `# Relay Outreach: full-sequence cohort, drafted and humanized (${today()})`,
    "",
    `Real model (${definition.model ?? "no model"}, effort ${definition.effort ?? "none"}): one call drafts each person's seven touches, the gates run per touch, the failing touches get one corrective call together, then one humanizer call edits the sequence and each humanized touch is gated again. Lookup on the recorded fixtures (\`fixtures/tools/outreach\`), commit \`${sha}\`. A throwaway copy of \`${args.source}\` with the earlier drafts removed; the same people the earlier cohort drafted, one at a time. Written by \`scripts/outreach-cohort.ts\`, spend capped at $${args.cap.toFixed(2)}. Nothing was approved, sent or bought.`,
    "",
    "## Summary per touch kind (after the humanizer)",
    "",
    "| Touch | Pass (to review) | Hold (needs you) | Fail (not written) | Humanized version kept | Tier A rules seen |",
    "|---|---|---|---|---|---|",
    ...kindRows,
    "",
    `- **People drafted:** ${jobIds.length} of ${jobIds.length + skipped.length + errors.length}; **error:** ${errors.length}; **not run** (would pass the cap): ${skipped.length}`,
    `- **Cost per person:** median $${median(totals).toFixed(3)} (draft $${median(draftCosts).toFixed(3)}, humanizer $${median(humanCosts).toFixed(3)})`,
    `- **Cost in total:** $${spent.toFixed(3)} (draft $${sum(draftCosts).toFixed(3)}, humanizer $${sum(humanCosts).toFixed(3)}${errors.length > 0 ? `, errored jobs $${sum(errors.map((error) => error.cost)).toFixed(3)}` : ""})`,
    "",
    "## Per person",
    "",
    "| Person | Role | Touches | Model runs | Draft | Humanizer | Total |",
    "|---|---|---|---|---|---|---|",
    ...personRows,
    "",
    ...sections,
  ].join("\n");
}

/** The source's recorded drafts and the inputs they were written from, as a test fixture. */
async function exportFixture(db: Db, file: string, source: string): Promise<void> {
  const { buildOutreachInput, senderOf } = await import("@/lib/outreach/adapter");
  const { storedPack } = await import("@/lib/campaigns/derive");
  const { findConfirmEvent, handoffOf } = await import("@/lib/repo/leadgen");
  const { findResearchCompletedForJob } = await import("@/lib/repo/research");
  const { latestResearchJob } = await import("@/lib/repo/campaigns");
  const { voiceFor } = await import("@/lib/repo/outreach");
  const { loadFacts } = await import("@/lib/facts/load");
  const { loadStandard } = await import("@/lib/outreach/standard");

  const drafts = await db.outreachDraft.findMany({ where: { touch: "email1" }, include: { campaignPerson: { include: { person: { select: { email: true } } } } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const first = drafts[0];
  if (first === undefined) throw new Error("the source has no drafts");
  const campaign = await db.campaign.findUniqueOrThrow({ where: { id: first.campaignId } });
  const scope = { orgId: campaign.orgId, campaignId: campaign.id, briefVersion: first.briefVersion };
  const handoff = handoffOf((await findConfirmEvent(db, scope))!);
  const researchJob = await latestResearchJob(db, campaign);
  const pack = storedPack((await findResearchCompletedForJob(db, { orgId: campaign.orgId, jobId: researchJob!.id }))!.after)!;
  const facts = loadFacts("insights360", 2).facts;
  const voice = await voiceFor(db, { orgId: campaign.orgId, userId: first.ownerUserId });
  const owner = await db.user.findFirstOrThrow({ where: { id: first.ownerUserId, orgId: campaign.orgId }, select: { name: true, email: true, org: { select: { name: true } } } });
  const sender = senderOf({ userName: owner.name, email: owner.email, orgName: owner.org.name });

  const people = drafts.map((draft) => {
    const input = buildOutreachInput({
      row: draft.campaignPerson,
      email: draft.campaignPerson.person!.email!,
      sender,
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
  const slice = buildOutreachInput({ row: first.campaignPerson, email: "x@example.com", sender, handoff, pack, facts, voice, standard: loadStandard(), lookup: { items: [], usable: false, searches: 0, fetches: 0 }, recentDrafts: [], now: first.createdAt }).pack;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ source, facts: { product: "insights360", version: 2 }, pack: slice, people }, null, 2)}\n`);
  console.log(`cohort: wrote ${file} (${people.length} people)`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
