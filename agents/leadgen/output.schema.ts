import { z } from "zod";

import { assertPlainWords } from "@/lib/copy/plainWords";

/**
 * What lead gen produces — `leadgen.v2.signed.md` §3.
 *
 * Two shapes, discriminated on `phase`, because §3 says so: a `Pick` exists
 * before anything is revealed and a `Revealed` after. They are one schema rather
 * than two so that "nothing spends before confirm" (§5 rubric row 5) is a
 * property of a single union a caller must narrow, instead of a convention two
 * unrelated types happen to follow.
 *
 * **Preview fields only** on a `Person` (§3). Nothing else exists at preview
 * time, so nothing else is in the type — a field here that Lusha only returns
 * after a reveal would be a field some code would read before the credit was
 * spent.
 */

export const HOLD_REASONS = [
  "customer",
  "open_deal",
  "dnc",
  "opted_out",
  "being_contacted",
  "already_revealed",
  "suppressed",
  "wrong_person",
  "below_b",
] as const;

export const SUPPRESSION_REASONS = ["no_email", "wrong_person", "invalid_id", "known"] as const;

export const personSchema = z
  .object({
    id: z.string().min(1).max(120),
    lushaId: z.string().min(1).max(120),
    name: z.string().min(1).max(200),
    title: z.string().min(1).max(200),
    company: z.string().min(1).max(200),
    domain: z.string().min(1).max(253),
    country: z.string().regex(/^[A-Z]{2}$/),
    city: z.string().min(1).max(120).optional(),
    linkedinUrl: z.string().url().optional(),
    /** Whether a reveal would yield an email. The only thing known for free. */
    hasEmail: z.boolean(),
    /** §6: the five fixed weights, summed. */
    score: z.number().int().nonnegative().max(20),
    /** §7: templated from the parts that fired, in rep words. */
    whyPicked: z.string().min(1).max(300),
    rank: z.number().int().positive(),
    /** What the per-company cap counts. The domain, normally. */
    companyKey: z.string().min(1).max(253),
  })
  .strict();

/** §2 step 2: pages plus reveals, shown before the first search. */
export const estimateSchema = z
  .object({
    pages: z.number().int().nonnegative(),
    reveals: z.number().int().nonnegative(),
    credits: z.number().int().nonnegative(),
    remainingAfter: z.number().int(),
  })
  .strict()
  .superRefine((estimate, ctx) => {
    if (estimate.credits !== estimate.pages + estimate.reveals) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["credits"],
        // One credit per page (§4 step 3) and one per reveal (§4 step 8), so the
        // total is the sum and a figure that is not the sum is a figure the rep
        // was shown that nothing charges.
        message: `credits must equal pages + reveals (${estimate.pages} + ${estimate.reveals})`,
      });
    }
  });

export const pickSchema = z
  .object({
    phase: z.literal("pick"),
    chosen: z.array(personSchema).max(50),
    /** §7 and §8 resolution 1: every unheld preview beyond N, not a fixed pool. */
    spare: z.array(personSchema).max(500),
    estimate: estimateSchema,
    /** "N of M found" (§4 step 3). */
    found: z.object({ n: z.number().int().nonnegative(), ofM: z.number().int().nonnegative() }).strict(),
    holdsApplied: z
      .array(z.object({ reason: z.enum(HOLD_REASONS), count: z.number().int().nonnegative() }).strict())
      .max(HOLD_REASONS.length),
  })
  .strict();

/** §4 step 8: one row per person, from Lusha's own returned charge. */
export const ledgerRowSchema = z
  .object({
    lushaId: z.string().min(1).max(120),
    credits: z.number().int().nonnegative(),
    /** True when the person was already revealed in this org and cost nothing (§4 step 8). */
    reattached: z.boolean(),
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
    // Checked on the union rather than on `pickSchema`: zod 3's
    // `discriminatedUnion` takes plain objects, and a refined member is not one.
    if (value.phase === "pick") {
      if (value.found.n > value.found.ofM) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["found"], message: "n cannot exceed ofM" });
      }
      const ranks = value.chosen.map((person) => person.rank);
      if (new Set(ranks).size !== ranks.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["chosen"], message: "ranks must be distinct" });
      }
    }
    // §5 rubric row 11: plain words on `whyPicked` and the reasons — and on
    // nothing else. A person's name, their title and their company are their
    // own, and `plainWords` is documented as the wrong tool for them: "Atlas
    // Copco" and "Vector Capital" are both real companies and both match the
    // banned list.
    try {
      assertPlainWords(authoredText(value));
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : "the output uses words a rep would not",
      });
    }
  });

/** The strings lead gen wrote, as opposed to the ones it read off a CRM. */
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
