import { createHash } from "node:crypto";

import { tool, type ToolSet } from "ai";
import { z } from "zod";

import { withReplay, type ToolRecorder } from "@/lib/agents/tools";
import type { NeverSayFile } from "@/lib/facts/neverSay";
import { liveFactIds } from "@/lib/facts/schema";
import { KNOWLEDGE_ARTICLES, type LoadedKnowledge } from "@/lib/knowledge/load";
import {
  latestModules,
  moduleWriteOutputSchema,
  refusals,
  scopeDecisionOutputSchema,
  type ModuleWrite,
  type ModuleWriteOutput,
  type ResearchState,
  type ScopeDecisionOutput,
} from "@/lib/research/assemble";
import { BudgetExceededError, type CountedField, type ResearchBudget } from "@/lib/research/budget";
import type { Corpus } from "@/lib/research/corpus";
import { checkModuleWrite, groupVoiceIssues } from "@/lib/research/moduleWrite";
import { applyFixes } from "@/lib/research/normalise";
import { capText, scrubFetched } from "@/lib/research/scrub";
import { fetchDiscriminator, searchDiscriminator } from "@/lib/services/research/discriminator";
import { ServiceError, type FetchService, type SearchHit, type SearchService } from "@/lib/services/types";

import { itemSchema } from "../_shared/item.schema";
import type { ProductFacts } from "./input.schema";
import { MODULE_IDS, MODULE_TITLES, SCOPE_ISSUE, moduleItems, wideningIssue, wideningSchema, type LockedScope, type ModuleId, type PackShape } from "./output.schema";

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

export const RESEARCH_TOOL_NAMES = ["facts", "knowledge", "priorPacks", "search", "fetch", "writeModule", "decideScope"] as const;

/** v3.2 (§10 note 28): what may be written before the scope is decided. */
const BEFORE_THE_GATE: readonly ModuleId[] = ["m00", "m01"];
/** Scope refusals of m04 after which a stop is the only action left. */
const M04_SCOPE_LOCK = 2;

/** A prior pack as the agent reads it: module bodies, advisory (§4), and the seed firms it held by identity (§10 note 29). */
export type PriorPack = { id: string; at: string; modules: Array<{ module: string; title: string; body: string }>; seedFirms: Array<{ name: string; domain?: string }> };

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
  /** v3.2 (§10 note 28): the rep's locked scope, enforced on m04 and on each widening option. */
  scope?: LockedScope;
  /** v3.2: where the job's research stood when this run began, read from its steps. Absent means open. */
  priorState?: ResearchState;
  /** v3.2: this run is a re-ask; the scope is not decided again in one. */
  reask?: boolean;
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
    content: z.record(z.unknown()).optional(),
    /**
     * After a refusal: only the fields that were wrong, as `{ path, value }` with
     * the paths the issues name; applied to the last refused version (§10 note
     * 23). `value: null` removes the field. Send `content` or `fixes`, not both.
     */
    fixes: z.array(z.object({ path: z.string().min(1).max(300), value: z.unknown() }).strict()).min(1).max(100).optional(),
  })
  .strict();
/** What the replayed inner call is keyed and stored on: always the whole module. */
type ResolvedArgs = { module: ModuleId; content: Record<string, unknown> };
const noArgs = z.object({}).strict();
/**
 * The stop's prose limits (§10 note 28): a target the model is asked to write
 * to, and a hard maximum refused with the length it came to. The hard maxima
 * are checked in code rather than in the argument schema, so an over-long
 * answer gets a refusal that says how long it was and asks for a shorter
 * rewrite, not the transport's generic validation error (brief C v3.2 lost
 * three turns to that).
 */
export const REASON_TARGET = 1000;
export const REASON_MAX = 4000;
export const WIDENING_TEXT_TARGET = 250;
export const WIDENING_TEXT_MAX = 400;
/** A runaway rail on what the transport accepts; the real limits are the two above. */
const PROSE_RAIL = 50_000;

