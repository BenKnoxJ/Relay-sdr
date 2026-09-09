import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { tool, type ToolSet } from "ai";
import { z } from "zod";

import { BudgetExceededError, type ResearchBudget } from "@/lib/research/budget";
import type { Corpus } from "@/lib/research/corpus";
import { capText, scrubFetched } from "@/lib/research/scrub";
import { fetchDiscriminator, searchDiscriminator } from "@/lib/services/research/discriminator";
import { ServiceError, type FetchService, type SearchHit, type SearchService } from "@/lib/services/types";
import { withReplay, type ToolRecorder } from "@/lib/agents/tools";

import type { ProductFacts } from "./input.schema";

/**
 * Research's four tools (`research.v2.signed.md` §4). Read-only; nothing spends.
 *
 * This factory is the only place a Tavily or Firecrawl client is held, and
 * the only place the budget is charged. Each tool is `withReplay` inside and
 * a thin wrapper outside, and the split is the point:
 *
 *   * **inside** `withReplay` (recorded, replayed, keyed): the provider call,
 *     the budget charge, the injection scan and the size cap. A replayed call
 *     runs none of it — it costs nothing and returns the stored text.
 *   * **outside** (runs on a live call and a replay alike): filling the corpus
 *     the provenance check reads, and the seventy-percent note the model sees
 *     on the next result. Neither is stored, so a replay is byte-identical to
 *     the record.
 *
 * Failures that spent nothing — the budget cap, a provider refusing the
 * request — are `unspent`, so the key is released and a retry may run the
 * call. A cap also ends the run: `recorder.abortRun("cap", …)`, which
 * `runAgent` reports as `cap` with the field named.
 */

export const RESEARCH_TOOL_NAMES = ["facts", "priorKnowledge", "search", "fetch"] as const;

/** The three articles `priorKnowledge()` may read, and nothing else on disk (§4). */
export const PRIOR_KNOWLEDGE_ARTICLES = ["overview", "icp", "competitors"] as const;

export type ResearchToolDeps = {
  facts: ProductFacts;
  /** Named to the model: a draft file is cited as a draft. */
  factsDraft: boolean;
  budget: ResearchBudget;
  corpus: Corpus;
  search: SearchService;
  fetch: FetchService;
  /** `<dir>/<product-slug>/{overview,icp,competitors}.md`. */
  priorKnowledgeDir: string;
  /** Where stripped injection lines and other runtime notes go. */
  log?: (line: Record<string, unknown>) => void;
};

const searchArgs = z
  .object({
    query: z.string().min(1).max(300),
    /** ISO-3166 alpha-2. */
    region: z.string().regex(/^[A-Z]{2}$/),
    recencyMonths: z.number().int().positive().max(120).optional(),
  })
  .strict();

const fetchArgs = z.object({ url: z.string().url().max(2000) }).strict();
const priorKnowledgeArgs = z.object({ product: z.string().min(1).max(120) }).strict();
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

export function researchTools(recorder: ToolRecorder, deps: ResearchToolDeps): ToolSet {
  let factsRead = false;

  /** §5 rule 1: facts first. Answered outside the record: it is not a call, it is a refusal to make one. */
  const requireFacts = (name: string): { runtimeNote: string } | null =>
    factsRead ? null : { runtimeNote: `Call facts() before ${name}(): the facts file is the only source of product claims.` };

  /** The seventy-percent note, on whatever result follows the crossing (§6). */
  const withNote = <T extends object>(result: T): T & { runtimeNote?: string } => {
    const crossed = deps.budget.crossed({ modelSteps: recorder.modelSteps });
    if (crossed.length === 0) return result;
    const note = crossed.map((field) => deps.budget.note(field, { modelSteps: recorder.modelSteps })).join(" ");
    deps.log?.({ event: "research.budget.checkpoint", fields: crossed });
    return { runtimeNote: note, ...result };
  };

  const charge = (field: "searches" | "fetches"): void => {
    try {
      deps.budget.charge(field);
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        recorder.abortRun("cap", `${error.message} with no answer`);
      }
      throw error;
    }
  };

  const facts = withReplay<Record<string, never>, { product: string; version: number; draft: boolean; facts: ProductFacts["facts"] }>(recorder, {
    name: "facts",
    toolKey: () => "facts",
    execute: async () => ({ product: deps.facts.product, version: deps.facts.version, draft: deps.factsDraft, facts: deps.facts.facts }),
  });

  const priorKnowledge = withReplay<{ product: string }, { advisory: true; articles: Array<{ name: string; text: string }> }>(recorder, {
    name: "priorKnowledge",
    toolKey: (args) => slug(args.product),
    execute: async (args) => {
      const dir = path.join(deps.priorKnowledgeDir, slug(args.product));
      const articles: Array<{ name: string; text: string }> = [];
      for (const name of PRIOR_KNOWLEDGE_ARTICLES) {
        const file = path.join(dir, `${name}.md`);
        if (!existsSync(file)) continue;
        articles.push({ name, text: capText(readFileSync(file, "utf8")) });
      }
      return { advisory: true, articles };
    },
  });

  const search = withReplay<z.infer<typeof searchArgs>, { hits: SearchHit[] }>(recorder, {
    name: "search",
    toolKey: (args) => searchDiscriminator(args),
    output: searchOutput,
    unspent: unspentFailure,
    execute: async (args) => {
      charge("searches");
      const { hits } = await deps.search.search({ ...args, maxResults: 8 });
      return { hits: hits.slice(0, 8) };
    },
  });

  const fetchPage = withReplay<z.infer<typeof fetchArgs>, z.infer<typeof fetchOutput>>(recorder, {
    name: "fetch",
    toolKey: (args) => fetchDiscriminator(args.url),
    output: fetchOutput,
    unspent: unspentFailure,
    execute: async (args) => {
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
      return { url: args.url, markdown: capText(text), strippedLines: stripped.length };
    },
  });

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
    priorKnowledge: tool({
      description: "What Relay already knew about this product's market: hypotheses to verify with a fresh URL this run, never findings.",
      inputSchema: priorKnowledgeArgs,
      execute: async (args) => requireFacts("priorKnowledge") ?? priorKnowledge(args),
    }),
    search: tool({
      description: "Web search for the market, the buyers and their words. Top eight results with title, url, snippet and date when known.",
      inputSchema: searchArgs,
      execute: async (args) => {
        const refused = requireFacts("search");
        if (refused !== null) return refused;
        const result = await search(args);
        for (const hit of result.hits) deps.corpus.addSnippet(hit.url, [hit.title, hit.snippet].filter((s) => s.length > 0).join(" — "));
        return withNote(result);
      },
    }),
    fetch: tool({
      description: "Read one page's main content as markdown (about 12,000 characters at most). If it cannot be read, say so as an unknown rather than guessing.",
      inputSchema: fetchArgs,
      execute: async (args) => {
        const refused = requireFacts("fetch");
        if (refused !== null) return refused;
        const result = await fetchPage(args);
        if ("unreadable" in result) deps.corpus.markUnreadable(result.url);
        else deps.corpus.addPage(result.url, result.markdown);
        return withNote(result);
      },
    }),
  };
}

function slug(product: string): string {
  return product.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
