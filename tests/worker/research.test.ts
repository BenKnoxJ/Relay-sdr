import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import goodPack from "../../agents/research/fixtures/output.good.json";
import { packItems, researchOutputSchema, type ResearchPack } from "../../agents/research/output.schema";
import { prisma } from "@/lib/db";
import { loadFacts } from "@/lib/facts/load";
import { RESEARCH_COMPLETED } from "@/lib/repo/research";
import { fetchDiscriminator, searchDiscriminator, writeRecording } from "@/lib/services";
import { TerminalError } from "@/worker/errors";
import { researchHandler, withUnreadableUnknowns, type ResearchHandlerDeps } from "@/worker/handlers/research";

import { emptyAll, resetDatabase } from "../db/harness";
import { ORG_ID, scriptedModel, seedJob, seedOrg, type ScriptedCall } from "../agents/harness";

/**
 * The research job on the worker's handler, with the scripted model and the
 * mock providers: the happy path, the automatic provenance re-run, the second
 * failure, the cap, the runtime's own unknowns, and one Event per job.
 */

const dir = mkdtempSync(path.join(tmpdir(), "relay-research-handler-"));
const facts = loadFacts("insights360", 1);
const LIVE_ID = [...facts.facts.facts].find((fact) => fact.status === "live")!.id;
const PAGE_URL = "https://claims.example/backlog";
const DEAD_URL = "https://dead.example/gone";
const QUERY = { query: "claims backlog UK insurers", region: "GB" };

/** Where item number `i` is cited: its own domain, so the pack stays under the domain cap. */
const itemUrl = (i: number): string => `https://source-${i}.example/page`;

/** The good fixture, made citable: every item points at its own recorded page, and the hook cites a live fact. */
function citablePack(): ResearchPack {
  const pack = researchOutputSchema.parse(structuredClone(goodPack));
  packItems(pack).forEach((item, i) => {
    item.evidence = { urls: [itemUrl(i)], primary: item.evidence.primary, domains: [`source-${i}.example`] };
    if (item.confidence === "strong" && !item.evidence.primary) item.confidence = "weak";
    if (item.confidence === "moderate") item.confidence = "weak";
  });
  pack.hook.answeredBy = [LIVE_ID];
  return pack;
}

/** One recorded page per item, carrying the item's text, so provenance can pass. */
function recordPages(pack: ResearchPack): void {
  packItems(pack).forEach((item, i) => {
    writeRecording(dir, "scrape", fetchDiscriminator(itemUrl(i)), { tool: "scrape", args: { url: itemUrl(i) }, response: { markdown: `${item.text}\n${item.quote ?? ""}` } });
  });
}

/** The fetches a run has to make for every item to be in the corpus. */
function fetchAll(pack: ResearchPack): ScriptedCall[] {
  return packItems(pack).map((_, i) => call("fetch", { url: itemUrl(i) }));
}

const call = (name: string, args: unknown): ScriptedCall => ({ tool: { name, args }, usage: { in: 10, out: 5 } });
const answer = (pack: ResearchPack): ScriptedCall => ({ text: JSON.stringify(pack), usage: { in: 10, out: 5 } });

/** Deps whose model is a queue of scripts, one per attempt. */
function deps(scripts: ScriptedCall[][], over: Partial<ResearchHandlerDeps> = {}): ResearchHandlerDeps & { attempts: () => number } {
  let attempts = 0;
  return {
    mode: "mock",
    fixturesDir: dir,
    priorKnowledgeDir: path.join(process.cwd(), "fixtures", "prior-knowledge"),
    makeModel: () => {
      const script = scripts[attempts] ?? scripts.at(-1)!;
      attempts += 1;
      return scriptedModel([...script]).model;
    },
    ...over,
    attempts: () => attempts,
  };
}

async function jobRow(input: unknown) {
  const id = await seedJob("research", input);
  return prisma.job.findUniqueOrThrow({ where: { id } });
}

const BRIEF = { product: "Insights360", motion: "direct", who: "claims ops people at mid-sized UK insurers", region: "GB", howMany: 20, weeks: 3, channels: ["email"] };

