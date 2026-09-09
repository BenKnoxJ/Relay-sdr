import { z } from "zod";

/**
 * `ResearchInput` — `research.v2.signed.md` §2.
 *
 * One field's shape is not yet settled anywhere: `facts`. The signed definition
 * says `ProductFacts`, "the signed facts file; the only source of product
 * claims", and the facts file itself is master doc §12 and lands with slice 1 —
 * it is not in this repository. So `productFactsSchema` below is the **minimum**
 * the research and outreach contracts actually use: an id, a status, the claim,
 * and the notes that say what must not be over-claimed. It is marked provisional
 * and `agents/research/rubric.md` records that the real file supersedes it.
 */

export const MOTIONS = ["direct", "channel"] as const;
export const BREADTHS = ["narrow", "standard", "wide"] as const;

/** ISO-3166 alpha-2, upper case. Country names are a screen concern (§10). */
export const regionSchema = z.string().regex(/^[A-Z]{2}$/, "region is an ISO-3166 alpha-2 code");

/** A product claim. `live` is the only status a draft may cite (outreach §5). */
export const factSchema = z
  .object({
    id: z.string().min(1).max(120),
    status: z.enum(["live", "planned", "retired"]),
    text: z.string().min(1).max(1000),
    /** What must not be over-claimed on the back of this fact (outreach §6 rule 3). */
    notes: z.string().max(1000).optional(),
  })
  .strict();

/** **Provisional** — the real `ProductFacts` is master doc §12. See the module note. */
export const productFactsSchema = z
  .object({
    product: z.string().min(1).max(120),
    /** Which `ProductFactsVersion` row this is, so a pack can be read back against it. */
    version: z.number().int().positive(),
    facts: z.array(factSchema).min(1).max(500),
  })
  .strict();

export const researchBriefSchema = z
  .object({
    product: z.string().min(1).max(120),
    motion: z.enum(MOTIONS),
    /** The rep's own words for who they are selling to. Kept verbatim (§2, orchestrator §2). */
    who: z.string().min(1).max(500),
    region: regionSchema,
    howMany: z.number().int().positive().max(500),
    weeks: z.number().int().positive().max(52),
    channels: z.array(z.string().min(1).max(60)).min(1).max(8),
  })
  .strict();

/** Present only on a "widen the brief" re-run (§5, orchestrator §5). */
export const priorRunSchema = z
  .object({
    insufficient: z.boolean(),
    widenedBy: z.enum(["region", "size", "pain"]),
    note: z.string().max(1000),
  })
  .strict();

/**
 * What the runtime names when it re-runs a pack that failed the §7 provenance
 * check: the items that could not be found in the corpus, and why. A runtime
 * field, not one the rep or the orchestrator supplies; approved 2026-09-09 as
 * an amendment note beside §2.
 */
export const provenanceRerunSchema = z
  .object({
    failures: z
      .array(z.object({ id: z.string().min(1).max(120), text: z.string().min(1).max(1000), reason: z.string().min(1).max(300) }).strict())
      .min(1)
      .max(80),
  })
  .strict();

export const researchInputSchema = z
  .object({
    brief: researchBriefSchema,
    facts: productFactsSchema,
    priorRun: priorRunSchema.optional(),
    provenanceRerun: provenanceRerunSchema.optional(),
    /** Set by the runtime from the brief (§6), never chosen by the model. */
    breadth: z.enum(BREADTHS),
  })
  .strict();

export type ResearchInput = z.infer<typeof researchInputSchema>;
export type ProductFacts = z.infer<typeof productFactsSchema>;