const decideArgs = z
  .object({
    verdict: z.enum(["continue", "stop"]),
    /** Why the market inside the brief does, or does not, support the rest of the pack. Under 1,000 characters; 4,000 at most. */
    reason: z.string().min(1).max(PROSE_RAIL),
    /** Ids of accepted m00/m01 Items the decision rests on — the in-scope evidence, cited, not copied. */
    evidenceIds: z.array(z.string().min(1).max(200)).max(40).optional(),
    /** On a stop: one to three genuine widening options, each a scope change for the rep to approve. Never padded. Text under 250 characters; 400 at most. */
    widenings: z.array(wideningSchema.extend({ text: z.string().min(1).max(PROSE_RAIL) })).min(1).max(3).optional(),
  })
  .strict();

/** Literal `\n` a model sometimes sends inside a JSON string, as the line break it meant. */
export function unescapeProse(text: string): string {
  return text.replace(/\\r\\n|\\n/g, "\n").replace(/\\t/g, " ");
}

/** The over-limit refusals, each with the length it came to: shorter, the same points, nothing added. */
function proseLimitIssues(args: z.infer<typeof decideArgs>): string[] {
  const issues: string[] = [];
  if (args.reason.length > REASON_MAX) {
    issues.push(`reason is ${args.reason.length} characters; the limit is ${REASON_MAX} and the target is under ${REASON_TARGET}. Rewrite it shorter — the same points, no added detail.`);
  }
  (args.widenings ?? []).forEach((widening, i) => {
    if (widening.text.length > WIDENING_TEXT_MAX) {
      issues.push(`widenings.${i}.text is ${widening.text.length} characters; the limit is ${WIDENING_TEXT_MAX} and the target is under ${WIDENING_TEXT_TARGET}. Rewrite it shorter — the same option, no added detail.`);
    }
  });
  return issues;
}

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
  const planned = new Set(deps.facts.facts.filter((fact) => fact.status === "planned").map((fact) => fact.id));
  // The run's view of what is written, seeded from the job's earlier runs.
  const accepted: Partial<Record<ModuleId, Record<string, unknown>>> = latestModules(deps.priorWrites);
  const refused = refusals(deps.priorWrites);
  // The last version the model sent for each module: the base for `fixes`.
  const lastSent = new Map<ModuleId, Record<string, unknown>>();
  for (const write of deps.priorWrites) if (write.content !== undefined) lastSent.set(write.module, write.content);
  // v3.2 (§10 note 28): the scope decision, and how often m04 has been refused for scope.
  let state: ResearchState["state"] = deps.priorState?.state ?? "open";
  const isScopeRefusal = (issues: readonly string[]): boolean => issues.some((issue) => issue.startsWith(SCOPE_ISSUE));
  let m04ScopeRefusals = deps.priorWrites.filter((w) => w.module === "m04" && !w.output.accepted && isScopeRefusal(w.output.issues)).length;
  const locked = (): boolean => state === "gated" && m04ScopeRefusals >= M04_SCOPE_LOCK;
  const pageText = (url: string): string | undefined => (deps.corpus.has(url) ? deps.corpus.textFor(url) : undefined);

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

  const writeModule = withReplay<ResolvedArgs, ModuleWriteOutput>(recorder, {
    name: "writeModule",
    toolKey: (args) => `${args.module}:${contentDigest(args.content)}`,
    output: moduleWriteOutputSchema,
    execute: async (args) => {
      const digest = contentDigest(args.content);
      const check = checkModuleWrite(args.module, args.content, {
        accepted,
        liveFactIds: live,
        knownFactIds: known,
        plannedFactIds: planned,
        ...(deps.neverSay === undefined ? {} : { neverSay: deps.neverSay }),
        ...(deps.scope === undefined ? {} : { scope: deps.scope, pageText }),
        now: now(),
      });
      if (check.ok) {
        if (check.demoted.length > 0) deps.log?.({ event: "research.module.demoted", module: args.module, demoted: check.demoted });
        if (check.normalised.length > 0) deps.log?.({ event: "research.module.normalised", module: args.module, normalised: check.normalised });
        return { accepted: true, module: args.module, digest, stored: check.module as Record<string, unknown>, ...(check.normalised.length > 0 ? { normalised: check.normalised } : {}) };
      }
      const seen = refused.get(args.module) ?? new Set<string>();
      seen.add(digest);
      refused.set(args.module, seen);
      // §7: one rewrite with the issues; a second refusal is stored `insufficient`
      // and the run moves on — unless a complete version is already stored, which stands.
      // v3.2: an m04 refused for scope is never stored; the lock sends the run to a decision instead.
      if (seen.size >= 2 && accepted[args.module]?.status !== "complete" && !(args.module === "m04" && isScopeRefusal(check.issues))) {
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

  /** v3.2: after a stop nothing more is researched or written. Answered outside the record. */
  const afterStop = (name: string): { runtimeNote: string } | null =>
    state === "stopped" ? { runtimeNote: `Research has stopped: the evidence inside the brief is insufficient. ${name}() is closed; close now with { modulesWritten, note }.` } : null;
  /** v3.2: two scope refusals of m04 after a continue — a stop is the only action left. */
  const whileLocked = (name: string): { runtimeNote: string } | null =>
    locked()
      ? { runtimeNote: `${name}() is closed: m04 has been refused twice for leaving the rep's scope, so the market inside the brief cannot fill it. The only action left is decideScope({ verdict: "stop", reason, evidenceIds, widenings }).` }
      : null;

  const decideScope = withReplay<z.infer<typeof decideArgs>, ScopeDecisionOutput>(recorder, {
    name: "decideScope",
    toolKey: (args) => `${args.verdict}:${contentDigest(args)}`,
    output: scopeDecisionOutputSchema,
    execute: async (args) => {
      const issues: string[] = [];
      // After m01 (§10 note 28): the decision rests on the steering note and the landscape.
      if (accepted.m00 === undefined) issues.push("write m00 before deciding the scope");
      if (allowed("m01") && accepted.m01 === undefined) issues.push("write m01, the market landscape, before deciding the scope");
      const held = { modules: accepted, partial: false, missingModules: [] } as unknown as PackShape;
      const known = [...new Set([...moduleItems(held, "m00"), ...moduleItems(held, "m01")].map((item) => item.id))];
      const loose = (args.evidenceIds ?? []).filter((id) => !known.includes(id));
      for (const id of loose) issues.push(`evidenceIds: ${JSON.stringify(id)} is not an item of the accepted m00 or m01`);
      // Name the ids that are, exactly, so the model corrects them rather than dropping its evidence (brief C v3.2).
      if (loose.length > 0) issues.push(`evidenceIds must be copied exactly from these m00/m01 item ids: ${known.length === 0 ? "(none — m00 and m01 hold no items)" : known.join(", ")}`);
      if (args.verdict === "continue" && args.widenings !== undefined) issues.push("widenings: a continue proposes no widening; widenings go with a stop");
      if (args.verdict === "stop") {
        if (args.widenings === undefined) issues.push("widenings: a stop names one to three genuine ways the rep could widen the brief");
        const patches = new Set<string>();
        for (const [i, widening] of (args.widenings ?? []).entries()) {
          const key = contentDigest(widening.scopePatch);
          if (patches.has(key)) issues.push(`widenings.${i}: the same change as an earlier option`);
          patches.add(key);
          const why = deps.scope === undefined ? null : wideningIssue(deps.scope, widening);
          if (why !== null) issues.push(`widenings.${i}: ${why}`);
        }
      }
      if (issues.length > 0) return { accepted: false, issues };
      return { accepted: true, verdict: args.verdict, reason: args.reason, evidenceIds: args.evidenceIds ?? [], widenings: args.widenings ?? [], decidedAt: now().toISOString() };
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
    knowledge: tool({
      description: `One article of the product knowledge set (${KNOWLEDGE_ARTICLES.join(", ")}). The roadmap's shipped column is the only source for solution mapping.`,
      inputSchema: knowledgeArgs,
      execute: async (args) => requireFacts("knowledge") ?? knowledge(args),
    }),
    priorPacks: tool({
      description:
        "This org's earlier packs for the product: module bodies and the seed firms each held (name, domain). The authority on what the earlier research contained. Advisory: a prior claim enters this pack only with a fresh URL found this run.",
      inputSchema: noArgs,
      execute: async () => requireFacts("priorPacks") ?? priorPacks({} as Record<string, never>),
    }),
    search: tool({
      description: "Web search for the market, the buyers and their words. Top eight results with title, url, snippet and date when known.",
      inputSchema: searchArgs,
      execute: async (args) => {
        const refusedNote = requireFacts("search") ?? closedInSynthesis("search") ?? afterStop("search") ?? whileLocked("search");
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
        const refusedNote = requireFacts("fetch") ?? closedInSynthesis("fetch") ?? afterStop("fetch") ?? whileLocked("fetch");
        if (refusedNote !== null) return refusedNote;
        const result = await fetchPage(args);
        if ("unreadable" in result) deps.corpus.markUnreadable(result.url);
        else deps.corpus.addPage(result.url, result.markdown);
        return withNote(result);
      },
    }),
    writeModule: tool({
      description:
        "Write one module of the pack as soon as it is ready. It is validated on the spot: accepted modules are kept even if the run is cut short; a refused one comes back with its issues — fix them and write it again once. A second refusal stores it as insufficient and you move on. Only m00 and m01 may be written before decideScope.",
      inputSchema: writeArgs,
      execute: async (args) => {
        const closed = afterStop("writeModule") ?? whileLocked("writeModule");
        if (closed !== null) return closed;
        // v3.2 (§10 note 28): the gate after m01. Answered outside the record.
        if (deps.phase !== "synthesis" && state === "open" && !BEFORE_THE_GATE.includes(args.module)) {
          return {
            accepted: false,
            module: args.module,
            issues: ["decide scope first: after m01, call decideScope — continue if the market inside the brief supports the rest of the pack, stop if it does not"],
          };
        }
        // A bench run restricted to some modules: refused outside the record, like a call before facts.
        if (args.module === "m19") return { accepted: false, module: args.module, issues: ["m19 is assembled by the runtime from every url the pack cites; do not write it"], stillToWrite: remaining() };
        if (!allowed(args.module)) return { accepted: false, module: args.module, issues: [`this run writes only ${deps.onlyModules!.join(", ")}`], stillToWrite: remaining() };
        // `content`, or `fixes` to the last version sent (§10 note 23): resolved to the whole module first.
        let content = args.content;
        if (args.fixes !== undefined) {
          const base = lastSent.get(args.module);
          if (content !== undefined || base === undefined) {
            return { accepted: false, module: args.module, issues: [content !== undefined ? "send content or fixes, not both" : "there is no earlier version of this module to fix; send its whole content"] };
          }
          const applied = applyFixes(base, args.fixes);
          if (applied.errors.length > 0) return { accepted: false, module: args.module, issues: applied.errors, note: "Fix the paths, or send the whole content." };
          content = applied.content;
        }
        if (content === undefined) return { accepted: false, module: args.module, issues: ["send the module's content, or fixes to its last refused version"] };
        // What is checked is what is stored: a fix sent with no value leaves no
        // key, as the JSON it is stored as does (brief A v3.2 removed m06's
        // group voice that way, and the key it left behind refused it again).
        content = JSON.parse(JSON.stringify(content)) as Record<string, unknown>;
        lastSent.set(args.module, content);
        // A structural slip, answered outside the record: it does not spend the module's one rewrite.
        const structural = groupVoiceIssues(args.module, content);
        if (structural.length > 0) {
          return {
            accepted: false,
            module: args.module,
            issues: structural,
            note: 'A structural refusal: it does not use up your rewrite. Send fixes [{ path: "perArchetype.<n>.voice", value: null }] for each group, keeping every phrase\'s own voice — or the whole module again without the group-level field.',
          };
        }
        const result = await writeModule({ module: args.module, content });
        if (result.accepted) {
          accepted[args.module] = result.stored;
          const normalised = (result as { normalised?: string[] }).normalised;
          return withNote({
            accepted: true,
            module: args.module,
            title: MODULE_TITLES[args.module],
            ...(normalised === undefined ? {} : { correctedByTheRuntime: normalised }),
            stillToWrite: remaining(),
          });
        }
        if (result.insufficient !== undefined && accepted[args.module]?.status !== "complete") {
          accepted[args.module] = result.insufficient;
          return withNote({ accepted: false, module: args.module, issues: result.issues, storedAs: "insufficient", note: "Stored as insufficient with these issues. Move on to the next module.", stillToWrite: remaining() });
        }
        const scoped = args.module === "m04" && isScopeRefusal(result.issues);
        if (scoped) m04ScopeRefusals += 1;
        return withNote({
          accepted: false,
          module: args.module,
          issues: result.issues,
          note: scoped
            ? locked()
              ? 'm04 has been refused twice for leaving the rep\'s scope. The only action left is decideScope({ verdict: "stop", reason, evidenceIds, widenings }).'
              : 'A seed firm or recipe outside the rep\'s scope cannot be written. Replace it with one inside the scope, or, if the market inside the brief cannot fill m04, decideScope({ verdict: "stop", ... }). Never widen the brief yourself.'
            : "Send only the fixes: writeModule({ module, fixes: [{ path, value }] }) with the paths above; the rest of your last version is kept. A second refusal stores it as insufficient.",
        });
      },
    }),
    decideScope: tool({
      description:
        "Decide, after m01, whether the market inside the rep's brief supports the rest of the pack. continue: go on to m02 and the rest. stop: research ends here — no more searches, pages or modules — with the reason, the ids of the m00/m01 items it rests on, and one to three genuine ways the rep could widen the brief (region, size, sector or role), each as a scope change. Never widen the brief yourself; never invent an option to reach three. Be concise: the reason under 1,000 characters (4,000 at most), each option's text under 250 (400 at most); evidenceIds copied exactly from m00/m01 item ids.",
      inputSchema: decideArgs,
      execute: async (args) => {
        const closed = afterStop("decideScope");
        if (closed !== null) return closed;
        if (deps.phase === "synthesis" || deps.reask === true) return { runtimeNote: "decideScope() is for the research phase; the scope is already decided." };
        if (args.verdict === "continue" && locked()) return whileLocked("decideScope(continue)");
        if (args.verdict === "continue" && state === "gated") return { accepted: true, verdict: "continue", note: "The scope is already decided: continue." };
        // Too long: answered outside the record with the length, like any other malformed call.
        const tooLong = proseLimitIssues(args);
        if (tooLong.length > 0) return { accepted: false, issues: tooLong, note: "Shorten and decide again." };
        const result = await decideScope({
          ...args,
          reason: unescapeProse(args.reason),
          ...(args.widenings === undefined ? {} : { widenings: args.widenings.map((w) => ({ ...w, text: unescapeProse(w.text) })) }),
        });
        if (!result.accepted) return { accepted: false, issues: result.issues, note: "Fix the issues and decide again." };
        state = result.verdict === "stop" ? "stopped" : "gated";
        return result.verdict === "stop"
          ? { accepted: true, verdict: "stop", note: "Research has stopped. Close now with { modulesWritten, note }." }
          : withNote({ accepted: true, verdict: "continue", stillToWrite: remaining() });
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