beforeAll(async () => {
  await resetDatabase();
  const pack = citablePack();
  writeRecording(dir, "search", searchDiscriminator(QUERY), { tool: "search", args: QUERY, response: { hits: [{ title: "Backlog", url: PAGE_URL, snippet: "the complaints backlog doubled" }] } });
  writeRecording(dir, "scrape", fetchDiscriminator(PAGE_URL), { tool: "scrape", args: { url: PAGE_URL }, response: { markdown: "the complaints backlog doubled" } });
  recordPages(pack);
}, 120_000);
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await prisma.$disconnect();
});
beforeEach(async () => {
  await emptyAll();
  await seedOrg();
});

describe("the research job", () => {
  it("runs the definition, checks provenance, ingests, and writes one Event with the pack", async () => {
    const job = await jobRow({ brief: BRIEF });
    const pack = citablePack();
    const d = deps([[call("facts", {}), call("search", QUERY), ...fetchAll(pack), answer(pack)]], { budget: { maxModelSteps: 80, maxSearches: 20, maxFetches: 60, maxSeconds: 480 } });
    const result = (await researchHandler(d)({ db: prisma, job, signal: new AbortController().signal })) as { eventId: string };

    const event = await prisma.event.findUniqueOrThrow({ where: { id: result.eventId } });
    expect(event.kind).toBe(RESEARCH_COMPLETED);
    const after = event.after as { jobId: string; pack: ResearchPack; report: { provenance: Array<{ failed: unknown[] }>; attempts: number; actuals: { searches: number; fetches: number } }; facts: { version: number; draft: boolean }; breadth: string };
    expect(after.jobId).toBe(job.id);
    expect(after.breadth).toBe("narrow");
    expect(after.facts).toMatchObject({ version: 1, draft: true });
    expect(after.report.attempts).toBe(1);
    expect(after.report.provenance[0]?.failed).toEqual([]);
    expect(after.report.actuals).toMatchObject({ searches: 1, fetches: packItems(pack).length });
    expect(researchOutputSchema.safeParse(after.pack).success).toBe(true);
    // The org pinned the facts file.
    expect(await prisma.productFactsVersion.count({ where: { orgId: ORG_ID, product: "insights360", version: 1 } })).toBe(1);
    // The guard row.
    expect(await prisma.sideEffect.count({ where: { key: `research:${job.id}` } })).toBe(1);
    expect(d.attempts()).toBe(1);

    // A retry of the same job returns the same Event and runs nothing.
    const again = (await researchHandler(d)({ db: prisma, job, signal: new AbortController().signal })) as { eventId: string };
    expect(again.eventId).toBe(result.eventId);
    expect(d.attempts()).toBe(1);
    expect(await prisma.event.count({ where: { kind: RESEARCH_COMPLETED } })).toBe(1);
  });

  it("re-runs once with the failures named when provenance fails, then ingests the second pack", async () => {
    const job = await jobRow({ brief: BRIEF });
    const bad = citablePack();
    // Nothing fetched: every item fails provenance on attempt 1.
    const good = citablePack();
    const d = deps(
      [
        [call("facts", {}), answer(bad)],
        [call("facts", {}), call("search", QUERY), ...fetchAll(good), answer(good)],
      ],
      { budget: { maxModelSteps: 80, maxSearches: 20, maxFetches: 60, maxSeconds: 480 } },
    );
    const result = (await researchHandler(d)({ db: prisma, job, signal: new AbortController().signal })) as { eventId: string };
    expect(d.attempts()).toBe(2);
    const event = await prisma.event.findUniqueOrThrow({ where: { id: result.eventId } });
    const after = event.after as { report: { attempts: number; provenance: Array<{ rejected: boolean; failed: unknown[] }> } };
    expect(after.report.attempts).toBe(2);
    expect(after.report.provenance[0]?.rejected).toBe(true);
    expect(after.report.provenance[1]?.rejected).toBe(false);
    // Two runs on the job, both recorded.
    expect(await prisma.agentRun.count({ where: { jobId: job.id } })).toBe(2);
  });

  it("fails the job as bad_output when the second pack fails provenance too", async () => {
    const job = await jobRow({ brief: BRIEF });
    const bad = citablePack();
    const d = deps([[call("facts", {}), answer(bad)]]);
    await expect(researchHandler(d)({ db: prisma, job, signal: new AbortController().signal })).rejects.toThrow(/bad_output/);
    await expect(researchHandler(d)({ db: prisma, job, signal: new AbortController().signal })).rejects.toBeInstanceOf(TerminalError);
    expect(await prisma.event.count({ where: { kind: RESEARCH_COMPLETED } })).toBe(0);
  });

  it("replays every stored tool call after a kill mid-run: no key runs twice, and the budget resumes (rubric check 9)", async () => {
    const job = await jobRow({ brief: BRIEF });
    const pack = citablePack();
    const fetches = fetchAll(pack);
    const budget = { maxModelSteps: 80, maxSearches: 20, maxFetches: 60, maxSeconds: 480 };
    // Attempt 1 dies after its fourth tool call: the script runs out where a
    // worker would have been killed, and the model loop fails.
    const killed = [call("facts", {}), call("search", QUERY), ...fetches.slice(0, 2)];
    const whole = [call("facts", {}), call("search", QUERY), ...fetches, answer(pack)];
    const d = deps([killed, whole], { budget });
    await expect(researchHandler(d)({ db: prisma, job, signal: new AbortController().signal })).rejects.toThrow();
    const firstRun = await prisma.agentRun.findFirstOrThrow({ where: { jobId: job.id } });
    const stored = await prisma.agentRunStep.findMany({ where: { runId: firstRun.id, kind: "tool" }, orderBy: { index: "asc" } });
    expect(stored.map((step) => step.name)).toEqual(["facts", "search", "fetch", "fetch"]);
    expect(stored.every((step) => step.toolKey !== null)).toBe(true);

    // The retry. Every call the first attempt stored is answered from its row.
    const result = (await researchHandler(d)({ db: prisma, job, signal: new AbortController().signal })) as { eventId: string };
    const runs = await prisma.agentRun.findMany({ where: { jobId: job.id }, orderBy: { createdAt: "asc" } });
    expect(runs).toHaveLength(2);
    const secondSteps = await prisma.agentRunStep.findMany({ where: { runId: runs[1]!.id, kind: "tool" }, orderBy: { index: "asc" } });
    // Only the calls the first attempt never reached get a row of their own.
    expect(secondSteps.map((step) => step.name)).toEqual(fetches.slice(2).map(() => "fetch"));
    const allKeys = [...stored, ...secondSteps].map((step) => step.toolKey);
    expect(new Set(allKeys).size).toBe(allKeys.length);
    // The budget resumed: the second attempt's spend is the calls it made, not
    // a fresh count of everything it asked for.
    const event = await prisma.event.findUniqueOrThrow({ where: { id: result.eventId } });
    const after = event.after as { report: { actuals: { searches: number; fetches: number } } };
    expect(after.report.actuals).toMatchObject({ searches: 0, fetches: fetches.length - 2 });
  });

  it("names a page the cascade could not read as an unreadable unknown, and keeps the model's own", () => {
    const pack = citablePack();
    const out = withUnreadableUnknowns(pack, new Set([DEAD_URL, PAGE_URL]), [PAGE_URL]);
    expect(out.unknowns).toHaveLength(pack.unknowns.length + 1);
    expect(out.unknowns.at(-1)).toMatchObject({ kind: "unreadable", queriesTried: [DEAD_URL] });
    expect(withUnreadableUnknowns(pack, new Set(), [])).toBe(pack);
  });

  it("reports a cap as took_too_long, terminal", async () => {
    const job = await jobRow({ brief: BRIEF, breadth: "narrow" });
    // Four searches against a cap of three. (The scripted model makes one call
    // per step, so the search cap is set below the step cap here; live, a
    // step carries several calls and the two caps are independent.)
    const script = [call("facts", {}), ...Array.from({ length: 4 }, (_, i) => call("search", { query: `q${i}`, region: "GB" })), answer(citablePack())];
    const d = deps([script], { budget: { maxModelSteps: 40, maxSearches: 3, maxFetches: 12, maxSeconds: 480 } });
    await expect(researchHandler(d)({ db: prisma, job, signal: new AbortController().signal })).rejects.toThrow(/took_too_long.*searches cap \(3\)/);
  });

  it("refuses bad input as terminal, before touching anything", async () => {
    const job = await jobRow({ brief: { ...BRIEF, region: "gbr" } });
    await expect(researchHandler(deps([]))({ db: prisma, job, signal: new AbortController().signal })).rejects.toBeInstanceOf(TerminalError);
    expect(await prisma.agentRun.count()).toBe(0);
  });
});
