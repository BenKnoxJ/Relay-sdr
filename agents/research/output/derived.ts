import { z } from "zod";

import { factIdSchema, idSchema, itemSchema, phraseSchema, type Item, type Phrase } from "../../_shared/item.schema";
import { archetypeIds, completeModule, insufficientSchema, type PackShape } from "./pack";
import { recipeSchema } from "./modules";

/**
 * Derived views of the pack — `research.v3.signed.md` §3 "Derived views".
 *
 * The pack is the contract. These shapes are read *from* it, never written by
 * the agent: the plan cards a rep sees, the recipe lead gen searches with, and
 * the archetype and hook outreach opens on. They are the v2 pack's shapes,
 * kept so Lane B's components and the signed leadgen and outreach definitions
 * need no change when the pack behind them grew.
 */

/** A kind of buyer as the cards and outreach see it (v2 §3 `Archetype`). */
export const planArchetypeSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1).max(500),
    situation: z.string().min(1).max(8000),
    pains: z.array(itemSchema).min(1).max(12),
    language: z.array(phraseSchema).max(20),
  })
  .strict();

/** The hook outreach opens on (v2 §3 `hook`), derived per chosen archetype. */
export const hookSchema = z
  .object({
    id: idSchema,
    text: z.string().min(1).max(8000),
    whyNow: itemSchema,
    answeredBy: z.array(factIdSchema).max(8),
  })
  .strict();

export const planFirmSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1).max(500),
    domain: z.string().min(1).max(253).optional(),
    region: z.string().min(1).max(80),
    signal: itemSchema,
  })
  .strict();

export const planUnknownSchema = z
  .object({
    id: idSchema,
    text: z.string().min(1).max(8000),
    kind: z.enum(["not-found", "confirmed-absent", "unreadable", "conflicting", "out-of-budget"]),
    queriesTried: z.array(z.string().min(1).max(300)),
  })
  .strict();

export const planContradictionSchema = z
  .object({ id: idSchema, text: z.string().min(1).max(8000), a: itemSchema.optional(), b: itemSchema.optional() })
  .strict();

/** What the campaign page's cards render (§23.1c): the v2 pack shape, as a view. */
export const planCardsSchema = z
  .object({
    summary: z.array(z.string().min(1).max(8000)).min(1).max(5),
    archetypes: z.array(planArchetypeSchema),
    hook: hookSchema.optional(),
    seedFirms: z.array(planFirmSchema),
    recipe: recipeSchema.optional(),
    unknowns: z.array(planUnknownSchema),
    contradictions: z.array(planContradictionSchema),
    insufficient: insufficientSchema.optional(),
    /** True when a rail cut the run short; the card lists what is missing. */
    partial: z.boolean(),
    missingModules: z.array(z.string()),
    /** Which kind of buyer the hook and recipe are for. */
    chosenArchetypeId: z.string().optional(),
  })
  .strict();
export type PlanCards = z.infer<typeof planCardsSchema>;

/**
 * The archetype the slice-1 hook and recipe are derived for: the top-ranked
 * campaign candidate, unless the caller (the card, later the campaign agent)
 * says otherwise. Decision on signature, 2026-09-09.
 */
export function chosenArchetypeId(pack: PackShape, chosen?: string): string | undefined {
  const ids = archetypeIds(pack);
  if (chosen !== undefined && ids.includes(chosen)) return chosen;
  const m16 = completeModule(pack, "m16");
  const top = m16?.candidates.slice().sort((a, b) => a.rank - b.rank).find((c) => ids.includes(c.archetypeId));
  return top?.archetypeId ?? ids[0];
}

