import { z } from "zod";

import { assertPlainWords } from "@/lib/copy/plainWords";

import {
  factIdSchema,
  hostOf,
  idSchema,
  itemSchema,
  phraseSchema,
  staleAndOverClaimed,
  urlSchema,
  type Item,
} from "../_shared/item.schema";

/**
 * `ResearchPack` — `research.v2.signed.md` §3, with that section's five schema
 * rules as refinements rather than as advice.
 *
 * The derived-confidence rule lives on `Item` itself (`agents/_shared`), because
 * outreach's lookup items carry it too. The rules that are properties of the
 * *pack* are here: the domain cap, the non-empty unknowns, the recency
 * demotion, the live-fact reference and the plain-words check.
 */

/** Research v2 §3: "At most 3 sources per domain across the pack". */
export const DOMAIN_CAP = 3;

export const archetypeSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1).max(120),
    /** A situation — sector, size, circumstance — never a job title (§5 wave 1). */
    situation: z.string().min(1).max(600),
    pains: z.array(itemSchema).min(3).max(8),
    language: z.array(phraseSchema).max(20),
  })
  .strict();

export const hookSchema = z
  .object({
    id: idSchema,
    text: z.string().min(1).max(400),
    whyNow: itemSchema,
    /** Must reference `live` facts only. Liveness is checked against the facts file at ingest. */
    answeredBy: z.array(factIdSchema).min(1).max(8),
  })
  .strict();

export const firmSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1).max(200),
    domain: z.string().min(1).max(253).optional(),
    region: z.string().min(1).max(80),
    signal: itemSchema,
  })
  .strict();

/** Lusha's vocabulary, handed to lead gen as-is (§3, leadgen §2). */
export const recipeSchema = z
  .object({
    titles: z.array(z.string().min(1).max(120)).min(1).max(40),
    sizeBand: z
      .object({ min: z.number().int().nonnegative(), max: z.number().int().positive() })
      .strict()
      .refine((band) => band.min < band.max, "sizeBand.min must be below sizeBand.max"),
    countries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(20),
    industries: z.array(z.string().min(1).max(120)).min(1).max(30),
    triggers: z.array(z.string().min(1).max(160)).max(30),
  })
  .strict();

export const unknownSchema = z
  .object({
    id: idSchema,
    text: z.string().min(1).max(600),
    kind: z.enum(["not-found", "confirmed-absent", "unreadable"]),
    /** What was tried. An unknown with no queries is an unknown nobody looked for. */
    queriesTried: z.array(z.string().min(1).max(300)).min(1).max(30),
  })
  .strict();

export const contradictionSchema = z
  .object({
    id: idSchema,
    text: z.string().min(1).max(600),
    a: itemSchema,
    b: itemSchema,
  })
  .strict();

export const wideningSchema = z
  .object({
    kind: z.enum(["region", "size", "pain"]),
    text: z.string().min(1).max(400),
  })
  .strict();

/** The stop-rule result (§5 rule 7): what was found, and exactly three widenings. */
export const insufficientSchema = z
  .object({
    found: z.array(itemSchema).max(40),
    widenings: z.tuple([wideningSchema, wideningSchema, wideningSchema]),
  })
  .strict();

const packShape = z
  .object({
    summary: z.tuple([z.string().min(1).max(400), z.string().min(1).max(400), z.string().min(1).max(400)]),
    archetypes: z.array(archetypeSchema).min(2).max(4),
    hook: hookSchema,
    seedFirms: z.array(firmSchema).min(4).max(10),
    recipe: recipeSchema,
    /** Never empty (§3): a pack with no unknowns is a pack that did not look. */
    unknowns: z.array(unknownSchema).min(1).max(60),
    /** Sources disagreeing is a finding, not noise to drop (§5 rule 4). */
    contradictions: z.array(contradictionSchema).max(20),
    insufficient: insufficientSchema.optional(),
  })
  .strict();

/**
 * Every `Item` in a pack, wherever it sits.
 *
 * Written out rather than walked generically: a generic walk would silently stop
 * covering a field added later, and the domain cap is a claim about *all* of
 * them.
 */
export function packItems(pack: z.infer<typeof packShape>): Item[] {
  const items: Item[] = [];
  for (const archetype of pack.archetypes) {
    items.push(...archetype.pains, ...archetype.language);
  }
  items.push(pack.hook.whyNow);
  for (const firm of pack.seedFirms) items.push(firm.signal);
  for (const contradiction of pack.contradictions) items.push(contradiction.a, contradiction.b);
  if (pack.insufficient !== undefined) items.push(...pack.insufficient.found);
  return items;
}

/** How many of the pack's citations sit on each domain. */
export function domainCounts(pack: z.infer<typeof packShape>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of packItems(pack)) {
    for (const url of new Set(item.evidence.urls)) {
      const host = hostOf(url);
      counts.set(host, (counts.get(host) ?? 0) + 1);
    }
  }
  return counts;
}

