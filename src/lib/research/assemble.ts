import type { AgentRunStep } from "@prisma/client";
import { z } from "zod";

import { hostOf, itemSchema } from "../../../agents/_shared/item.schema";
import { MODULE_IDS, isModuleId, moduleItems, type ModuleId, type PackShape } from "../../../agents/research/output.schema";
import { moduleUrlFields } from "../../../agents/research/output/urls";
import { normaliseUrl, type Corpus } from "@/lib/research/corpus";

/**
 * The pack, from what the job wrote (research v3 §3, §4 `writeModule`, §6).
 *
 * The modules are not the run's answer: each is a stored `writeModule` step.
 * Assembly reads every such step across **every run of the job** and takes the
 * latest stored version of each module, so a retry after a kill keeps what the
 * first run wrote and takes what the second rewrites, and a rail reached
 * mid-run still leaves the accepted modules to store as a `partial` pack.
 *
 * The corpus is rebuilt the same way: every search and fetch the job's runs
 * stored, so provenance on a retry reads the pages the first run read.
 */

/** What `writeModule` stores on its step (the model sees less; see the tool). */
export const moduleWriteOutputSchema = z.union([
  z.object({ accepted: z.literal(true), module: z.string(), digest: z.string(), stored: z.record(z.unknown()), normalised: z.array(z.string()).optional() }).strict(),
  z
    .object({
      accepted: z.literal(false),
      module: z.string(),
      digest: z.string(),
      issues: z.array(z.string()),
      /** Present on the second refusal: the module as written, stored `insufficient` with its issues. */
      insufficient: z.record(z.unknown()).optional(),
    })
    .strict(),
]);
export type ModuleWriteOutput = z.infer<typeof moduleWriteOutputSchema>;

/** `content` is what the model sent, the base a `fixes` answer to a refusal applies to (§10 note 23). */
export type ModuleWrite = { module: ModuleId; digest: string; output: ModuleWriteOutput; content?: Record<string, unknown> };

/** The `writeModule` steps, in the order they happened across the job's runs. */
export function moduleWritesFromSteps(steps: readonly AgentRunStep[]): ModuleWrite[] {
  const out: ModuleWrite[] = [];
  for (const step of steps) {
    if (step.name !== "writeModule") continue;
    const parsed = moduleWriteOutputSchema.safeParse(step.output);
    if (!parsed.success || !isModuleId(parsed.data.module)) continue;
    const sent = (step.input as { content?: unknown } | null)?.content;
    out.push({
      module: parsed.data.module,
      digest: parsed.data.digest,
      output: parsed.data,
      ...(sent !== null && typeof sent === "object" && !Array.isArray(sent) ? { content: sent as Record<string, unknown> } : {}),
    });
  }
  return out;
}

/** The stored version of a write: the accepted module, the `insufficient` record, or nothing. */
export function storedOf(write: ModuleWrite): Record<string, unknown> | undefined {
  return write.output.accepted ? write.output.stored : write.output.insufficient;
}

/**
 * The latest stored version of each module. A complete version is never
 * replaced by a later `insufficient` one: a module the model once wrote well
 * stays written.
 */
export function latestModules(writes: readonly ModuleWrite[]): Partial<Record<ModuleId, Record<string, unknown>>> {
  const latest: Partial<Record<ModuleId, Record<string, unknown>>> = {};
  for (const write of writes) {
    const stored = storedOf(write);
    if (stored === undefined) continue;
    const current = latest[write.module];
    if (current !== undefined && current.status === "complete" && stored.status === "insufficient") continue;
    latest[write.module] = stored;
  }
  return latest;
}

/** Digests of the refused writes per module: the second distinct refusal stores the module `insufficient`. */
export function refusals(writes: readonly ModuleWrite[]): Map<ModuleId, Set<string>> {
  const out = new Map<ModuleId, Set<string>>();
  for (const write of writes) {
    if (write.output.accepted) continue;
    const set = out.get(write.module) ?? new Set<string>();
    set.add(write.digest);
    out.set(write.module, set);
  }
  return out;
}

/** The pack as written, unvalidated: every stored module, the rest listed missing (§6). */
export function assemblePack(writes: readonly ModuleWrite[], options: { insufficient?: PackShape["insufficient"] } = {}): PackShape {
  const modules = latestModules(writes);
  const missingModules = MODULE_IDS.filter((id) => modules[id] === undefined);
  return {
    modules: modules as PackShape["modules"],
    ...(options.insufficient === undefined ? {} : { insufficient: options.insufficient }),
    partial: missingModules.length > 0,
    missingModules,
  };
}

