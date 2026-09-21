import { z } from "zod";

import { assertPlainWords } from "@/lib/copy/plainWords";

import { ROLE_PARTS } from "./input.schema";

/**
 * What lead gen produces: leadgen v2 §3 as amended by v2.1 (§4, §6, §7, §9,
 * §11). Where the two differ, v2.1 wins.
 *
 * Two shapes, discriminated on `phase`: a `Pick` is People found (before any
 * email is bought) and a `Revealed` is People ready. They are one schema so
 * that "nothing is bought before Reveal emails" is a property of one union a
 * caller must narrow. A search that stops without a result is a `Halt`
 * (v2.1 §11), exported beside the union rather than in it: it is a reason for
 * the rep, not a list of people.
 *
 * **Preview fields only** on a `Person`, plus how lead gen ranked it and
 * whether Relay already owns its email (`source`). Nothing that exists only
 * after a reveal is in the type.
 */

/**
 * Why a candidate is not on the list (v2.1 §7, §9). Each is a campaign-only
 * hold except `dnc` and `opted_out`, which come from the organisation-wide
 * contact suppression. None of them is ever written anywhere org-wide by lead
 * gen's ranking.
 */
export const HOLD_REASONS = [
  // Before reveal, from the preview.
  "provider_unusable",
  "excluded_firm",
  "excluded_title",
  "wrong_geography",
  "customer",
  "company_cap",
  // Before or after reveal.
  "dnc",
  "opted_out",
  "duplicate_in_campaign",
  // Kept or revealed in another of the org's campaigns (Relay P1).
  "in_other_campaign",
  // After reveal.
  "invalid_id",
  "wrong_person",
  "no_email",
  "not_work_email",
  "grade",
] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

/** The only organisation-wide human/contact suppression (v2.1 §9). */
export const CONTACT_SUPPRESSION_REASONS = ["opted_out", "dnc"] as const;

/** A provider record's state (v2.1 §9). Not a fact about the human or the company. */
export const PROVIDER_IDENTITY_STATUSES = ["usable", "no_email", "invalid_id", "wrong_person", "restricted"] as const;

/**
 * Why People found shows X of N (v2.1 §4, §11). `fewer_strong_matches` is
 * v2.2 §8a: the accounts and roles that fit ran out, and nothing weaker was
 * added to make up the number.
 */
export const SHORTFALL_REASONS = ["cap_reached", "no_more_results", "fewer_strong_matches"] as const;

/** Why a search stopped with nothing for the rep to reveal (v2.1 §11). */
export const HALT_REASONS = [
  "no_candidates",
  "unmappable",
  "would_widen",
  "choose_industry",
  "over_cap",
  "balance_unavailable",
  "provider_busy",
  "took_too_long",
] as const;

export const personSchema = z
  .object({
    id: z.string().min(1).max(120),
    lushaId: z.string().min(1).max(120),
    name: z.string().min(1).max(200),
    title: z.string().min(1).max(200),
    company: z.string().min(1).max(200),
    domain: z.string().min(1).max(253).optional(),
    country: z.string().regex(/^[A-Z]{2}$/),
    city: z.string().min(1).max(120).optional(),
    linkedinUrl: z.string().url().optional(),
    /** Whether an email is available: from the preview, or already owned when reused. */
    hasEmail: z.boolean(),
    /** v2.1 §8: exact title 3 or related 1, seed firm 2, email 2. */
    score: z.number().int().nonnegative().max(7),
    /** Templated from the parts that fired, in rep words. */
    whyPicked: z.string().min(1).max(300),
    rank: z.number().int().positive(),
    /** What the per-company cap counts and accounts group by: the domain, else the provider's company id, else the company name (v2.2 §8a). */
    companyKey: z.string().min(1).max(253),
    /** The provider's own company id, when it gave one. Kept for grouping; never shown to a rep. */
    companyId: z.string().min(1).max(120).optional(),
    /**
     * Which of the confirmed group's roles this person plays, and how their
     * title matched it (v2.2 §8a). Absent for a Related role, and for any run
     * under a v2.1 handoff, which has no roles.
     */
    role: z
      .object({ part: z.enum(ROLE_PARTS), title: z.string().min(1).max(500), how: z.enum(["exact", "phrase"]) })
      .strict()
      .optional(),
    /** What revealing their email would cost, from the preview; null when the provider did not say. */
    emailRevealCredits: z.number().int().nonnegative().nullable().optional(),
    /** `reused`: Relay already owns a usable email for this person, so no credit is needed (v2.1 §9). */
    source: z.enum(["bought", "reused"]),
  })
  .strict();

/** Search spend at the time of the result (v2.1 §6). */
export const spendSummarySchema = z
  .object({
    searchCreditCap: z.number().int().positive(),
    /** Reconciled to what the provider reported. */
    charged: z.number().int().nonnegative(),
    /** Open and unreconciled reservations, still counted at their documented worst case. */
    reserved: z.number().int().nonnegative(),
    pricingAssumptions: z.string().min(1).max(200),
    /** True when the provider reported more than the documented worst case for a request. */
    exceededDocumentedWorstCase: z.boolean(),
  })
  .strict();

