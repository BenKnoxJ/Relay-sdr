import { z } from "zod";

/**
 * What lead gen is given: `LeadGenHandoffV1`, leadgen v2.1 §3 (which replaces
 * v2 §2), and `LeadGenHandoffV2`, v2.2 §3a.
 *
 * Confirm freezes one of these into the `campaign.confirmed` Event, and it is
 * lead gen's only input. It is lead gen's own contract, declared here rather
 * than imported from the research pack: lead gen never reads Research's module
 * names or schemas (v2.1 §3, rubric row 14, and the `no-restricted-imports`
 * block for `agents/leadgen/**` in `eslint.config.mjs`). The campaign boundary
 * (`src/lib/campaigns/leadgenHandoff.ts`) is the one place that reads a pack
 * and writes one of these.
 *
 * Confirm writes V2 from v2.2 on. A V1 already frozen stays V1 and runs under
 * v2.1: a historical handoff is never rewritten.
 *
 * Holds are not in the handoff. They are read when lead gen runs (v2.1 §7,
 * §9), because a suppression written after Confirm must still count.
 */

/** Research's labels are at most 500 characters, so the handoff takes them whole. */
const label = z.string().min(1).max(500);
/** Research's prose is at most 8000 characters. */
const prose = z.string().min(1).max(8000);
const iso2 = z.string().regex(/^[A-Z]{2}$/, "a country is an ISO-3166 alpha-2 code, e.g. GB");
const id = z.string().min(1).max(200);
const domain = z.string().min(1).max(253);

/** How many a rep may ask for (Start's picker). The page and cap maths assume these. */
export const HOW_MANY = [10, 20, 30, 50] as const;

/** Who a buyer is to the purchase (v2.2 §3a): runs it day to day, champions it, or signs it off. */
export const ROLE_PARTS = ["runs", "champions", "signs"] as const;
export type RolePart = (typeof ROLE_PARTS)[number];

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

/** v2.2 §3a: one of the confirmed group's roles, as Research wrote it. */
export const buyerRoleSchema = z
  .object({
    /** Compound forms included ("Head of Claims / Claims Operations Manager"): lead gen splits them itself (§8a). */
    title: label,
    seniority: label,
    part: z.enum(ROLE_PARTS),
    needs: prose,
  })
  .strict();

/** Everything V1 and V2 share: the v2.1 §3 handoff less its version. */
const handoffFields = {
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
};

type HandoffCore = {
  spend: { searchCreditCap: number; balanceSnapshot: { remaining: number } };
  lawfulBasis: { briefVersion: number };
  campaign: { briefVersion: number };
};

/** The rules both versions keep (v2.1 §6, §12). */
function checkHandoff(handoff: HandoffCore, ctx: z.RefinementCtx): void {
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
}

export const leadGenHandoffV1Schema = z
  .object({ version: z.literal(1), ...handoffFields })
  .strict()
  .superRefine(checkHandoff);

export const leadGenHandoffV2Schema = z
  .object({
    version: z.literal(2),
    ...handoffFields,
    /** The confirmed campaign candidate: provenance only (v2.2 §3a). */
    play: z.object({ id }).strict(),
    /** The confirmed group's roles, verbatim. Research's own schema asks for at least two; one is enough to run. */
    buyerRoles: z.array(buyerRoleSchema).min(1).max(10),
  })
  .strict()
  .superRefine(checkHandoff);

/** Either version. A plain union: zod 3's discriminated union refuses refined members. */
export const leadGenHandoffSchema = z.union([leadGenHandoffV1Schema, leadGenHandoffV2Schema]);

/** The agent definition's input is the handoff and nothing else. */
export const leadgenInputSchema = leadGenHandoffSchema;

export type LeadGenHandoffV1 = z.infer<typeof leadGenHandoffV1Schema>;
export type LeadGenHandoffV2 = z.infer<typeof leadGenHandoffV2Schema>;
export type LeadGenHandoff = LeadGenHandoffV1 | LeadGenHandoffV2;
export type BuyerRole = z.infer<typeof buyerRoleSchema>;
export type LeadgenInput = LeadGenHandoff;
export type Targeting = z.infer<typeof targetingSchema>;