/**
 * Store a module the ingest refused twice as `insufficient` (§3, §7): its body
 * and claims as written, and the issues. Pack-level rules skip it thereafter.
 */
export function markInsufficient(pack: PackShape, id: ModuleId, issues: string[]): PackShape {
  const current = (pack.modules as Record<ModuleId, { body?: unknown; claims?: unknown } | undefined>)[id];
  if (current === undefined) return pack;
  const body = typeof current.body === "string" && current.body.length > 0 ? current.body : "(not written)";
  const claims = Array.isArray(current.claims) ? current.claims.filter((claim) => itemSchema.safeParse(claim).success) : [];
  return {
    ...pack,
    modules: { ...pack.modules, [id]: { status: "insufficient", body, claims, issues: issues.length > 0 ? issues : ["refused at ingest"] } } as PackShape["modules"],
  };
}

const searchStepOutput = z.object({ hits: z.array(z.object({ title: z.string(), url: z.string(), snippet: z.string() }).passthrough()) }).passthrough();
const fetchStepOutput = z.union([
  z.object({ url: z.string(), markdown: z.string() }).passthrough(),
  z.object({ url: z.string(), unreadable: z.literal(true) }).passthrough(),
]);

/** Fill the corpus from every search and fetch the job's runs stored (§7 reads it). */
export function corpusFromSteps(corpus: Corpus, steps: readonly AgentRunStep[]): void {
  for (const step of steps) {
    if (step.name === "search") {
      const parsed = searchStepOutput.safeParse(step.output);
      if (!parsed.success) continue;
      for (const hit of parsed.data.hits) corpus.addSnippet(hit.url, [hit.title, hit.snippet].filter((s) => s.length > 0).join(" — "));
    } else if (step.name === "fetch") {
      const parsed = fetchStepOutput.safeParse(step.output);
      if (!parsed.success) continue;
      if ("unreadable" in parsed.data) corpus.markUnreadable(parsed.data.url);
      else corpus.addPage(parsed.data.url, parsed.data.markdown);
    }
  }
}

/**
 * m19, written by the runtime (v3.1, §10 note 18): every url any module cites
 * — its Items and its url fields — with the title the search gave it and the
 * day this job read it, the knowledge articles the job read, the facts
 * version and the prior packs. Brief E's model-written m19 listed 12 of 54
 * cited urls and said it was complete.
 */
export function withRuntimeSources(
  pack: PackShape,
  steps: readonly AgentRunStep[],
  context: { factsVersion: number; priorPackIds: string[]; today?: string },
): PackShape {
  const titles = new Map<string, string>();
  const readOn = new Map<string, string>();
  const articles = new Set<string>();
  for (const step of steps) {
    const day = step.createdAt.toISOString().slice(0, 10);
    if (step.name === "search") {
      const parsed = searchStepOutput.safeParse(step.output);
      if (parsed.success) for (const hit of parsed.data.hits) {
        const key = normaliseUrl(hit.url);
        if (!titles.has(key) && hit.title.trim().length > 0) titles.set(key, hit.title.trim());
        if (!readOn.has(key)) readOn.set(key, day);
      }
    } else if (step.name === "fetch") {
      const parsed = fetchStepOutput.safeParse(step.output);
      if (parsed.success) readOn.set(normaliseUrl(parsed.data.url), day);
    } else if (step.name === "knowledge") {
      const article = (step.input as { article?: unknown } | null)?.article;
      if (typeof article === "string") articles.add(article);
    }
  }
  const cited = new Map<string, string>();
  for (const id of MODULE_IDS) {
    if (id === "m19") continue;
    for (const item of moduleItems(pack, id)) for (const url of item.evidence.urls) if (!cited.has(normaliseUrl(url))) cited.set(normaliseUrl(url), url);
    for (const field of moduleUrlFields(pack, id)) if (!cited.has(normaliseUrl(field.url))) cited.set(normaliseUrl(field.url), field.url);
  }
  if (cited.size === 0) return pack;
  const today = context.today ?? new Date().toISOString().slice(0, 10);
  const sources = [...cited.entries()].map(([key, url]) => ({ url, title: titles.get(key) ?? hostOf(url), accessedAt: readOn.get(key) ?? today }));
  const m19 = {
    status: "complete",
    body: `Every source this pack cites (${sources.length}), assembled by the runtime from the modules' claims and url fields and the pages this run read.`,
    claims: [],
    sources,
    knowledgeArticles: [...articles],
    factsVersion: context.factsVersion,
    priorPackIds: context.priorPackIds,
  };
  const missingModules = pack.missingModules.filter((id) => id !== "m19");
  return { ...pack, modules: { ...pack.modules, m19 } as PackShape["modules"], missingModules, partial: missingModules.length > 0 };
}
