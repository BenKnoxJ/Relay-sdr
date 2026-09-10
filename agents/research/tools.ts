import { createHash } from "node:crypto";

import { tool, type ToolSet } from "ai";
import { z } from "zod";

import { withReplay, type ToolRecorder } from "@/lib/agents/tools";
import type { NeverSayFile } from "@/lib/facts/neverSay";
import { liveFactIds } from "@/lib/facts/schema";
import { KNOWLEDGE_ARTICLES, type LoadedKnowledge } from "@/lib/knowledge/load";
import { latestModules, moduleWriteOutputSchema, refusals, type ModuleWrite, type ModuleWriteOutput } from "@/lib/research/assemble";
import { BudgetExceededError, type CountedField, type ResearchBudget } from "@/lib/research/budget";
import type { Corpus } from "@/lib/research/corpus";
import { checkModuleWrite } from "@/lib/research/moduleWrite";
import { capText, scrubFetched } from "@/lib/research/scrub";
import { fetchDiscriminator, searchDiscriminator } from "@/lib/services/research/discriminator";
import { ServiceError, type FetchService, type SearchHit, type SearchService } from "@/lib/services/types";

import { itemSchema } from "../_shared/item.schema";
import type { ProductFacts } from "./input.schema";
import { MODULE_IDS, MODULE_TITLES, type ModuleId } from "./output.schema";

/**
 * Research's six tools (`research.v3.signed.md` §4). Five read; `writeModule`
 * validates and stores. Nothing spends outside the run's own rails.
 *
 * This factory is the only place a Tavily or Firecrawl client is held, and
 * the only place the rails are charged. Each tool is `withReplay` inside and
 * a thin wrapper outside, and the split is the point:
 *
 *   * **inside** `withReplay` (recorded, replayed, keyed): the provider call,
 *     the rail charge, the injection scan and the size cap, and the module
 *     check with its verdict. A replayed call runs none of it — it costs
 *     nothing and returns the stored result.
 *   * **outside** (runs on a live call and a replay alike): filling the corpus
 *     the provenance check reads, keeping the run's view of which modules are
 *     accepted, the seventy-percent note, and what the model is shown.
 *
 * Failures that spent nothing — a rail, a provider refusing the request — are
 * `unspent`, so the key is released and a retry may run the call. A rail also
 * ends the run: `recorder.abortRun("cap", …)`; the handler then stores the
 * modules already accepted as a `partial` pack (§6).
 */

export const RESEARCH_TOOL_NAMES = ["facts", "knowledge", "priorPacks", "search", "fetch", "writeModule"] as const;

/** A prior pack as the agent reads it: module bodies, advisory (§4). */
export type PriorPack = { id: string; at: string; modules: Array<{ module: string; title: string; body: string }> };

export type ResearchToolDeps = {
  facts: ProductFacts;
  /** Named to the model: a draft file is cited as a draft. */
  factsDraft: boolean;
  knowledge: LoadedKnowledge;
  priorPacks: PriorPack[];
  budget: ResearchBudget;
  corpus: Corpus;
  search: SearchService;
  fetch: FetchService;
  /** The `writeModule` steps the job's earlier runs stored: what is accepted, and what was refused once. */
  priorWrites: ModuleWrite[];
  /** The modules this run may write (the phase's, or the bench's `--modules`). Absent means all of them. */
  onlyModules?: readonly ModuleId[];
  /** The product's never-say list (§10 note 20), checked on every module write. */
  neverSay?: Pick<NeverSayFile, "entries">;
  /** v3.1 (§10 note 17): the synthesis phase writes from the accepted modules; search and fetch are closed. */
  phase?: "research" | "synthesis";
  now?: () => Date;
  /** Where stripped injection lines and other runtime notes go. */
  log?: (line: Record<string, unknown>) => void;
};

const searchArgs = z
  .object({
    query: z.string().min(1).max(300),
    /** ISO-3166 alpha-2. */
    region: z.string().regex(/^[A-Z]{2}$/),
    recencyMonths: z.number().int().positive().max(120).optional(),
    /**
     * Which wave the search belongs to (§5). Not part of the replay key and
     * not sent to the provider: it is the record's way of showing that a
     * contradiction search ran, which rubric row 7 reads from the steps.
     */
    purpose: z.enum(["survey", "locate", "contradiction"]).optional(),
  })
  .strict();

