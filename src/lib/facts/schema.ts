import { z } from "zod";

import { productFactsSchema, type ProductFacts } from "../../../agents/research/input.schema";

/**
 * The product facts file — master doc §12, Task 11.
 *
 * One file per product and version, in the repository under `facts/`, and the
 * **only** source of product claims an agent may make. `hook.answeredBy` and a
 * draft's `claims[]` name facts by id; an id that is not `live` in the signed
 * file is refused at ingest (research §3, outreach §5). The file is code: it is
 * reviewed, it is versioned by its filename, and its content hash is pinned in
 * `ProductFactsVersion` so that "version 1" in a pack can be proved to be the
 * same version 1 the pack was written under.
 *
 * ## Two shapes, one source
 *
 * The file's shape is the one the fleet drafted the facts in and the product owner
 * signs: every fact carries its `area`, its `claim`, its `status`, **where it
 * was verified** (`source`) and the guard rails a writer must respect
 * (`notes`). The agents' input schema (`productFactsSchema`, provisional since
 * Task 6) carries only what a model needs: id, status, the claim as `text`, and
 * the notes. `toProductFacts` is the mapping, and it deliberately **drops
 * `source`**: a source is a path on the machine the fact was verified on, which
 * is evidence for a reviewer and noise — or worse, a machine path in a prompt —
 * for a model.
 *
 * ## Draft versus signed
 *
 * `status` on the file says whether the product owner has signed it. A draft is loaded
 * and pinned like a signed one — the build cannot wait for a signature to
 * exist — but it is *named* draft on every run record that cites it, and the
 * research agent's rubric row for facts is not ticked until the file says
 * `signed`. When the signed bytes replace the draft, the hash moves and
 * `ensureFactsVersion` refuses the old pointer, which is the point of the hash.
 */

export const FACT_STATUSES = ["live", "planned", "retired"] as const;
export const FILE_STATUSES = ["draft-awaiting-signature", "signed"] as const;

/** `i360.<area>.<slug>`: product prefix, area, kebab slug. */
export const factIdPattern = /^[a-z0-9]+(\.[a-z0-9-]+){2,}$/;

export const factSourceSchema = z
  .object({
    path: z.string().min(1).max(500),
    section: z.string().min(1).max(500),
    /** ISO date the source was read. */
    lastVerified: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();

export const factFileEntrySchema = z
  .object({
    id: z.string().regex(factIdPattern, "fact ids are dotted kebab slugs, e.g. i360.product.post-call"),
    area: z.string().min(1).max(60),
    claim: z.string().min(1).max(1000),
    status: z.enum(FACT_STATUSES),
    source: factSourceSchema,
    /** What must not be over-claimed on the back of this fact. */
    notes: z.string().max(1000).optional(),
  })
  .strict();

export const factsFileSchema = z
  .object({
    product: z.string().min(1).max(120),
    version: z.number().int().positive(),
    status: z.enum(FILE_STATUSES),
    draftedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    signedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    /** Which commit of the product the facts were read against. Reviewer's evidence. */
    codeBaseline: z
      .object({
        repo: z.string().min(1),
        branch: z.string().min(1),
        commit: z.string().min(7),
        commitDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        note: z.string().max(1000).optional(),
      })
      .strict()
      .optional(),
    facts: z.array(factFileEntrySchema).min(1).max(500),
  })
  .strict()
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    file.facts.forEach((fact, index) => {
      if (seen.has(fact.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["facts", index, "id"], message: `duplicate fact id ${fact.id}` });
      }
      seen.add(fact.id);
    });
    if (file.status === "signed" && file.signedAt === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["signedAt"], message: "a signed file names the day it was signed" });
    }
  });

export type FactsFile = z.infer<typeof factsFileSchema>;
export type FactFileEntry = z.infer<typeof factFileEntrySchema>;

/** The file, as the agents receive it: id, status, the claim as `text`, the notes. No sources. */
export function toProductFacts(file: FactsFile): ProductFacts {
  return productFactsSchema.parse({
    product: file.product,
    version: file.version,
    facts: file.facts.map((fact) => ({
      id: fact.id,
      status: fact.status,
      text: fact.claim,
      ...(fact.notes === undefined ? {} : { notes: fact.notes }),
    })),
  });
}

/** The ids a draft or a hook may cite: `live`, and nothing else. */
export function liveFactIds(facts: Pick<ProductFacts, "facts">): Set<string> {
  return new Set(facts.facts.filter((fact) => fact.status === "live").map((fact) => fact.id));
}
