import { z } from "zod";

import { assertPlainWords } from "@/lib/copy/plainWords";

import { hostOf, itemSchema, staleAndOverClaimed, type Item } from "../../_shared/item.schema";
import {
  MODULE_IDS,
  type CompleteModule,
  type Module,
  type ModuleId,
  insufficientModuleSchema,
  COMPLETE_MODULE_SCHEMAS,
} from "./modules";

/**
 * `ResearchPack` — `research.v3.signed.md` §3: the twenty modules assembled,
 * with the rules that are properties of the *pack* rather than of one module.
 *
 * Module floors live in `modules.ts` and are checked as each module is written
 * (`writeModule`). What is checked here is what only the assembled pack can
 * show: every archetype covered by every per-archetype module, every pain
 * mapped or listed unmatched, the hard filters echoed, the buyer-words ratio,
 * the per-module domain cap with its primary-source carve-out, ids unique,
 * the stale check on the four dated kinds, and plain words on the one string
 * a rep reads. Rules that need the run's input (contact rules per channel,
 * changes when a prior pack exists, live fact ids) are in
 * `src/lib/research/validate.ts`.
 */

/** Research v3 §3: three pages per domain per module, primary sources exempt. */
export const DOMAIN_CAP = 3;
/** Research v3 §3 m06: six in ten phrases from a named buyer. */
export const BUYER_WORDS_MIN = 0.6;

export const wideningSchema = z.object({ kind: z.enum(["region", "size", "pain"]), text: z.string().min(1).max(400) }).strict();

/** The stop-rule result (§5 rule 7): what was found, and exactly three widenings. */
export const insufficientSchema = z
  .object({
    found: z.array(itemSchema).max(40),
    widenings: z.tuple([wideningSchema, wideningSchema, wideningSchema]),
  })
  .strict();

const modulesShape = Object.fromEntries(
  MODULE_IDS.map((id) => [id, z.union([COMPLETE_MODULE_SCHEMAS[id], insufficientModuleSchema]).optional()]),
) as { [M in ModuleId]: z.ZodOptional<z.ZodUnion<[(typeof COMPLETE_MODULE_SCHEMAS)[M], typeof insufficientModuleSchema]>> };

const packShape = z
  .object({
    modules: z.object(modulesShape).strict(),
    insufficient: insufficientSchema.optional(),
    /** True when a rail ended the run before every module was written (§6). */
    partial: z.boolean(),
    missingModules: z.array(z.enum(MODULE_IDS)),
  })
  .strict();

export type PackShape = z.infer<typeof packShape>;

/** The module, when it was written and is complete. */
export function completeModule<M extends ModuleId>(pack: PackShape, id: M): CompleteModule<M> | undefined {
  // Indexed through a loose record: indexing the twenty-two-way union by a
  // generic key is more than the checker will represent (TS2590).
  const module = (pack.modules as Record<ModuleId, Module<ModuleId> | undefined>)[id] as Module<M> | undefined;
  return module !== undefined && module.status === "complete" ? (module as CompleteModule<M>) : undefined;
}

/**
 * Every `Item` or `Phrase` in one module, wherever it sits (§3: "every Item
 * anywhere in a module is a claim for §7").
 *
 * Written out per module rather than walked generically, so a field added
 * later shows up here as a missing line rather than as a silently unchecked one.
 */
export function moduleItems(pack: PackShape, id: ModuleId): Item[] {
  const module = (pack.modules as Record<ModuleId, Module<ModuleId> | undefined>)[id];
  if (module === undefined) return [];
  const items: Item[] = [...module.claims];
  if (module.status !== "complete") return items;
  switch (id) {
    case "m01":
      items.push(...(module as CompleteModule<"m01">).triggers);
      break;
    case "m02":
      for (const c of (module as CompleteModule<"m02">).competitors) items.push(...c.recentMoves);
      break;
    case "m03":
      for (const a of (module as CompleteModule<"m03">).archetypes) items.push(a.dominantPain);
      break;
    case "m04":
      for (const t of (module as CompleteModule<"m04">).perArchetype) for (const f of t.seedFirms) items.push(f.signal);
      break;
    case "m05":
      for (const p of (module as CompleteModule<"m05">).perArchetype) items.push(...p.pains);
      break;
    case "m06":
      for (const p of (module as CompleteModule<"m06">).perArchetype) items.push(...p.phrases);
      break;
    case "m09":
      for (const p of (module as CompleteModule<"m09">).perArchetype) items.push(...p.verbatim);
      break;
    case "m17":
      for (const c of (module as CompleteModule<"m17">).entries) {
        if (c.a !== undefined) items.push(c.a);
        if (c.b !== undefined) items.push(c.b);
      }
      break;
    default:
      break;
  }
  return items;
}

/** Every `Item` in the pack. */
export function packItems(pack: PackShape): Item[] {
  const items: Item[] = [];
  for (const id of MODULE_IDS) items.push(...moduleItems(pack, id));
  if (pack.insufficient !== undefined) items.push(...pack.insufficient.found);
  return items;
}

