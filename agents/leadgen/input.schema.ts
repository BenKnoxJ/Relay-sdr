import { z } from "zod";

import { recipeSchema } from "../research/output.schema";

/**
 * What lead gen is given — `leadgen.v2.signed.md` §2.
 *
 * Lead gen makes **no model calls** (§0). This schema exists so that the thing
 * code is handed is the same shape the signed definition describes, and so that
 * the recipe it consumes is literally the one research produces: `recipeSchema`
 * is imported from the research pack rather than restated, because "Lusha
 * vocabulary from the pack" is a contract between two agents and two copies of
 * it would be two contracts.
 */

/** §2: the recipe, plus the exclusions lead gen adds on top of the pack's. */
export const targetingSchema = recipeSchema
  .extend({
    excludeTitles: z.array(z.string().min(1).max(120)).max(60),
  })
  .strict();

/** §2: the hold lists, all org-level and all built by code. */
export const holdsSchema = z
  .object({
    customerDomains: z.array(z.string().min(1).max(253)).max(5000),
    openDealDomains: z.array(z.string().min(1).max(253)).max(5000),
    dncEmails: z.array(z.string().email()).max(5000),
    dncDomains: z.array(z.string().min(1).max(253)).max(5000),
    optedOutEmails: z.array(z.string().email()).max(5000),
    /** Already revealed anywhere in this org, by Lusha id. Re-attaches for zero credits. */
    revealedLushaIds: z.array(z.string().min(1).max(120)).max(20000),
    /** Suppressed by Lusha id, with the reason (§10). Never purged. */
    suppressedLushaIds: z.array(z.string().min(1).max(120)).max(20000),
  })
  .strict();

export const capsSchema = z
  .object({
    orgCreditsRemaining: z.number().int().nonnegative(),
    /** §2: three per company. */
    perCompanyMax: z.number().int().positive(),
    /** §2: three pages, then the rep presses "look further". */
    maxPages: z.number().int().positive(),
  })
  .strict();

export const seedFirmRefSchema = z
  .object({
    name: z.string().min(1).max(200),
    domain: z.string().min(1).max(253).optional(),
  })
  .strict();

export const leadgenInputSchema = z
  .object({
    recipe: targetingSchema,
    /** §2: 10, 20, 30 or 50. Not any integer — the estimate and the page maths assume these. */
    howMany: z.union([z.literal(10), z.literal(20), z.literal(30), z.literal(50)]),
    seedFirms: z.array(seedFirmRefSchema).max(20),
    holds: holdsSchema,
    caps: capsSchema,
  })
  .strict();

export type LeadgenInput = z.infer<typeof leadgenInputSchema>;