export const researchOutputSchema = packShape.superRefine((pack, ctx) => {
  // §3: the domain cap is a validation error, not advice.
  for (const [host, count] of domainCounts(pack)) {
    if (count > DOMAIN_CAP) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${count} sources cite ${host}; the cap is ${DOMAIN_CAP} per domain across the pack`,
      });
    }
  }

  // §3: "`whyNow` and every seed-firm `signal` with `publishedAt` older than 12
  // months drop to `weak` automatically." The demotion is `demoteStale`, applied
  // by the ingest before validation so that the edit is visible; what is left
  // here is the check that it happened.
  const now = new Date();
  if (staleAndOverClaimed(pack.hook.whyNow, now)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["hook", "whyNow", "confidence"],
      message: "a whyNow older than 12 months cannot be stronger than weak; call demoteStale before validating",
    });
  }
  pack.seedFirms.forEach((firm, index) => {
    if (staleAndOverClaimed(firm.signal, now)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["seedFirms", index, "signal", "confidence"],
        message: "a seed-firm signal older than 12 months cannot be stronger than weak; call demoteStale before validating",
      });
    }
  });

  // §3: ids are stable slugs and must not collide — every cross-reference in the
  // pack is by id, so two items sharing one makes the reference ambiguous.
  const seen = new Set<string>();
  for (const id of [
    ...pack.archetypes.map((archetype) => archetype.id),
    ...packItems(pack).map((item) => item.id),
    ...pack.unknowns.map((unknown) => unknown.id),
    ...pack.seedFirms.map((firm) => firm.id),
    pack.hook.id,
  ]) {
    if (seen.has(id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate id ${JSON.stringify(id)}` });
    }
    seen.add(id);
  }

  // §3: `assertPlainWords`, on the strings the pack *writes* (see `authoredText`).
  try {
    assertPlainWords(authoredText(pack));
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : "the pack uses words a rep would not",
    });
  }
});

/**
 * The strings the pack itself wrote, as opposed to the ones it quoted.
 *
 * Research v2 §3 says "`assertPlainWords` on every string". Taken literally that
 * is the one use `src/lib/copy/plainWords.ts` documents as wrong: its banned list
 * is ordinary English and thirteen first names, and its own comment says to apply
 * it to "the copy it chose" and "leave the person's own words alone". A pack is
 * full of other people's words — a buyer quote mentioning a pipeline, a firm
 * called Vector Capital, a url with `/signal/` in the path, and the Lusha
 * vocabulary in `recipe`, which is a vendor's facet names and not prose at all.
 * Checking those would reject true research for using English.
 *
 * So the check covers what the agent authored and what the plan cards render as
 * Relay's own voice, and skips quotes, names, urls, dates, ids and the recipe.
 * That is the rule §22.4 principle 4 is actually about — "Relay never puts its
 * own machinery on a rep's screen" — and the literal reading is recorded in
 * `rubric.md` as the thing this departs from.
 */
export function authoredText(pack: z.infer<typeof packShape>): string[] {
  const out: string[] = [...pack.summary, pack.hook.text];
  for (const archetype of pack.archetypes) {
    out.push(archetype.name, archetype.situation);
    for (const pain of archetype.pains) out.push(pain.text);
    for (const phrase of archetype.language) {
      out.push(phrase.text, phrase.say);
      if (phrase.notThis !== undefined) out.push(phrase.notThis);
    }
  }
  out.push(pack.hook.whyNow.text);
  for (const firm of pack.seedFirms) out.push(firm.signal.text);
  for (const unknown of pack.unknowns) out.push(unknown.text);
  for (const contradiction of pack.contradictions) out.push(contradiction.text);
  if (pack.insufficient !== undefined) {
    for (const widening of pack.insufficient.widenings) out.push(widening.text);
    for (const found of pack.insufficient.found) out.push(found.text);
  }
  return out;
}

export type ResearchPack = z.infer<typeof researchOutputSchema>;

/**
 * The pack's parts, by name.
 *
 * Exported because the plan cards render them, and a component that declared
 * its own shape of an archetype would be a second contract that drifts from
 * this one silently. `src/components/ItemLine.tsx` and its siblings take these
 * types and nothing else; `tests/bench/schemaIdentity.test.ts` holds them to it.
 */
export type Archetype = z.infer<typeof archetypeSchema>;
export type Hook = z.infer<typeof hookSchema>;
export type SeedFirm = z.infer<typeof firmSchema>;
export type Recipe = z.infer<typeof recipeSchema>;
export type PackUnknown = z.infer<typeof unknownSchema>;

export { urlSchema, itemSchema, phraseSchema };
export type { Item, Phrase, Confidence } from "../_shared/item.schema";
