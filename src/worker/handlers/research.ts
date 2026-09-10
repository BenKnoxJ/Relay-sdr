import path from "node:path";

import { z } from "zod";

import { researchBriefSchema, priorRunSchema, type ResearchInput } from "../../../agents/research/input.schema";
import { completeModule, MODULE_IDS, type ModuleId, type PackShape, type ResearchRunOutput } from "../../../agents/research/output.schema";
import { researchTools, type PriorPack } from "../../../agents/research/tools";
import { agentsDir, loadDefinition, type AgentBudget } from "@/lib/agents/definitions";
import type { LanguageModel } from "ai";

import type { RunModel } from "@/lib/agents/model";
import type { PricedModel } from "@/lib/agents/pricing";
import { makeModel } from "@/lib/agents/provider";
import { AgentRunFailedError, runAgent } from "@/lib/agents/run";
import { env } from "@/lib/env";
import { loadFacts } from "@/lib/facts/load";
import { loadNeverSay } from "@/lib/facts/neverSay";
import { loadKnowledge } from "@/lib/knowledge/load";
import { assemblePack, corpusFromSteps, latestModules, markInsufficient, moduleWritesFromSteps, storedOf, withRuntimeSources } from "@/lib/research/assemble";
import { createResearchBudget } from "@/lib/research/budget";
import { createCorpus } from "@/lib/research/corpus";
import { checkProvenance, type ProvenanceReport } from "@/lib/research/provenance";
import { describeIssues, validatePack, type PackIssue } from "@/lib/research/validate";
import { ensureFactsVersion } from "@/lib/repo/productFacts";
import { findResearchCompletedForJob, findResearchPacks, listJobToolSteps, recordResearchCompleted } from "@/lib/repo/research";
import { createFirecrawlService, createTavilyService, type ResearchServiceMode } from "@/lib/services";
import { TerminalError, safeError } from "@/worker/errors";
import type { Handler } from "@/worker/handlers/index";

/**
 * The `research` job: the signed definition (v3, with the v3.1 notes), end to
 * end, on the real worker.
 *
 * In order — and each step is the definition's, not this file's:
 *
 *   1. the job's input is the brief, the prior packs it may read and, on a
 *      re-run, `priorRun`; the facts come from the repository's facts file,
 *      whose version this org pins (`ensureFactsVersion`, refused on a hash
 *      mismatch), and the knowledge set from `knowledge/` (§2, §4);
 *   2. the corpus is rebuilt from every search and fetch the job's earlier
 *      runs stored, so a retry reads what the first run read (§7);
 *   3. **two phases** (§10 note 17): `research` on the definition's model
 *      gathers the evidence and writes the evidence modules; `synthesis`, on
 *      a cheaper model in a fresh context holding only the accepted modules,
 *      writes the rest with search and fetch closed. Each module is validated
 *      as it is written (§4, §5). A rail ends the job's runs and is **not** a
 *      failure: the modules already accepted are the pack, marked `partial`
 *      (§6);
 *   4. assembly from the `writeModule` steps across every run of the job, m19
 *      assembled by the runtime (§10 note 18), and the runtime's own unknowns
 *      for pages it could not read (§4);
 *   5. provenance per module, and ingest; the modules that fail either, or
 *      were never written, are re-asked **alone**, in their own phase, with
 *      their stored version to edit (§7, §10 note 16). A module that still
 *      fails ingest is stored `insufficient` with its issues; a module that
 *      still fails provenance stays demoted. A refused module never loses the
 *      run;
 *   6. the completion Event with the pack, one per job across retries.
 *
 * The handler returns the Event id and nothing else, so `Job.responseDigest`
 * is the same on every attempt that reached the same pack.
 */

const FACTS_PRODUCT = "insights360";
const FACTS_VERSION = 1;
const KNOWLEDGE_VERSION = 1;

