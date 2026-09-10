import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { MODULE_IDS, moduleItems, researchOutputSchema, type ModuleId, type PackShape } from "../../agents/research/output.schema";
import type { AgentBudget } from "@/lib/agents/definitions";
import { prisma } from "@/lib/db";
import { loadFacts } from "@/lib/facts/load";
import { moduleWritesFromSteps } from "@/lib/research/assemble";
import { RESEARCH_COMPLETED } from "@/lib/repo/research";
import { fetchDiscriminator, searchDiscriminator, writeRecording } from "@/lib/services";
import { TerminalError } from "@/worker/errors";
import { researchHandler, withUnreadableUnknowns, type ResearchHandlerDeps } from "@/worker/handlers/research";

import { emptyAll, resetDatabase } from "../db/harness";
import { ORG_ID, scriptedModel, seedJob, seedOrg, type ScriptedCall } from "../agents/harness";
import { citedPages, goodPack, mod, moduleContent } from "../agents/researchPack";

/**
 * The research job (v3) on the worker's handler, with the scripted model and
 * the mock providers: the whole pack written module by module; a rail that
 * stores a partial pack and completes; a kill mid-run whose retry keeps the
 * first run's modules; the re-ask of only the modules that failed provenance
 * or were never written; a module refused twice stored insufficient; and one
 * Event per job.
 */

const dir = mkdtempSync(path.join(tmpdir(), "relay-research-handler-"));
const facts = loadFacts("insights360", 1);
const LIVE_ID = facts.facts.facts.find((fact) => fact.status === "live")!.id;
const PACK = goodPack({ liveFactId: LIVE_ID });
const PAGES = citedPages(PACK);
const RAILS: AgentBudget = { maxModelSteps: 300, maxSearches: 20, maxFetches: 200, maxSeconds: 600 };
const BRIEF = { product: "Insights360", motion: "direct", who: "claims ops people at mid-sized UK insurers", region: "GB", howMany: 20, weeks: 3, channels: ["email"] };

const usage = { in: 10, out: 5 };
const call = (name: string, args: unknown): ScriptedCall => ({ tool: { name, args }, usage });
const facts0 = call("facts", {});
const fetches = (urls: string[]): ScriptedCall[] => urls.map((url) => call("fetch", { url }));
const writes = (ids: readonly ModuleId[], pack: PackShape = PACK): ScriptedCall[] => ids.map((id) => call("writeModule", { module: id, content: moduleContent(pack, id) }));
const answer = (ids: readonly ModuleId[]): ScriptedCall => ({ text: JSON.stringify({ modulesWritten: ids }), usage });
const urlsOf = (ids: readonly ModuleId[]): string[] => ids.flatMap((id) => moduleItems(PACK, id).flatMap((item) => item.evidence.urls));
const ALL_URLS = PAGES.map((page) => page.url);
const except = <T,>(list: readonly T[], drop: readonly unknown[]): T[] => list.filter((x) => !drop.includes(x));

/** Deps whose model is a queue of scripts, one per attempt, across handler calls. */
function deps(scripts: ScriptedCall[][], over: Partial<ResearchHandlerDeps> = {}): ResearchHandlerDeps & { attempts: () => number } {
  let attempts = 0;
  return {
    mode: "mock",
    fixturesDir: dir,
    budget: RAILS,
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

type After = {
  jobId: string;
  pack: PackShape;
  partial: boolean;
  missingModules: string[];
  knowledge: { version: number; hash: string };
  facts: { version: number; draft: boolean };
  report: { attempts: number; reasked: string[][]; insufficientModules: string[]; endings: Array<{ ending: string }>; provenance: Array<{ rejected: boolean; modules: Array<{ module: string; rejected: boolean }> }> };
};

async function after(eventId: string): Promise<After> {
  const event = await prisma.event.findUniqueOrThrow({ where: { id: eventId } });
  expect(event.kind).toBe(RESEARCH_COMPLETED);
  return event.after as After;
}

const signal = () => new AbortController().signal;

beforeAll(async () => {
  await resetDatabase();
  for (const page of PAGES) writeRecording(dir, "scrape", fetchDiscriminator(page.url), { tool: "scrape", args: { url: page.url }, response: { markdown: page.text } });
  for (const i of [0, 1, 2]) {
    const q = { query: `q${i}`, region: "GB" };
    writeRecording(dir, "search", searchDiscriminator(q), { tool: "search", args: q, response: { hits: [] } });
  }
}, 120_000);
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await prisma.$disconnect();
});
beforeEach(async () => {
  await emptyAll();
  await seedOrg();
});

