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
    /**
     * The one question campaign start asks beyond the signed seven: "Do you
     * already have customers like this? Who, and what did they buy it for?"
     * Optional, the rep's words, a hypothesis for the research and never a
     * claim. Amendment note on §2, product owner 2026-09-09; definition untouched.
     */
    existingCustomers: z.string().min(1).max(1000).optional(),
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
 * What the runtime names when it re-asks the modules that failed the §7
 * provenance check (v3: per module, never the run): the modules, and the items
 * in them that could not be found in the corpus, and why. A runtime field,
 * not one the rep or the orchestrator supplies.
 */
export const provenanceRerunSchema = z
  .object({
    modules: z.array(z.string().min(1).max(20)).min(1).max(30),
    failures: z
      .array(
        z
          .object({ module: z.string().min(1).max(20), id: z.string().min(1).max(120), text: z.string().min(1).max(1000), reason: z.string().min(1).max(300) })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();

/** `ResearchInput` — v3 §2. The facts and knowledge reach the model through its tools; the input names their versions. */
export const researchInputSchema = z
  .object({
    brief: researchBriefSchema,
    /** The signed facts file the run may claim from. */
    factsVersion: z.number().int().positive(),
    /** The product knowledge set the run may read. */
    knowledgeVersion: z.number().int().positive(),
    /** This org's earlier packs for the same product, by id, read-only. */
    priorPackIds: z.array(z.string().min(1).max(80)).max(20),
    priorRun: priorRunSchema.optional(),
    provenanceRerun: provenanceRerunSchema.optional(),
    /**
     * Bench only (plan step 5, `research-bench --modules`): the run writes the
     * steering note and these modules and nothing else, so one module can be
     * tried live for cents. Set by the runtime from the bench's deps; a job
     * never sets it. A runtime field beside `provenanceRerun`, pending an
     * amendment note on §2.
     */
    onlyModules: z.array(z.string().min(1).max(20)).min(1).max(22).optional(),
  })
  .strict();

export type ResearchInput = z.infer<typeof researchInputSchema>;
export type ProductFacts = z.infer<typeof productFactsSchema>;
