import { z } from "zod";

/**
 * What lead gen is given: `LeadGenHandoffV1`, leadgen v2.1 §3 (which replaces
 * v2 §2).
 *
 * Confirm freezes this into the `campaign.confirmed` Event, and it is lead
 * gen's only input. It is lead gen's own contract, declared here rather than
 * imported from the research pack: lead gen never reads Research's module
 * names or schemas (v2.1 §3, rubric row 14, and the `no-restricted-imports`
 * block for `agents/leadgen/**` in `eslint.config.mjs`). The campaign boundary
 * (`src/lib/campaigns/leadgenHandoff.ts`) is the one place that reads a pack
 * and writes one of these.
 *
 * Holds are not in the handoff. They are read when lead gen runs (v2.1 §7,
 * §9), because a suppression written after Confirm must still count.
 */

/** Research's labels are at most 500 characters, so the handoff takes them whole. */
const label = z.string().min(1).max(500);
const iso2 = z.string().regex(/^[A-Z]{2}$/, "a country is an ISO-3166 alpha-2 code, e.g. GB");
const id = z.string().min(1).max(200);
const domain = z.string().min(1).max(253);

/** How many a rep may ask for (Start's picker). The page and cap maths assume these. */
export const HOW_MANY = [10, 20, 30, 50] as const;

/** v2.1 §3 `targeting`: Research's signed lead-gen recipe for the confirmed group, copied verbatim. */
export const targetingSchema = z
  .object({
    titles: z.array(label).min(1).max(40),
    excludeTitles: z.array(label).max(60),
    sizeBand: z
      .object({ min: z.number().int().nonnegative(), max: z.number().int().positive() })
      .strict()
      .refine((band) => band.min < band.max, "sizeBand.min must be below sizeBand.max"),
    countries: z.array(iso2).min(1).max(20),
    /** May be empty; never dropped (v2 note 1). */
    locations: z.array(label).max(20),
    industries: z.array(label).min(1).max(30),
    /** Context only (v2.1 §5): never a provider filter, never a halt. */
    triggers: z.array(label).max(30),
  })
  .strict();

export const leadGenHandoffV1Schema = z
  .object({
    version: z.literal(1),
    campaign: z
      .object({
        id,
        orgId: id,
        ownerUserId: id,
        briefVersion: z.number().int().positive(),
        confirmRequestId: id,
      })
      .strict(),
    provenance: z
      .object({
        researchJobId: id,
        /** The `research.completed` Event: append-only, so it is the pack's identity. */
        researchEventId: id,
        outcome: z.enum(["complete", "partial"]),
      })
      .strict(),
    /**
     * The group confirmed for this run. Lead gen uses it and nothing else.
     * `sourceRank` records where the group stood in Research's ranking at
     * Confirm: provenance only, never read to decide anything (v2.1 §3).
     */
    buyerGroup: z.object({ id, name: label, sourceRank: z.number().int().positive() }).strict(),
    targeting: targetingSchema,
    /** `brief.scope.places`, for location aliases. */
    places: z.array(z.object({ name: label, aliases: z.array(label).max(10) }).strict()).max(20),
    exclusions: z
      .object({
        firms: z.array(z.object({ name: label, domain: domain.optional() }).strict()).max(200),
        roles: z.array(label).max(30),
        orgTypes: z.array(label).max(20),
      })
      .strict(),
    /** The confirmed group's seed firms only. */
    seedFirms: z.array(z.object({ name: label, domain: domain.optional(), country: iso2 }).strict()).max(100),
    howMany: z.union([z.literal(10), z.literal(20), z.literal(30), z.literal(50)]),
    perCompanyMax: z.literal(3),
    spend: z
      .object({
        /** Shown and approved at Confirm. Its default is configuration (v2.1 §6). */
        searchCreditCap: z.number().int().positive(),
        /** Read server-side at Confirm. */
        balanceSnapshot: z
          .object({
            remaining: z.number().int().nonnegative(),
            used: z.number().int().nonnegative().optional(),
            total: z.number().int().nonnegative().optional(),
            readAt: z.string().datetime({ offset: true }),
          })
          .strict(),
        /** Which documented or verified pricing model `documentedWorstCaseCharge` used. */
        pricingAssumptions: z.string().min(1).max(200),
      })
      .strict(),
    /** The lawful-basis record (v2.1 §12). Not an LIA. */
    lawfulBasis: z
      .object({
        text: z.string().min(1).max(2000),
        confirmedByUserId: id,
        confirmedAt: z.string().datetime({ offset: true }),
        briefVersion: z.number().int().positive(),
      })
      .strict(),
  })
  .strict()
  .superRefine((handoff, ctx) => {
    // Confirm is refused when the cap exceeds the balance it was read against (v2.1 §6).
    if (handoff.spend.searchCreditCap > handoff.spend.balanceSnapshot.remaining) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["spend", "searchCreditCap"],
        message: "the search cap cannot exceed the balance read at Confirm",
      });
    }
    if (handoff.lawfulBasis.briefVersion !== handoff.campaign.briefVersion) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lawfulBasis", "briefVersion"],
        message: "the lawful basis was confirmed for a different brief version",
      });
    }
  });

/** The agent definition's input is the handoff and nothing else. */
export const leadgenInputSchema = leadGenHandoffV1Schema;

export type LeadGenHandoffV1 = z.infer<typeof leadGenHandoffV1Schema>;
export type LeadgenInput = LeadGenHandoffV1;
export type Targeting = z.infer<typeof targetingSchema>;