/** The modules each phase writes (§10 note 17). m19 is the runtime's. */
export const RESEARCH_PHASE_MODULES: readonly ModuleId[] = ["m00", "m01", "m02", "m03", "m05", "m06", "m04", "m10", "m12", "m13", "m17"];
export const SYNTHESIS_PHASE_MODULES: readonly ModuleId[] = ["m07", "m08", "m09", "m11", "m14", "m15", "m16", "m18", "execSummary", "repSummary"];
/** The synthesis phase's model: it writes from accepted modules and reads no new pages. */
export const SYNTHESIS_MODEL: PricedModel = "claude-sonnet-5";

type Phase = "research" | "synthesis";
const phaseOf = (id: ModuleId): Phase => (RESEARCH_PHASE_MODULES.includes(id) ? "research" : "synthesis");

export const researchJobInputSchema = z
  .object({
    brief: researchBriefSchema,
    priorRun: priorRunSchema.optional(),
    /** This org's earlier packs for the product, by completion Event id (§2 `priorPackIds`). */
    priorPackIds: z.array(z.string().min(1).max(80)).max(20).optional(),
  })
  .strict();
export type ResearchJobInput = z.infer<typeof researchJobInputSchema>;

/** How the handler reaches the providers. Injected so the tests and the bench run offline. */
export type ResearchHandlerDeps = {
  mode: ResearchServiceMode;
  fixturesDir: string;
  now?: () => number;
  /** The model per run. Defaults to `makeModel`; the tests hand in a scripted one. */
  makeModel?: (id: PricedModel) => RunModel | LanguageModel;
  /** Rails in place of the definition's. For the tests and the bench only; a job never sets them. */
  budget?: AgentBudget;
  /** Bench only (`--modules`): write the steering note and these modules, nothing else. */
  onlyModules?: ModuleId[];
  /** Bench only (`--record-stream`): every raw Agent SDK message of every run. */
  onSdkMessage?: (message: unknown) => void | Promise<void>;
};

export function defaultResearchDeps(): ResearchHandlerDeps {
  const e = env();
  const root = path.dirname(agentsDir());
  const mode: ResearchServiceMode = e.INTEGRATIONS === "live" ? (e.RELAY_TOOL_RECORD === "1" ? "record" : "live") : "mock";
  return { mode, fixturesDir: e.RELAY_TOOL_FIXTURES ?? path.join(root, "fixtures", "tools", "research") };
}

/** How one run ended: with the model's closing manifest, at a rail, or with no closing answer. */
type Ending = "answer" | "rail" | "no-answer";