describe("the research job (v3)", () => {
  it("writes the pack module by module, checks provenance, ingests, and writes one Event", async () => {
    const job = await jobRow({ brief: BRIEF });
    const d = deps([[facts0, ...fetches(ALL_URLS), ...writes(MODULE_IDS), answer(MODULE_IDS)]]);
    const result = (await researchHandler(d)({ db: prisma, job, signal: signal() })) as { eventId: string };
    const a = await after(result.eventId);
    expect(a.jobId).toBe(job.id);
    expect(a).toMatchObject({ partial: false, missingModules: [], knowledge: { version: 1 }, facts: { version: 1, draft: false } });
    expect(a.report).toMatchObject({ attempts: 1, reasked: [], insufficientModules: [] });
    expect(a.report.provenance[0]?.rejected).toBe(false);
    expect(researchOutputSchema.safeParse(a.pack).success).toBe(true);
    expect(await prisma.sideEffect.count({ where: { key: `research:${job.id}` } })).toBe(1);

    // A retry of the same job returns the same Event and runs nothing.
    const again = (await researchHandler(d)({ db: prisma, job, signal: signal() })) as { eventId: string };
    expect(again.eventId).toBe(result.eventId);
    expect(d.attempts()).toBe(1);
  });

  it("stores the modules already written as a partial pack when a rail ends the run, and completes the job", async () => {
    const job = await jobRow({ brief: BRIEF });
    const first = ["m00", "repSummary", "execSummary", "m01", "m02"] as const;
    const script = [facts0, ...fetches(urlsOf(first)), ...writes(first), call("search", { query: "q0", region: "GB" }), call("search", { query: "q1", region: "GB" }), answer(first)];
    const d = deps([script], { budget: { ...RAILS, maxSearches: 1 } });
    const result = (await researchHandler(d)({ db: prisma, job, signal: signal() })) as { eventId: string };
    const a = await after(result.eventId);
    expect(a.partial).toBe(true);
    expect(a.missingModules).toEqual(except(MODULE_IDS, first));
    expect(Object.keys(a.pack.modules).sort()).toEqual([...first].sort());
    expect(a.report.endings).toEqual([expect.objectContaining({ ending: "rail" })]);
    // A rail is not re-asked: the budget is spent.
    expect(a.report.reasked).toEqual([]);
    expect(d.attempts()).toBe(1);
  });

  it("keeps what the first run wrote after a kill: the retry writes only the rest, and no key runs twice", async () => {
    const job = await jobRow({ brief: BRIEF });
    const firstHalf = MODULE_IDS.slice(0, 10);
    const secondHalf = MODULE_IDS.slice(10);
    // Attempt 1 dies after its tenth module: the script runs out where a worker would be killed.
    const killed = [facts0, ...fetches(ALL_URLS), ...writes(firstHalf)];
    const rest = [facts0, ...writes(secondHalf), answer(MODULE_IDS)];
    const d = deps([killed, rest]);
    await expect(researchHandler(d)({ db: prisma, job, signal: signal() })).rejects.toThrow();
    expect(await prisma.event.count({ where: { kind: RESEARCH_COMPLETED } })).toBe(0);

    const result = (await researchHandler(d)({ db: prisma, job, signal: signal() })) as { eventId: string };
    const a = await after(result.eventId);
    expect(a).toMatchObject({ partial: false, missingModules: [] });
    // Provenance passed on the retry from the pages the first run fetched.
    expect(a.report.provenance.every((report) => !report.rejected)).toBe(true);
    const steps = await prisma.agentRunStep.findMany({ where: { kind: "tool", name: "writeModule" } });
    expect(moduleWritesFromSteps(steps).map((w) => w.module).sort()).toEqual([...MODULE_IDS].sort());
    const keys = (await prisma.agentRunStep.findMany({ where: { kind: "tool" } })).map((s) => s.toolKey).filter((k) => k !== null);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("re-asks only the module that failed provenance, and ingests the second attempt", async () => {
    const job = await jobRow({ brief: BRIEF });
    const m05Urls = urlsOf(["m05"]);
    const first = [facts0, ...fetches(except(ALL_URLS, m05Urls)), ...writes(MODULE_IDS), answer(MODULE_IDS)];
    const second = [facts0, ...fetches(m05Urls), ...writes(["m05"]), answer(MODULE_IDS)];
    const d = deps([first, second]);
    const result = (await researchHandler(d)({ db: prisma, job, signal: signal() })) as { eventId: string };
    const a = await after(result.eventId);
    expect(a.report.attempts).toBe(2);
    expect(a.report.reasked).toEqual([["m05"]]);
    expect(a.report.provenance[0]?.modules.filter((m) => m.rejected).map((m) => m.module)).toEqual(["m05"]);
    expect(a.report.provenance[1]?.rejected).toBe(false);
    expect(mod(a.pack, "m05").perArchetype[0]!.pains[0]!.confidence).toBe("weak");
    expect(await prisma.agentRun.count({ where: { jobId: job.id } })).toBe(2);
  });

  it("re-asks a module that was never written", async () => {
    const job = await jobRow({ brief: BRIEF });
    const withoutM19 = except(MODULE_IDS, ["m19"]);
    const d = deps([
      [facts0, ...fetches(ALL_URLS), ...writes(withoutM19), answer(withoutM19)],
      [facts0, ...writes(["m19"]), answer(["m19"])],
    ]);
    const result = (await researchHandler(d)({ db: prisma, job, signal: signal() })) as { eventId: string };
    const a = await after(result.eventId);
    expect(a.report.reasked).toEqual([["m19"]]);
    expect(a).toMatchObject({ partial: false, missingModules: [] });
  });

  it("stores a module refused twice as insufficient, and the pack still completes", async () => {
    const job = await jobRow({ brief: BRIEF });
    const thin = (n: number) => ({ ...moduleContent(PACK, "m03"), body: `thin ${n}`, archetypes: (moduleContent(PACK, "m03").archetypes as unknown[]).slice(0, 2) });
    const others = except(MODULE_IDS, ["m03"]);
    const script = [facts0, ...fetches(ALL_URLS), call("writeModule", { module: "m03", content: thin(1) }), call("writeModule", { module: "m03", content: thin(2) }), ...writes(others), answer(others)];
    const d = deps([script]);
    const result = (await researchHandler(d)({ db: prisma, job, signal: signal() })) as { eventId: string };
    const a = await after(result.eventId);
    expect((a.pack.modules as Record<string, { status: string; issues?: string[] }>).m03).toMatchObject({ status: "insufficient", issues: [expect.stringMatching(/archetypes/)] });
    expect(a.partial).toBe(false);
    expect(d.attempts()).toBe(1);
  });

  it("names a page the cascade could not read as an unreadable unknown in m18, and keeps the model's own", () => {
    const pack = goodPack({ liveFactId: LIVE_ID });
    const tried = mod(pack, "m18").unknowns[0]!.queriesTried[0]!;
    const out = withUnreadableUnknowns(pack, new Set(["https://dead.example/gone", tried]));
    expect(mod(out, "m18").unknowns).toHaveLength(2);
    expect(mod(out, "m18").unknowns.at(-1)).toMatchObject({ kind: "unreadable", queriesTried: ["https://dead.example/gone"] });
    expect(withUnreadableUnknowns(pack, new Set())).toBe(pack);
  });

  it("refuses bad input and a prior pack this org does not have, as terminal, before a run", async () => {
    const bad = await jobRow({ brief: { ...BRIEF, region: "gbr" } });
    await expect(researchHandler(deps([]))({ db: prisma, job: bad, signal: signal() })).rejects.toBeInstanceOf(TerminalError);
    const stranger = await jobRow({ brief: BRIEF, priorPackIds: ["evt_not_ours"] });
    await expect(researchHandler(deps([]))({ db: prisma, job: stranger, signal: signal() })).rejects.toThrow(/priorPackIds/);
    expect(await prisma.agentRun.count()).toBe(0);
    expect(ORG_ID).toBeTruthy();
  });
});