/** One kind of buyer with its pains and words, from m03, m05 and m06. */
export function deriveArchetype(pack: PackShape, archetypeId: string): z.infer<typeof planArchetypeSchema> | undefined {
  const m03 = completeModule(pack, "m03");
  const persona = m03?.archetypes.find((a) => a.id === archetypeId);
  if (persona === undefined) return undefined;
  const pains: Item[] = completeModule(pack, "m05")?.perArchetype.find((p) => p.archetypeId === archetypeId)?.pains ?? [persona.dominantPain];
  // The cards keep the shared `Phrase` shape; m06's `voice` is the pack's own field.
  const language: Phrase[] = (completeModule(pack, "m06")?.perArchetype.find((p) => p.archetypeId === archetypeId)?.phrases ?? []).map(
    (phrase) => Object.fromEntries(Object.entries(phrase).filter(([key]) => key !== "voice")) as Phrase,
  );
  return { id: persona.id, name: persona.name, situation: persona.situation, pains: pains.slice(0, 12), language: language.slice(0, 20) };
}

/**
 * The hook for one archetype: its m03 opening angle, its strongest dated
 * trigger from m01 (m13 entries are dated facts without confidence, so m01's
 * triggers are what can stand as `whyNow`), and the live fact ids m07 maps to
 * its dominant pain.
 */
export function deriveHook(pack: PackShape, archetypeId: string): z.infer<typeof hookSchema> | undefined {
  const m03 = completeModule(pack, "m03");
  const persona = m03?.archetypes.find((a) => a.id === archetypeId);
  const m01 = completeModule(pack, "m01");
  if (persona === undefined || m01 === undefined) return undefined;
  const rank = { strong: 0, moderate: 1, weak: 2, speculative: 3 } as const;
  const whyNow = m01.triggers.slice().sort((a, b) => rank[a.confidence] - rank[b.confidence])[0];
  if (whyNow === undefined) return undefined;
  const m07 = completeModule(pack, "m07");
  const answeredBy = m07?.mappings.filter((m) => m.painId === persona.dominantPain.id).flatMap((m) => m.factIds) ?? [];
  return { id: `hook-${persona.id}`, text: persona.openingAngle, whyNow, answeredBy: [...new Set(answeredBy)].slice(0, 8) };
}

/** Lead gen's recipe for one archetype (leadgen v2 §2), straight from m04. */
export function leadgenRecipe(pack: PackShape, archetypeId: string): z.infer<typeof recipeSchema> | undefined {
  return completeModule(pack, "m04")?.perArchetype.find((t) => t.archetypeId === archetypeId)?.recipe;
}

/** The cards, from the pack. */
export function planCards(pack: PackShape, options: { chosen?: string } = {}): PlanCards {
  const chosen = chosenArchetypeId(pack, options.chosen);
  const rep = completeModule(pack, "repSummary");
  const archetypes = archetypeIds(pack)
    .map((id) => deriveArchetype(pack, id))
    .filter((a): a is z.infer<typeof planArchetypeSchema> => a !== undefined);
  const seedFirms = (completeModule(pack, "m04")?.perArchetype ?? []).flatMap((t) =>
    t.seedFirms.map((f) => ({ id: f.id, name: f.name, ...(f.domain === undefined ? {} : { domain: f.domain }), region: f.region, signal: f.signal })),
  );
  const unknowns = (completeModule(pack, "m18")?.unknowns ?? []).map((u) => ({ id: u.id, text: u.text, kind: u.kind, queriesTried: u.queriesTried }));
  const contradictions = (completeModule(pack, "m17")?.entries ?? []).map((c) => ({
    id: c.id,
    text: c.text,
    ...(c.a === undefined ? {} : { a: c.a }),
    ...(c.b === undefined ? {} : { b: c.b }),
  }));
  const hook = chosen === undefined ? undefined : deriveHook(pack, chosen);
  const recipe = chosen === undefined ? undefined : leadgenRecipe(pack, chosen);
  return {
    summary: rep === undefined ? ["The research is not finished."] : [...rep.lines],
    archetypes,
    ...(hook === undefined ? {} : { hook }),
    seedFirms,
    ...(recipe === undefined ? {} : { recipe }),
    unknowns,
    contradictions,
    ...(pack.insufficient === undefined ? {} : { insufficient: pack.insufficient }),
    partial: pack.partial,
    missingModules: [...pack.missingModules],
    ...(chosen === undefined ? {} : { chosenArchetypeId: chosen }),
  };
}