export function researchHandler(deps: ResearchHandlerDeps = defaultResearchDeps()): Handler {
  return async ({ db, job, signal }) => {
    const parsed = researchJobInputSchema.safeParse(job.input);
    if (!parsed.success) {
      throw new TerminalError(
        `research: bad input (${parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")})`,
      );
    }
    const { brief } = parsed.data;
    const priorPackIds = parsed.data.priorPackIds ?? [];

    // Already done on an earlier attempt: the Event is the answer.
    const done = await findResearchCompletedForJob(db, { orgId: job.orgId, jobId: job.id });
    if (done !== null) return { eventId: done.id };

    const facts = loadFacts(FACTS_PRODUCT, FACTS_VERSION);
    await ensureFactsVersion(db, { orgId: job.orgId, product: facts.file.product, version: facts.file.version, hash: facts.hash, draft: facts.draft });
    const knowledge = loadKnowledge(FACTS_PRODUCT, KNOWLEDGE_VERSION);
    const neverSay = loadNeverSay(FACTS_PRODUCT, FACTS_VERSION);

    const priorEvents = await findResearchPacks(db, { orgId: job.orgId, ids: priorPackIds });
    if (priorEvents.length !== new Set(priorPackIds).size) {
      throw new TerminalError("research: bad input (priorPackIds names a pack this org does not have)");
    }
    const priorPacks = priorEvents.map((event) => toPriorPack(event.id, event.at, event.after));

    const base = loadDefinition("research");
    const definition = { ...base, budget: deps.budget ?? base.budget };
    const researchModel = definition.model;
    if (researchModel === null) throw new TerminalError("research: the definition names no model");

    const e = env();
    const search = createTavilyService(e, { mode: deps.mode, fixturesDir: deps.fixturesDir });
    const fetch = createFirecrawlService(e, { mode: deps.mode, fixturesDir: deps.fixturesDir });
    const corpus = createCorpus();
    const steps = () => listJobToolSteps(db, { orgId: job.orgId, jobId: job.id });
    corpusFromSteps(corpus, await steps());
    const log = (line: Record<string, unknown>): void => {
      console.log(JSON.stringify({ at: new Date().toISOString(), component: "research", jobId: job.id, ...line }));
    };

    const baseInput: ResearchInput = {
      brief,
      factsVersion: facts.file.version,
      knowledgeVersion: knowledge.manifest.version,
      priorPackIds,
      ...(parsed.data.priorRun === undefined ? {} : { priorRun: parsed.data.priorRun }),
    };
    const validateContext = { facts: facts.facts, channels: brief.channels, priorPackIds, neverSay };
    /** The bench's `--modules` narrows every phase; a job writes them all. */
    const restrict = (ids: readonly ModuleId[]): ModuleId[] => ids.filter((id) => deps.onlyModules === undefined || deps.onlyModules.includes(id));

    const endings: Array<{ phase: Phase; ending: Ending; message?: string }> = [];
    const actuals = { searches: 0, fetches: 0, fetchedChars: 0, seconds: 0 };
    let runId = "";
    let insufficient: ResearchRunOutput["insufficient"];

    /** One run of one phase, writing `modules`. A rail or a missing closing answer loses nothing: the modules are the stored writes. */
    const runPhase = async (phase: Phase, modules: ModuleId[], extra: Partial<ResearchInput> = {}): Promise<Ending> => {
      const budget = createResearchBudget({ limits: definition.budget, ...(deps.now === undefined ? {} : { now: deps.now }) });
      const writes = moduleWritesFromSteps(await steps());
      const modelId: PricedModel = phase === "research" ? researchModel : SYNTHESIS_MODEL;
      const input: ResearchInput = {
        ...baseInput,
        phase,
        onlyModules: modules,
        ...(phase === "synthesis" ? { acceptedModules: completeOnly(latestModules(writes)) } : {}),
        ...extra,
      };
      let ending: Ending;
      try {
        const result = await runAgent({
          definition,
          input,
          ctx: {
            db,
            orgId: job.orgId,
            jobId: job.id,
            model: (deps.makeModel ?? makeModel)(modelId),
            modelId,
            signal,
            tools: (recorder) =>
              researchTools(recorder, {
                facts: facts.facts,
                factsDraft: facts.draft,
                knowledge,
                priorPacks,
                budget,
                corpus,
                search,
                fetch,
                priorWrites: writes,
                log,
                onlyModules: modules,
                phase,
                neverSay,
              }),
            scrub: safeError,
            ...(deps.onSdkMessage === undefined ? {} : { onSdkMessage: deps.onSdkMessage }),
          },
        });
        insufficient ??= result.object.insufficient;
        runId = result.run.id;
        ending = "answer";
        endings.push({ phase, ending });
      } catch (error) {
        if (!(error instanceof AgentRunFailedError) || (error.reason !== "cap" && error.reason !== "schema")) throw classify(error);
        ending = error.reason === "cap" ? "rail" : "no-answer";
        runId = error.runId || runId;
        endings.push({ phase, ending, message: error.message });
        log({ event: "research.run.ended", phase, ending, message: error.message });
      }
      const used = budget.actuals();
      actuals.searches += used.searches;
      actuals.fetches += used.fetches;
      actuals.fetchedChars += used.fetchedChars;
      actuals.seconds += used.seconds;
      return ending;
    };

    /** Assemble, add the runtime's m19 and unknowns, check provenance, validate. */
    const check = async () => {
      const all = await steps();
      const writes = moduleWritesFromSteps(all);
      const assembled = withUnreadableUnknowns(
        withRuntimeSources(assemblePack(writes, insufficient === undefined ? {} : { insufficient }), all, { factsVersion: facts.file.version, priorPackIds }),
        corpus.unreadable,
      );
      const checked = checkProvenance(assembled, corpus);
      const validated = validatePack(checked.pack, validateContext);
      return { writes, pack: checked.pack, report: checked.report, issues: validated.ok ? [] : validated.issues };
    };

    // The two phases. A rail anywhere ends the job's runs (§6).
    let railed = false;
    for (const phase of ["research", "synthesis"] as const) {
      const modules = restrict(phase === "research" ? RESEARCH_PHASE_MODULES : SYNTHESIS_PHASE_MODULES);
      if (modules.length === 0) continue;
      // The stop rule (§5 rule 8): a thin brief ends with what research found.
      if (phase === "synthesis" && insufficient !== undefined) break;
      if ((await runPhase(phase, modules)) === "rail") {
        railed = true;
        break;
      }
    }

    let result = await check();
    if (!result.writes.some((write) => storedOf(write) !== undefined)) {
      throw new TerminalError(
        railed
          ? `research: took_too_long — a rail was reached before any module was written (${endings.at(-1)?.message ?? ""})`
          : "research: bad_output — the run ended without writing a module",
      );
    }
    const provenance: ProvenanceReport[] = [result.report];
    const firstIssues: PackIssue[] = result.issues;
    const reasked: ModuleId[][] = [];

    // What to re-ask (§7): modules over the provenance threshold, modules the
    // ingest refused, and modules never written — never after a rail, never
    // after the stop rule.
    const again = new Set<ModuleId>();
    for (const checkedModule of result.report.modules) if (checkedModule.rejected) again.add(checkedModule.module);
    for (const issue of result.issues) if (issue.module !== undefined) again.add(issue.module);
    if (insufficient === undefined) for (const id of result.pack.missingModules) again.add(id);
    const writable = new Set([...restrict(RESEARCH_PHASE_MODULES), ...restrict(SYNTHESIS_PHASE_MODULES)]);
    const reask = MODULE_IDS.filter((id) => again.has(id) && writable.has(id));

    if (reask.length > 0 && !railed) {
      const current = latestModules(result.writes);
      for (const phase of ["research", "synthesis"] as const) {
        const modules = reask.filter((id) => phaseOf(id) === phase);
        if (modules.length === 0) continue;
        reasked.push(modules);
        log({ event: "research.reask", phase, modules });
        const failures = [
          ...result.report.failed
            .filter((f) => f.module !== "insufficient" && modules.includes(f.module))
            .map((f) => ({ module: f.module, id: f.id, text: f.text.slice(0, 1000), reason: f.reason.slice(0, 300) })),
          ...result.issues
            .filter((i) => i.module !== undefined && modules.includes(i.module))
            .map((i) => ({ module: i.module!, id: "ingest", text: i.message.slice(0, 1000), reason: "refused at ingest" })),
          ...result.pack.missingModules
            .filter((id) => modules.includes(id))
            .map((id) => ({ module: id, id: "missing", text: `${id} was not written`, reason: "the module was not written" })),
        ].slice(0, 200);
        const stored = Object.fromEntries(modules.filter((id) => current[id] !== undefined).map((id) => [id, current[id]]));
        const ending = await runPhase(phase, modules, {
          provenanceRerun: {
            modules,
            ...(Object.keys(stored).length === 0 ? {} : { current: stored }),
            failures: failures.length > 0 ? failures : [{ module: modules[0]!, id: "reask", text: "re-asked", reason: "re-asked" }],
          },
        });
        if (ending === "rail") break;
      }
      result = await check();
      provenance.push(result.report);
    }

    // §7: a module still refused at ingest after its re-ask is stored
    // `insufficient` with its issues, and the pack completes.
    let pack = result.pack;
    const insufficientModules: ModuleId[] = [];
    let validated = validatePack(pack, validateContext);
    for (let round = 0; !validated.ok && round < 3; round += 1) {
      const byModule = new Map<ModuleId, string[]>();
      for (const issue of validated.issues) if (issue.module !== undefined) byModule.set(issue.module, [...(byModule.get(issue.module) ?? []), issue.message]);
      if (byModule.size === 0) break;
      for (const [id, messages] of byModule) {
        pack = markInsufficient(pack, id, messages);
        insufficientModules.push(id);
      }
      validated = validatePack(pack, validateContext);
    }
    if (!validated.ok) {
      throw new TerminalError(`research: bad_output — the pack does not validate at ingest: ${describeIssues(validated.issues).slice(0, 5).join("; ")}`);
    }

    const { event } = await recordResearchCompleted(db, {
      orgId: job.orgId,
      jobId: job.id,
      runId,
      pack: JSON.parse(JSON.stringify(validated.pack)),
      report: JSON.parse(
        JSON.stringify({
          provenance,
          demoted: validated.demoted,
          actuals,
          rails: definition.budget,
          attempts: endings.length,
          endings,
          reasked,
          insufficientModules,
          firstIngestIssues: describeIssues(firstIssues),
          models: { research: researchModel, synthesis: SYNTHESIS_MODEL },
        }),
      ),
      facts: { product: facts.file.product, version: facts.file.version, hash: facts.hash, draft: facts.draft },
      knowledge: { product: knowledge.manifest.product, version: knowledge.manifest.version, hash: knowledge.hash },
      partial: validated.pack.partial,
      missingModules: [...validated.pack.missingModules],
    });
    return { eventId: event.id };
  };
}