export const pickSchema = z
  .object({
    phase: z.literal("pick"),
    chosen: z.array(personSchema).min(1).max(50),
    /** Eligible candidates already returned but not chosen. Never bought on purpose (v2.1 §4). */
    spare: z.array(personSchema).max(500),
    /** People found, X of N: `n` chosen of `ofM` asked for. */
    found: z.object({ n: z.number().int().positive(), ofM: z.number().int().positive() }).strict(),
    /** Present exactly when fewer were found than asked for. */
    shortfall: z.enum(SHORTFALL_REASONS).optional(),
    spend: spendSummarySchema,
    /** What Reveal emails would cost: reused people cost nothing (v2.1 §6). */
    revealEstimate: z
      .object({
        toBuy: z.number().int().nonnegative(),
        reused: z.number().int().nonnegative(),
        credits: z.number().int().nonnegative(),
      })
      .strict(),
    holdsApplied: z
      .array(z.object({ reason: z.enum(HOLD_REASONS), count: z.number().int().positive() }).strict())
      .max(HOLD_REASONS.length),
  })
  .strict();

/** One provider call's charge (v2.1 §6). Reused people have no rows. */
export const ledgerRowSchema = z
  .object({
    kind: z.enum(["search", "reveal"]),
    key: z.string().min(1).max(300),
    credits: z.number().int().nonnegative(),
    /** `unreconciled`: the outcome was unknown, so it stays at the documented worst case. */
    state: z.enum(["reconciled", "unreconciled"]),
  })
  .strict();

export const revealedPersonSchema = personSchema
  .extend({
    email: z.string().email().optional(),
    status: z.enum(["verified", "held", "needs_you", "bounced"]),
  })
  .strict();

export const revealedSchema = z
  .object({
    phase: z.literal("revealed"),
    people: z.array(revealedPersonSchema).max(50),
    ledger: z.array(ledgerRowSchema).max(200),
    held: z
      .array(z.object({ personId: z.string().min(1).max(120), reason: z.enum(HOLD_REASONS) }).strict())
      .max(200),
  })
  .strict();

export const leadgenOutputSchema = z
  .discriminatedUnion("phase", [pickSchema, revealedSchema])
  .superRefine((value, ctx) => {
    // On the union rather than on `pickSchema`: zod 3's `discriminatedUnion`
    // takes plain objects, and a refined member is not one.
    if (value.phase === "pick") {
      if (value.found.n !== value.chosen.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["found", "n"], message: "found.n is how many were chosen" });
      }
      if (value.found.n > value.found.ofM) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["found"], message: "n cannot exceed ofM" });
      }
      if ((value.shortfall !== undefined) !== (value.found.n < value.found.ofM)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["shortfall"], message: "a shortfall is given exactly when fewer were found than asked for" });
      }
      const ranks = value.chosen.map((person) => person.rank);
      if (new Set(ranks).size !== ranks.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["chosen"], message: "ranks must be distinct" });
      }
      const reused = value.chosen.filter((person) => person.source === "reused").length;
      if (value.revealEstimate.reused !== reused || value.revealEstimate.toBuy + reused > value.chosen.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["revealEstimate"], message: "the reveal estimate must count the chosen people" });
      }
    }
    // Plain words on what lead gen wrote, and on nothing else: a person's
    // name, title and company are their own (see `authoredText`).
    try {
      assertPlainWords(authoredText(value));
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : "the output uses words a rep would not",
      });
    }
  });

/** v2.1 §11: a search that ended with nothing to reveal, and why. Choices are plain words, never provider ids. */
export const haltSchema = z
  .object({
    phase: z.literal("needs_you"),
    reason: z.enum(HALT_REASONS),
    field: z.enum(["country", "location", "industry", "sizeBand"]).optional(),
    term: z.string().min(1).max(500).optional(),
    choices: z.array(z.string().min(1).max(200)).min(1).max(3).optional(),
    spend: spendSummarySchema,
  })
  .strict();

/** The strings lead gen wrote, as opposed to the ones it read off a provider or a CRM. */
export function authoredText(value: z.infer<typeof pickSchema> | z.infer<typeof revealedSchema>): string[] {
  if (value.phase === "pick") {
    return [
      ...value.chosen.map((person) => person.whyPicked),
      ...value.spare.map((person) => person.whyPicked),
      ...value.holdsApplied.map((hold) => hold.reason),
    ];
  }
  return [...value.people.map((person) => person.whyPicked), ...value.held.map((hold) => hold.reason)];
}

export type LeadgenOutput = z.infer<typeof leadgenOutputSchema>;
export type Person = z.infer<typeof personSchema>;
/** A person after the reveal, with the email status the Your people rows show. */
export type RevealedPerson = z.infer<typeof revealedPersonSchema>;
export type Revealed = z.infer<typeof revealedSchema>;
export type Pick = z.infer<typeof pickSchema>;
export type Halt = z.infer<typeof haltSchema>;
export type SpendSummary = z.infer<typeof spendSummarySchema>;
export type ProviderIdentityStatus = (typeof PROVIDER_IDENTITY_STATUSES)[number];
export type ContactSuppressionReason = (typeof CONTACT_SUPPRESSION_REASONS)[number];