/** Hosts that are primary sources for the pack: the bodies m01 names, and any page cited as primary. */
export function primaryHosts(pack: PackShape): Set<string> {
  const hosts = new Set<string>();
  const m01 = completeModule(pack, "m01");
  if (m01 !== undefined) for (const body of m01.bodies) if (body.url !== undefined) hosts.add(hostOf(body.url));
  return hosts;
}

/**
 * Pages per domain in one module, less the primary-source carve-out (§3).
 *
 * A source is a page, not a citation: three regulator pages cited by twenty
 * claims are three pages. A page cited with `evidence.primary: true`, or on a
 * host m01 lists as a regulatory or governance body, does not count towards
 * the cap.
 */
export function domainCounts(pack: PackShape, id: ModuleId): Map<string, number> {
  const exempt = primaryHosts(pack);
  const primaryUrls = new Set<string>();
  const urls = new Set<string>();
  for (const item of moduleItems(pack, id)) {
    for (const url of item.evidence.urls) {
      urls.add(url);
      if (item.evidence.primary) primaryUrls.add(url);
    }
  }
  const counts = new Map<string, number>();
  for (const url of urls) {
    const host = hostOf(url);
    if (exempt.has(host) || primaryUrls.has(url)) continue;
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  return counts;
}

/** The one string a rep reads as Relay's own voice: the five-line summary. */
export function authoredText(pack: PackShape): string[] {
  const rep = completeModule(pack, "repSummary");
  return rep === undefined ? [] : [...rep.lines];
}

/** The archetype ids the pack is organised by, from m03. */
export function archetypeIds(pack: PackShape): string[] {
  const m03 = completeModule(pack, "m03");
  return m03 === undefined ? [] : m03.archetypes.map((a) => a.id);
}

function refinePack(pack: PackShape, ctx: z.RefinementCtx, options: { staleCheck: boolean }): void {
  const issue = (message: string, path: (string | number)[] = []): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
  };

  // §6: every module present unless the run was cut short, and then listed.
  const missing = new Set<string>(pack.missingModules);
  for (const id of MODULE_IDS) {
    const present = (pack.modules as Record<ModuleId, unknown>)[id] !== undefined;
    if (!present && !missing.has(id)) issue(`module ${id} is missing and not listed in missingModules`, ["modules", id]);
    if (present && missing.has(id)) issue(`module ${id} is present but listed as missing`, ["missingModules"]);
  }
  if (pack.partial !== pack.missingModules.length > 0) issue("partial is true exactly when modules are missing", ["partial"]);

  // Cross-references by archetype id.
  const ids = archetypeIds(pack);
  const idSet = new Set(ids);
  const perArchetype: Array<[ModuleId, string[]]> = [];
  const m04 = completeModule(pack, "m04");
  const m05 = completeModule(pack, "m05");
  const m06 = completeModule(pack, "m06");
  const m09 = completeModule(pack, "m09");
  const m11 = completeModule(pack, "m11");
  if (m04) perArchetype.push(["m04", m04.perArchetype.map((p) => p.archetypeId)]);
  if (m05) perArchetype.push(["m05", m05.perArchetype.map((p) => p.archetypeId)]);
  if (m06) perArchetype.push(["m06", m06.perArchetype.map((p) => p.archetypeId)]);
  if (m09) perArchetype.push(["m09", m09.perArchetype.map((p) => p.archetypeId)]);
  if (m11) perArchetype.push(["m11", m11.perArchetype.map((p) => p.archetypeId)]);
  if (ids.length > 0) {
    for (const [id, covered] of perArchetype) {
      for (const a of covered) if (!idSet.has(a)) issue(`${id} names archetype ${JSON.stringify(a)} which m03 does not define`, ["modules", id]);
      for (const a of ids) if (!covered.includes(a)) issue(`${id} does not cover archetype ${JSON.stringify(a)}`, ["modules", id]);
    }
  }

  // m07 covers every m05 pain.
  const m07 = completeModule(pack, "m07");
  if (m05 && m07) {
    const covered = new Set([...m07.mappings.map((m) => m.painId), ...m07.unmatched.map((u) => u.painId)]);
    for (const p of m05.perArchetype) for (const pain of p.pains) {
      if (!covered.has(pain.id)) issue(`m07 neither maps nor lists as unmatched the pain ${JSON.stringify(pain.id)}`, ["modules", "m07"]);
    }
  }

  // m08 echoes m00's hard filters verbatim.
  const m00 = completeModule(pack, "m00");
  const m08 = completeModule(pack, "m08");
  if (m00 && m08 && JSON.stringify(m00.hardFilters) !== JSON.stringify(m08.hardFiltersEchoed)) {
    issue("m08 must echo m00's hard filters verbatim", ["modules", "m08", "hardFiltersEchoed"]);
  }

  // m06: six in ten phrases from a named buyer, across the pack.
  if (m06 && pack.insufficient === undefined) {
    const phrases = m06.perArchetype.flatMap((p) => p.phrases);
    const buyer = phrases.filter((p) => !p.notBuyer && p.role !== undefined).length;
    if (phrases.length > 0 && buyer / phrases.length < BUYER_WORDS_MIN) {
      issue(`${Math.round((100 * buyer) / phrases.length)}% of phrases are buyer words with a role; the floor is ${BUYER_WORDS_MIN * 100}%`, ["modules", "m06"]);
    }
  }

  // m04: seed firms per archetype from at least two sources.
  if (m04) {
    m04.perArchetype.forEach((t, i) => {
      const hosts = new Set(t.seedFirms.flatMap((f) => f.signal.evidence.urls.map(hostOf)));
      if (t.seedFirms.length >= 2 && hosts.size < 2) issue(`seed firms for ${t.archetypeId} all come from one source`, ["modules", "m04", "perArchetype", i]);
    });
  }

  // m16: candidates name real archetypes and seed firms; one per archetype with ≥3 pains.
  const m16 = completeModule(pack, "m16");
  if (m16) {
    const firmIds = new Set(m04?.perArchetype.flatMap((t) => t.seedFirms.map((f) => f.id)) ?? []);
    for (const c of m16.candidates) {
      if (ids.length > 0 && !idSet.has(c.archetypeId)) issue(`candidate ${c.id} names an unknown archetype`, ["modules", "m16"]);
      for (const f of c.seedFirmIds) if (m04 && !firmIds.has(f)) issue(`candidate ${c.id} names an unknown seed firm ${f}`, ["modules", "m16"]);
    }
    if (m05 && pack.insufficient === undefined) {
      for (const p of m05.perArchetype) {
        if (p.pains.length >= 3 && !m16.candidates.some((c) => c.archetypeId === p.archetypeId)) {
          issue(`no campaign candidate for archetype ${p.archetypeId}, which has ${p.pains.length} pains`, ["modules", "m16"]);
        }
      }
    }
  }

  // §3: the per-module domain cap, primary sources exempt.
  for (const id of MODULE_IDS) {
    for (const [host, count] of domainCounts(pack, id)) {
      if (count > DOMAIN_CAP) issue(`${count} pages from ${host} in ${id}; the cap is ${DOMAIN_CAP} per domain per module (primary sources exempt)`, ["modules", id]);
    }
  }

  // §3: the twelve-month demotion, on the four dated kinds.
  if (options.staleCheck) {
    const now = new Date();
    const m01 = completeModule(pack, "m01");
    const m02 = completeModule(pack, "m02");
    const dated: Array<[string, Item]> = [];
    if (m01) m01.triggers.forEach((t, i) => dated.push([`m01.triggers.${i}`, t]));
    if (m02) m02.competitors.forEach((c, i) => c.recentMoves.forEach((m, j) => dated.push([`m02.competitors.${i}.recentMoves.${j}`, m])));
    if (m04) m04.perArchetype.forEach((t, i) => t.seedFirms.forEach((f, j) => dated.push([`m04.perArchetype.${i}.seedFirms.${j}.signal`, f.signal])));
    for (const [where, item] of dated) {
      if (staleAndOverClaimed(item, now)) issue(`${where} is older than twelve months and cannot be stronger than weak; call demoteStale before validating`, ["modules"]);
    }
  }

  // Ids unique across the pack.
  const seen = new Set<string>();
  const all: string[] = [
    ...ids,
    ...packItems(pack).map((i) => i.id),
    ...(m04?.perArchetype.flatMap((t) => t.seedFirms.map((f) => f.id)) ?? []),
    ...(completeModule(pack, "m18")?.unknowns.map((u) => u.id) ?? []),
    ...(completeModule(pack, "m17")?.entries.map((c) => c.id) ?? []),
    ...(m16?.candidates.map((c) => c.id) ?? []),
  ];
  for (const id of all) {
    if (seen.has(id)) issue(`duplicate id ${JSON.stringify(id)}`);
    seen.add(id);
  }

  // §3: rep words on the one string a rep reads.
  try {
    assertPlainWords(authoredText(pack));
  } catch (error) {
    issue(error instanceof Error ? error.message : "the rep summary uses words a rep would not", ["modules", "repSummary"]);
  }
}

/** Every pack rule. What a pack must satisfy at ingest, after `demoteStale`. */
export const researchOutputSchema = packShape.superRefine((pack, ctx) => refinePack(pack, ctx, { staleCheck: true }));

/** Every pack rule but the stale check: what the assembler parses before demotion. */
export const researchRawSchema = packShape.superRefine((pack, ctx) => refinePack(pack, ctx, { staleCheck: false }));

export type ResearchPack = z.infer<typeof researchOutputSchema>;

/**
 * What the loop's final structured output is (§3, §5 step 5): the modules are
 * written through `writeModule` as the run goes, so the answer at the end is
 * only a manifest of what was written and a closing note. The pack itself is
 * assembled by the runtime from the accepted modules.
 */
export const researchRunOutputSchema = z
  .object({
    modulesWritten: z.array(z.enum(MODULE_IDS)),
    /** Set when the agent stopped under §5 rule 7; the widenings are the module writer's `insufficient` payload. */
    insufficient: insufficientSchema.optional(),
    note: z.string().max(2000).optional(),
  })
  .strict();
export type ResearchRunOutput = z.infer<typeof researchRunOutputSchema>;