/** The accepted modules the synthesis phase writes from: complete ones only. */
function completeOnly(modules: Partial<Record<ModuleId, Record<string, unknown>>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(modules).filter(([, stored]) => stored?.status === "complete"));
}

/** A completion Event as the agent reads it (§4 `priorPacks`): module bodies only. */
export function toPriorPack(id: string, at: Date, after: unknown): PriorPack {
  const modules: PriorPack["modules"] = [];
  const pack = (after as { pack?: { modules?: Record<string, { body?: unknown } | undefined> } } | null)?.pack;
  for (const moduleId of MODULE_IDS) {
    const body = pack?.modules?.[moduleId]?.body;
    if (typeof body === "string") modules.push({ module: moduleId, title: moduleId, body });
  }
  return { id, at: at.toISOString(), modules };
}

/** The runtime's own unknowns (§4): one per unreadable URL the pack does not already account for, in m18. */
export function withUnreadableUnknowns(pack: PackShape, unreadable: ReadonlySet<string>): PackShape {
  const m18 = completeModule(pack, "m18");
  if (m18 === undefined) return pack;
  const tried = new Set(m18.unknowns.flatMap((unknown) => unknown.queriesTried).map((q) => q.trim().toLowerCase()));
  const extra = [...unreadable]
    .filter((url) => !tried.has(url.toLowerCase()))
    .map((url) => ({
      id: `unreadable-${shortHash(url)}`,
      text: `A page that looked relevant could not be read: ${url}`,
      kind: "unreadable" as const,
      whyItMatters: "What it says is not in this pack; a claim that needed it is weaker or missing.",
      queriesTried: [url],
    }));
  if (extra.length === 0) return pack;
  return { ...pack, modules: { ...pack.modules, m18: { ...m18, unknowns: [...m18.unknowns, ...extra] } } };
}

function shortHash(value: string): string {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

/** The failure reasons a pack cannot come back from, classified the way `echo` classifies them. */
function classify(error: unknown): Error {
  if (!(error instanceof AgentRunFailedError)) return error instanceof Error ? error : new Error(String(error));
  switch (error.reason) {
    case "cap":
      return new TerminalError(`research: took_too_long — ${error.message}`, { cause: error });
    case "schema":
      return new TerminalError(`research: bad_output — ${error.message}`, { cause: error });
    case "aborted":
    case "step-record":
    case "error":
    case "close":
      return error;
    default: {
      const unhandled: never = error.reason;
      return new TerminalError(`research: unhandled failure reason ${String(unhandled)}`, { cause: error });
    }
  }
}

/** The registered handler: default deps from the environment. */
export const research: Handler = (context) => researchHandler()(context);
