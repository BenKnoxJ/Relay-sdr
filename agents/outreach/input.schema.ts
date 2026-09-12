import { z } from "zod";

import { factIdSchema, idSchema, itemObject, withCeilingRule } from "../_shared/item.schema";
import { productFactsSchema } from "../research/input.schema";
import { hookSchema, planArchetypeSchema as archetypeSchema } from "../research/output.schema";
import { revealedPersonSchema } from "../leadgen/output.schema";

/**
 * What one draft job is given — `outreach.v2.signed.md` §3 and §4.
 *
 * The person comes from lead gen's revealed shape and the archetype and hook
 * from the research pack, imported rather than restated: §3's input list is a
 * contract between three agents, and a local copy of any of those shapes is a
 * place for the three to drift apart.
 */

export const TOUCH_KINDS = ["email1", "email2", "breakup", "li_connect", "li_dm", "call"] as const;
export type TouchKind = (typeof TOUCH_KINDS)[number];

/** Which register the rep's samples are drawn from (§15 resolution 1). */
export const REGISTERS = ["email", "linkedin"] as const;

export const touchSchema = z
  .object({
    kind: z.enum(TOUCH_KINDS),
    /** Where in the sequence. Rule 7's "shorter than the last" is about this ordering. */
    ordinal: z.number().int().positive().max(20),
    dueAt: z.string().datetime({ offset: true }),
  })
  .strict();

/** An earlier touch, with how it fared. Rule 7 anchors on these; the gates measure against them. */
export const threadEntrySchema = z
  .object({
    kind: z.enum(TOUCH_KINDS),
    ordinal: z.number().int().positive().max(20),
    subject: z.string().max(200).optional(),
    body: z.string().max(5000),
    fate: z.enum(["sent", "replied", "bounced", "rejected", "snoozed", "closed"]),
    /** The reply, when there was one. §2's guard reads it; the writer must not answer it here (1b). */
    replyText: z.string().max(5000).optional(),
  })
  .strict();

/** §3: the matched slice of the pack, at the brief version this campaign is on. */
export const packSliceSchema = z
  .object({
    briefVersion: z.number().int().positive(),
    archetype: archetypeSchema,
    hook: hookSchema,
  })
  .strict();

export const voiceSchema = z
  .object({
    /** §15 resolution 1: email samples capped at eight, LinkedIn at four. */
    email: z.array(z.string().min(1).max(5000)).max(8),
    linkedin: z.array(z.string().min(1).max(5000)).max(4),
    howIWrite: z.string().max(2000),
  })
  .strict();

export const standardSchema = z
  .object({
    version: z.number().int().positive(),
    /** §6: the eight rules are the law. */
    rules: z.array(z.string().min(1).max(1000)).length(8),
    exemplars: z.array(z.string().min(1).max(5000)).max(20),
    /** Injected as a list (§6 rule 5); hashed snapshot from the wiki (§7). */
    bannedLexicon: z.array(z.string().min(1).max(80)).max(500),
  })
  .strict();

/** §4: at most three items, each an `Item` from the research contract plus what it is about. */
export const lookupItemSchema = withCeilingRule(
  itemObject.extend({ about: z.enum(["person", "firm"]) }).strict(),
);

export const lookupResultSchema = z
  .object({
    items: z.array(lookupItemSchema).max(3),
    /** §4: dated within 12 months, about this person or firm, from a stored page, quotable. */
    usable: z.boolean(),
    /** What the lookup cost, recorded on the draft (§4). */
    searches: z.number().int().nonnegative().max(2),
    fetches: z.number().int().nonnegative().max(2),
  })
  .strict();

export const outreachInputSchema = z
  .object({
    person: revealedPersonSchema,
    touch: touchSchema,
    thread: z.array(threadEntrySchema).max(20),
    pack: packSliceSchema,
    /** Live ids only (§3). The runtime filters before the model sees them. */
    facts: productFactsSchema,
    voice: voiceSchema,
    standard: standardSchema,
    lookup: lookupResultSchema,
    /** §6 rule 8: the campaign's last twenty openers, to avoid echoing. */
    recentOpeners: z.array(z.string().min(1).max(600)).max(20),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.facts.facts.some((fact) => fact.status !== "live")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["facts", "facts"],
        // Checked on the way in rather than trusted: §3 says live ids only, and
        // a planned fact reaching the prompt is how a claim nobody has shipped
        // ends up in a rep's email.
        message: "only live facts may reach the writer",
      });
    }
  });

export type OutreachInput = z.infer<typeof outreachInputSchema>;
export { factIdSchema, idSchema };
