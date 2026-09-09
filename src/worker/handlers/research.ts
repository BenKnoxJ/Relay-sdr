import path from "node:path";

import { z } from "zod";

import { researchBriefSchema, priorRunSchema, BREADTHS, type ResearchInput } from "../../../agents/research/input.schema";
import type { ResearchPack } from "../../../agents/research/output.schema";
import { researchTools } from "../../../agents/research/tools";
import { agentsDir, loadDefinition, type AgentBudget } from "@/lib/agents/definitions";
import type { LanguageModel } from "ai";

import type { RunModel } from "@/lib/agents/model";
import type { PricedModel } from "@/lib/agents/pricing";
import { makeModel } from "@/lib/agents/provider";
import { AgentRunFailedError, runAgent } from "@/lib/agents/run";
import { env } from "@/lib/env";
import { loadFacts } from "@/lib/facts/load";
import { deriveBreadth, budgetFor } from "@/lib/research/breadth";
import { createResearchBudget } from "@/lib/research/budget";
import { createCorpus } from "@/lib/research/corpus";
import { checkProvenance, type ProvenanceReport } from "@/lib/research/provenance";
import { validatePack } from "@/lib/research/validate";
import { ensureFactsVersion } from "@/lib/repo/productFacts";
import { findResearchCompletedForJob, recordResearchCompleted } from "@/lib/repo/research";
import { createFirecrawlService, createTavilyService, type ResearchServiceMode } from "@/lib/services";
import { TerminalError, safeError } from "@/worker/errors";
import type { Handler } from "@/worker/handlers/index";

/**
 * The `research` job: the signed definition, end to end, on the real worker.
 *
 * In order — and each step is the definition's, not this file's:
 *
 *   1. the job's input is the brief (and, on a re-run, `priorRun`); the facts
 *      come from the repository's facts file, whose version this org pins
 *      (`ensureFactsVersion`, refused on a hash mismatch), and the breadth is
 *      derived from the brief unless the job names one (§2, §6);
 *   2. the run: the four tools through `withReplay`, the budget charged per
 *      live call, the corpus filled, the model capped at the breadth's model
 *      steps and the run at its minutes (§4, §5, §6);
 *   3. the runtime's own edits: an `unreadable` unknown for every URL the
 *      cascade could not read that the model did not already list (§4);
 *   4. the provenance check against the corpus; over twenty percent failures
 *      is one automatic re-run on the same job with the failures named, every
 *      earlier call replayed (§7);
 *   5. ingest — `demoteStale`, the strict schema, live facts only (§3) — and
 *      the completion Event with the pack, one per job across retries.
 *
 * The handler returns the Event id and nothing else, so `Job.responseDigest`
 * is the same on every attempt that reached the same pack.
 */

const FACTS_PRODUCT = "insights360";
const FACTS_VERSION = 1;
const PROVENANCE_RERUNS = 1;

export const researchJobInputSchema = z
  .object({
    brief: researchBriefSchema,
    priorRun: priorRunSchema.optional(),
    breadth: z.enum(BREADTHS).optional(),
  })
  .strict();
export type ResearchJobInput = z.infer<typeof researchJobInputSchema>;

/** How the handler reaches the providers. Injected so the tests and the bench run offline. */
export type ResearchHandlerDeps = {
  mode: ResearchServiceMode;
  fixturesDir: string;
  priorKnowledgeDir: string;
  now?: () => number;
  /** The model per attempt. Defaults to `makeModel`; the tests hand in a scripted one. */
  makeModel?: (id: PricedModel) => RunModel | LanguageModel;
  /** A budget in place of the breadth's. For the tests and the bench only; a job never sets one. */
  budget?: AgentBudget;
};

export function defaultResearchDeps(): ResearchHandlerDeps {
  const e = env();
  const root = path.dirname(agentsDir());
  const mode: ResearchServiceMode = e.INTEGRATIONS === "live" ? (e.RELAY_TOOL_RECORD === "1" ? "record" : "live") : "mock";
  return {
    mode,
    fixturesDir: e.RELAY_TOOL_FIXTURES ?? path.join(root, "fixtures", "tools", "research"),
    priorKnowledgeDir: e.RELAY_PRIOR_KNOWLEDGE_DIR ?? path.join(root, "fixtures", "prior-knowledge"),
  };
}