const fetchArgs = z.object({ url: z.string().url().max(2000) }).strict();
const knowledgeArgs = z.object({ article: z.enum(KNOWLEDGE_ARTICLES) }).strict();
const writeArgs = z
  .object({
    module: z.enum(MODULE_IDS),
    /** The module's fields as its schema names them; `status` is the runtime's and is set on write. */
    content: z.record(z.unknown()),
  })
  .strict();
const noArgs = z.object({}).strict();

const searchOutput = z.object({ hits: z.array(z.object({ title: z.string(), url: z.string(), snippet: z.string(), publishedAt: z.string().optional() })) }).strict();
const fetchOutput = z.union([
  z.object({ url: z.string(), markdown: z.string(), strippedLines: z.number().int() }).strict(),
  z.object({ url: z.string(), unreadable: z.literal(true), reason: z.string() }).strict(),
]);

/** A failure that spent nothing: the key is released and a retry may run the call. */
export function unspentFailure(error: unknown): boolean {
  return error instanceof BudgetExceededError || error instanceof ServiceError;
}

/** Key order does not change what was written. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function contentDigest(content: unknown): string {
  return createHash("sha256").update(stableStringify(content)).digest("hex").slice(0, 32);
}

export function researchTools(recorder: ToolRecorder, deps: ResearchToolDeps): ToolSet {
  let factsRead = false;
  const now = deps.now ?? (() => new Date());
  const live = liveFactIds(deps.facts);
  const known = new Set(deps.facts.facts.filter((fact) => fact.status !== "retired").map((fact) => fact.id));
  // The run's view of what is written, seeded from the job's earlier runs.
  const accepted: Partial<Record<ModuleId, Record<string, unknown>>> = latestModules(deps.priorWrites);
  const refused = refusals(deps.priorWrites);

  /** §5 step 1: facts first. Answered outside the record: it is not a call, it is a refusal to make one. */
  const requireFacts = (name: string): { runtimeNote: string } | null =>
    factsRead ? null : { runtimeNote: `Call facts() before ${name}(): the facts file is the only source of product claims.` };

  const observed = () => ({ modelSteps: recorder.modelSteps, spendUsd: recorder.spendUsd });

  /** The seventy-percent note, on whatever result follows the crossing (§6). */
  const withNote = <T extends object>(result: T): T & { runtimeNote?: string } => {
    const crossed = deps.budget.crossed(observed());
    if (crossed.length === 0) return result;
    const note = crossed.map((field) => deps.budget.note(field, observed())).join(" ");
    deps.log?.({ event: "research.budget.checkpoint", fields: crossed });
    return { runtimeNote: note, ...result };
  };

  /** End the run at a rail. The handler stores the modules already accepted (§6). */
  const hitRail = (error: BudgetExceededError): never => {
    recorder.abortRun("cap", `${error.message}; the modules already written are kept`);
    throw error;
  };

  const charge = (field: CountedField): void => {
    try {
      deps.budget.charge(field);
    } catch (error) {
      if (error instanceof BudgetExceededError) hitRail(error);
      throw error;
    }
  };

  /** The rails a call cannot pass once they are used up: fetched text, and spend. */
  const refuseIfExhausted = (field: "fetchedChars" | "spend"): void => {
    if (deps.budget.exhausted(field, observed())) hitRail(new BudgetExceededError(field, deps.budget.limitOf(field) ?? 0));
  };

  const facts = withReplay<Record<string, never>, { product: string; version: number; draft: boolean; facts: ProductFacts["facts"] }>(recorder, {
    name: "facts",
    toolKey: () => "facts",
    execute: async () => ({ product: deps.facts.product, version: deps.facts.version, draft: deps.factsDraft, facts: deps.facts.facts }),
  });

  const knowledge = withReplay<z.infer<typeof knowledgeArgs>, { article: string; version: number; text: string }>(recorder, {
    name: "knowledge",
    toolKey: (args) => `${deps.knowledge.manifest.version}:${args.article}`,
    execute: async (args) => ({ article: args.article, version: deps.knowledge.manifest.version, text: deps.knowledge.articles.get(args.article) ?? "" }),
  });

  const priorPacks = withReplay<Record<string, never>, { advisory: true; packs: PriorPack[] }>(recorder, {
    name: "priorPacks",
    toolKey: () => deps.priorPacks.map((pack) => pack.id).join(",") || "none",
    execute: async () => ({ advisory: true, packs: deps.priorPacks }),
  });

  const search = withReplay<z.infer<typeof searchArgs>, { hits: SearchHit[] }>(recorder, {
    name: "search",
    toolKey: (args) => searchDiscriminator(args),
    output: searchOutput,
    unspent: unspentFailure,
    execute: async (args) => {
      refuseIfExhausted("spend");
      charge("searches");
      const { hits } = await deps.search.search({
        query: args.query,
        region: args.region,
        ...(args.recencyMonths === undefined ? {} : { recencyMonths: args.recencyMonths }),
        maxResults: 8,
      });
      return { hits: hits.slice(0, 8) };
    },
  });

  const fetchPage = withReplay<z.infer<typeof fetchArgs>, z.infer<typeof fetchOutput>>(recorder, {
    name: "fetch",
    toolKey: (args) => fetchDiscriminator(args.url),
    output: fetchOutput,
    unspent: unspentFailure,
    execute: async (args) => {
      refuseIfExhausted("spend");
      refuseIfExhausted("fetchedChars");
      charge("fetches");
      // The cascade (§4): Firecrawl, then Tavily's extract, then unreadable.
      let read = await deps.fetch.scrape(args.url);
      if ("unreadable" in read) {
        const second = await deps.search.extract(args.url);
        if ("unreadable" in second) return { url: args.url, unreadable: true, reason: `${read.reason}; ${second.reason}` };
        read = second;
      }
      const { text, stripped } = scrubFetched(read.markdown);
      if (stripped.length > 0) deps.log?.({ event: "research.fetch.stripped", url: args.url, lines: stripped.length, sample: stripped.slice(0, 3) });
      const markdown = capText(text);
      // Read already; counted, and the next fetch is refused once the rail is used.
      deps.budget.record("fetchedChars", markdown.length);
      return { url: args.url, markdown, strippedLines: stripped.length };
    },
  });

  const writeModule = withReplay<z.infer<typeof writeArgs>, ModuleWriteOutput>(recorder, {
    name: "writeModule",
    toolKey: (args) => `${args.module}:${contentDigest(args.content)}`,
    output: moduleWriteOutputSchema,
    execute: async (args) => {
      const digest = contentDigest(args.content);
      const check = checkModuleWrite(args.module, args.content, {
        accepted,
        liveFactIds: live,
        knownFactIds: known,
        ...(deps.neverSay === undefined ? {} : { neverSay: deps.neverSay }),
        now: now(),
      });
      if (check.ok) {
        if (check.demoted.length > 0) deps.log?.({ event: "research.module.demoted", module: args.module, demoted: check.demoted });
        return { accepted: true, module: args.module, digest, stored: check.module as Record<string, unknown> };
      }
      const seen = refused.get(args.module) ?? new Set<string>();
      seen.add(digest);
      refused.set(args.module, seen);
      // §7: one rewrite with the issues; a second refusal is stored `insufficient`
      // and the run moves on — unless a complete version is already stored, which stands.
      if (seen.size >= 2 && accepted[args.module]?.status !== "complete") {
        return { accepted: false, module: args.module, digest, issues: check.issues, insufficient: insufficientRecord(args.content, check.issues) };
      }
      return { accepted: false, module: args.module, digest, issues: check.issues };
    },
  });

  // m19 is the runtime's (§10 note 18); the model never writes it.
  const allowed = (id: ModuleId): boolean => id !== "m19" && (deps.onlyModules === undefined || deps.onlyModules.includes(id));
  /** The synthesis phase reads no new pages: answered outside the record, like a call before facts. */
  const closedInSynthesis = (name: string): { runtimeNote: string } | null =>
    deps.phase === "synthesis" ? { runtimeNote: `${name}() is closed in the synthesis phase: write from the accepted modules and cite the pages they cite.` } : null;
  const remaining = (): ModuleId[] => MODULE_IDS.filter((id) => allowed(id) && accepted[id] === undefined);

  return {
    facts: tool({
      description: "The signed product facts file: the only source of product claims. Call this first.",
      inputSchema: noArgs,
      execute: async () => {
        const result = await facts({} as Record<string, never>);
        factsRead = true;
        return result;
      },
    }),
    knowledge: tool({
      description: `One article of the product knowledge set (${KNOWLEDGE_ARTICLES.join(", ")}). The roadmap's shipped column is the only source for solution mapping.`,
      inputSchema: knowledgeArgs,
      execute: async (args) => requireFacts("knowledge") ?? knowledge(args),
    }),
    priorPacks: tool({
      description: "This org's earlier packs for the product, module bodies included. Advisory: a prior claim enters this pack only with a fresh URL found this run.",
      inputSchema: noArgs,
      execute: async () => requireFacts("priorPacks") ?? priorPacks({} as Record<string, never>),
    }),
    search: tool({
      description: "Web search for the market, the buyers and their words. Top eight results with title, url, snippet and date when known.",
      inputSchema: searchArgs,
      execute: async (args) => {
        const refusedNote = requireFacts("search") ?? closedInSynthesis("search");
        if (refusedNote !== null) return refusedNote;
        const result = await search(args);
        for (const hit of result.hits) deps.corpus.addSnippet(hit.url, [hit.title, hit.snippet].filter((s) => s.length > 0).join(" — "));
        return withNote(result);
      },
    }),
    fetch: tool({
      description: "Read one page's main content as markdown (about 12,000 characters at most). If it cannot be read, say so as an unknown rather than guessing.",
      inputSchema: fetchArgs,
      execute: async (args) => {
        const refusedNote = requireFacts("fetch") ?? closedInSynthesis("fetch");
        if (refusedNote !== null) return refusedNote;
        const result = await fetchPage(args);
        if ("unreadable" in result) deps.corpus.markUnreadable(result.url);
        else deps.corpus.addPage(result.url, result.markdown);
        return withNote(result);
      },
    }),
    writeModule: tool({
      description:
        "Write one module of the pack as soon as it is ready. It is validated on the spot: accepted modules are kept even if the run is cut short; a refused one comes back with its issues — fix them and write it again once. A second refusal stores it as insufficient and you move on.",
      inputSchema: writeArgs,
      execute: async (args) => {
        // A bench run restricted to some modules: refused outside the record, like a call before facts.
        if (args.module === "m19") return { accepted: false, module: args.module, issues: ["m19 is assembled by the runtime from every url the pack cites; do not write it"], stillToWrite: remaining() };
        if (!allowed(args.module)) return { accepted: false, module: args.module, issues: [`this run writes only ${deps.onlyModules!.join(", ")}`], stillToWrite: remaining() };
        const result = await writeModule(args);
        if (result.accepted) {
          accepted[args.module] = result.stored;
          return withNote({ accepted: true, module: args.module, title: MODULE_TITLES[args.module], stillToWrite: remaining() });
        }
        if (result.insufficient !== undefined && accepted[args.module]?.status !== "complete") {
          accepted[args.module] = result.insufficient;
          return withNote({ accepted: false, module: args.module, issues: result.issues, storedAs: "insufficient", note: "Stored as insufficient with these issues. Move on to the next module.", stillToWrite: remaining() });
        }
        return withNote({ accepted: false, module: args.module, issues: result.issues, note: "Fix these issues and write this module again. A second refusal stores it as insufficient." });
      },
    }),
  };
}

/** A module refused twice, as the runtime stores it: the prose and the claims that parse, and the issues. */
function insufficientRecord(content: Record<string, unknown>, issues: string[]): Record<string, unknown> {
  const body = typeof content.body === "string" && content.body.trim().length > 0 ? content.body : "(not written)";
  const claims = Array.isArray(content.claims) ? content.claims.filter((claim) => itemSchema.safeParse(claim).success) : [];
  return { status: "insufficient", body, claims, issues: issues.length > 0 ? issues : ["refused twice"] };
}