export function researchHandler(deps: ResearchHandlerDeps = defaultResearchDeps()): Handler {
  return async ({ db, job, signal }) => {
    const parsed = researchJobInputSchema.safeParse(job.input);
    if (!parsed.success) {
      throw new TerminalError(
        `research: bad input (${parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")})`,
      );
    }

    // Already done on an earlier attempt: the Event is the answer.
    const done = await findResearchCompletedForJob(db, { orgId: job.orgId, jobId: job.id });
    if (done !== null) return { eventId: done.id };

    const facts = loadFacts(FACTS_PRODUCT, FACTS_VERSION);
    await ensureFactsVersion(db, { orgId: job.orgId, product: facts.file.product, version: facts.file.version, hash: facts.hash, draft: facts.draft });

    const breadth = parsed.data.breadth ?? deriveBreadth(parsed.data);
    const base = loadDefinition("research");
    const definition = { ...base, budget: deps.budget ?? budgetFor(breadth) };
    const model = definition.model;
    if (model === null) throw new TerminalError("research: the definition names no model");

    const e = env();
    const search = createTavilyService(e, { mode: deps.mode, fixturesDir: deps.fixturesDir });
    const fetch = createFirecrawlService(e, { mode: deps.mode, fixturesDir: deps.fixturesDir });
    const corpus = createCorpus();
    const log = (line: Record<string, unknown>): void => {
      console.log(JSON.stringify({ at: new Date().toISOString(), component: "research", jobId: job.id, ...line }));
    };

    const baseInput: ResearchInput = {
      brief: parsed.data.brief,
      facts: facts.facts,
      breadth,
      ...(parsed.data.priorRun === undefined ? {} : { priorRun: parsed.data.priorRun }),
    };

    let input: ResearchInput = baseInput;
    const reports: ProvenanceReport[] = [];
    let checked: { pack: ResearchPack; report: ProvenanceReport } | undefined;
    let runId = "";
    let actuals = { searches: 0, fetches: 0, seconds: 0 };

    for (let attempt = 0; attempt <= PROVENANCE_RERUNS; attempt += 1) {
      const budget = createResearchBudget({ limits: definition.budget, ...(deps.now === undefined ? {} : { now: deps.now }) });
      let raw: ResearchPack;
      try {
        const result = await runAgent({
          definition,
          input,
          ctx: {
            db,
            orgId: job.orgId,
            jobId: job.id,
            model: (deps.makeModel ?? makeModel)(model),
            modelId: model,
            signal,
            tools: (recorder) =>
              researchTools(recorder, { facts: facts.facts, factsDraft: facts.draft, budget, corpus, search, fetch, priorKnowledgeDir: deps.priorKnowledgeDir, log }),
            scrub: safeError,
          },
        });
        raw = result.object;
        runId = result.run.id;
        actuals = budget.actuals();
      } catch (error) {
        throw classify(error);
      }

      // §4: every URL the cascade could not read is an unknown, whether or not
      // the model said so.
      const pack = withUnreadableUnknowns(raw, corpus.unreadable, raw.unknowns.map((unknown) => unknown.queriesTried).flat());

      // §7: the mechanical check, before ingest.
      checked = checkProvenance(pack, corpus);
      reports.push(checked.report);
      if (!checked.report.rejected) break;
      if (attempt === PROVENANCE_RERUNS) {
        throw new TerminalError(
          `research: bad_output — ${checked.report.failed.length} of ${checked.report.total} items could not be found in the pages this run read, twice`,
        );
      }
      log({ event: "research.provenance.rerun", failed: checked.report.failed.length, total: checked.report.total });
      input = { ...baseInput, provenanceRerun: { failures: checked.report.failed.map((f) => ({ id: f.id, text: f.text.slice(0, 1000), reason: f.reason.slice(0, 300) })) } };
    }
    if (checked === undefined) throw new TerminalError("research: no attempt produced a pack");

    // §3: ingest.
    const validated = validatePack(checked.pack, { facts: facts.facts });
    if (!validated.ok) {
      throw new TerminalError(`research: bad_output — the pack does not validate at ingest: ${validated.issues.slice(0, 5).join("; ")}`);
    }

    const { event } = await recordResearchCompleted(db, {
      orgId: job.orgId,
      jobId: job.id,
      runId,
      pack: JSON.parse(JSON.stringify(validated.pack)),
      report: JSON.parse(JSON.stringify({ provenance: reports, demoted: validated.demoted, actuals, budget: definition.budget, attempts: reports.length })),
      facts: { product: facts.file.product, version: facts.file.version, hash: facts.hash, draft: facts.draft },
      breadth,
    });
    return { eventId: event.id };
  };
}

/** The runtime's own unknowns (§4): one per unreadable URL the model did not already account for. */
export function withUnreadableUnknowns(pack: ResearchPack, unreadable: ReadonlySet<string>, alreadyTried: string[]): ResearchPack {
  const tried = new Set(alreadyTried.map((q) => q.trim().toLowerCase()));
  const extra = [...unreadable]
    .filter((url) => !tried.has(url.toLowerCase()))
    .map((url) => ({
      id: `unreadable-${shortHash(url)}`,
      text: `A page that looked relevant could not be read: ${url}`,
      kind: "unreadable" as const,
      queriesTried: [url],
    }));
  if (extra.length === 0) return pack;
  // Parsed through the raw rules again so the added unknowns are the schema's, not this file's.
  return { ...pack, unknowns: [...pack.unknowns, ...extra] };
}

function shortHash(value: string): string {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

/** The failure reasons, classified the way `echo` classifies them, with research's own words. */
function classify(error: unknown): Error {
  if (!(error instanceof AgentRunFailedError)) return error instanceof Error ? error : new Error(String(error));
  switch (error.reason) {
    case "cap":
      // took_too_long, in the orchestrator's vocabulary: the same brief hits
      // the same cap again. A widened or narrowed brief is a new job.
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
