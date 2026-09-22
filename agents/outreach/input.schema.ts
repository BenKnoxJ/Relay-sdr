import { z } from "zod";

import { factIdSchema, idSchema, itemObject, itemSchema, withCeilingRule } from "../_shared/item.schema";
import { ROLE_PARTS } from "../leadgen/input.schema";
import { productFactsSchema } from "../research/input.schema";
import { hookSchema, planArchetypeSchema as archetypeSchema } from "../research/output.schema";
import { angleSchema } from "../research/output/modules";
import { callDraftSchema, messageDraftSchema } from "./output.schema";

/**
 * What one draft job is given — `outreach.v2.signed.md` §3 and §4, as amended
 * by v2.1 §2 (signed 2026-09-15).
 *
 * The archetype, hook, angles and proof come from the research pack, imported
 * rather than restated: §3's input list is a contract between agents, and a
 * local copy of any of those shapes is a place for them to drift apart. The
 * person is Relay's revealed Person (v2.1 §2), not lead gen's preview shape.
 */

export const TOUCH_KINDS = ["email1", "email2", "breakup", "li_connect", "li_dm", "li_dm2", "call"] as const;
export type TouchKind = (typeof TOUCH_KINDS)[number];

/** The touches the Inbox approves: the emails. LinkedIn and the call are drafted and stored, and shown elsewhere. */
export const EMAIL_TOUCHES = ["email1", "email2", "breakup"] as const satisfies readonly TouchKind[];

/**
 * The sequence one job drafts for a person, in order (P2, 21 Sep 2026). The
 * position is the touch's `ordinal`; "shorter than the last" reads it.
 */
export const SEQUENCE = ["email1", "email2", "breakup", "li_connect", "li_dm", "li_dm2", "call"] as const satisfies readonly TouchKind[];

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
    /** `drafted`: written in the same sequence, not yet sent. A follow-up reads it so it does not repeat it. */
    fate: z.enum(["drafted", "sent", "replied", "bounced", "rejected", "snoozed", "closed"]),
    /** The reply, when there was one. §2's guard reads it; the writer must not answer it here (1b). */
    replyText: z.string().max(5000).optional(),
  })
  .strict();

/** v2.1 §2: the revealed person, as Relay holds them. Only a usable work email reaches the writer. */
export const outreachPersonSchema = z
  .object({
    id: z.string().min(1).max(100),
    name: z.string().min(1).max(200),
    firstName: z.string().min(1).max(100),
    title: z.string().min(1).max(200),
    company: z.string().min(1).max(200),
    domain: z.string().min(1).max(253).optional(),
    email: z.string().email().max(320),
    city: z.string().min(1).max(120).optional(),
  })
  .strict();

/**
 * Who is writing (P5c): the rep's first name and their company, so a call
 * opener, a voicemail or a connection note can say "<first name> from
 * <company>" rather than inventing a sender.
 */
export const senderSchema = z
  .object({
    firstName: z.string().min(1).max(100),
    company: z.string().min(1).max(200),
  })
  .strict();

/** v2.1 §2: the confirmed group's role this person plays, and what research says it needs. */
export const buyerRoleSchema = z
  .object({
    /** The id a `role_pain` opener may name. */
    id: idSchema,
    part: z.enum(ROLE_PARTS),
    title: z.string().min(1).max(500),
    needs: z.string().min(1).max(4000),
  })
  .strict();

/** v2.1 §2: the account, and the one piece of account evidence Relay holds (a firm research named). */
export const accountSchema = z
  .object({
    company: z.string().min(1).max(200),
    domain: z.string().min(1).max(253).optional(),
    seedEvidence: z.string().min(1).max(500).optional(),
  })
  .strict();

/** §3, and v2.1 §2's additions: the confirmed archetype's slice of the pack at this brief version. */
export const packSliceSchema = z
  .object({
    briefVersion: z.number().int().positive(),
    archetype: archetypeSchema,
    hook: hookSchema.optional(),
    /** m09's angles for this archetype, best first. */
    angles: z.array(angleSchema).max(5),
    /** m09's do and don't lines. */
    doDont: z.array(z.object({ use: z.string().min(1).max(500), avoid: z.string().min(1).max(500), why: z.string().max(2000).optional() }).strict()).max(12),
    /** m09's verbatim buyer phrases, which a draft may reuse as they are. */
    verbatim: z.array(itemSchema).max(8),
    /** m15 proof items marked `allowed`; nothing else may carry social proof. */
    proof: z.array(z.object({ factId: factIdSchema, text: z.string().min(1).max(2000), note: z.string().max(2000).optional() }).strict()).max(6),
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

/**
 * Messaging v2 (22 Sep 2026): one worked touch, in the shape the writer answers
 * in, with what it shows (the role, the opener, the give and the ask). The
 * exemplars teach shape; their words, facts and ids are another person's.
 */
export const exemplarSchema = z
  .object({
    touch: z.enum(TOUCH_KINDS),
    shows: z.string().min(1).max(400),
    draft: z.discriminatedUnion("kind", [messageDraftSchema, callDraftSchema]),
  })
  .strict()
  .refine((exemplar) => (exemplar.touch === "call") === (exemplar.draft.kind === "call"), { message: "a call exemplar is a call script, and every other touch is a message" });

export const standardSchema = z
  .object({
    version: z.number().int().positive(),
    /** Messaging v2: the eight rules of the writing standard. */
    rules: z.array(z.string().min(1).max(1000)).min(8).max(12),
    exemplars: z.array(exemplarSchema).max(20),
    /** v2.1 §6: the short, high-precision tell list, injected as a list and gated in code. */
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
    /** §4 and v2.1 §3: dated within 12 months, about this person or firm, quotable, relevant and professional. */
    usable: z.boolean(),
    /** What the lookup used, recorded on the draft (§4). A maximum, not a quota (v2.1 §3). */
    searches: z.number().int().nonnegative().max(2),
    fetches: z.number().int().nonnegative().max(2),
  })
  .strict();

/** v2.1 §2: one of the campaign's recent drafts, as the writer must not echo it. */
export const recentDraftSchema = z
  .object({
    opening: z.string().min(1).max(600),
    ask: z.string().min(1).max(300),
    subject: z.string().max(200).optional(),
    sameAccount: z.boolean(),
  })
  .strict();

/** v2.1 §6: the one corrective redraft, with what failed. */
export const redraftSchema = z
  .object({
    findings: z.array(z.string().min(1).max(500)).min(1).max(20),
    previous: z.object({ subject: z.string().max(200).optional(), body: z.string().max(5000), ask: z.string().max(300) }).strict(),
    /** A sequence redraft: every touch as it was, so the ones that passed come back unchanged. */
    previousTouches: z.array(threadEntrySchema).max(SEQUENCE.length).optional(),
  })
  .strict();

export const outreachInputSchema = z
  .object({
    person: outreachPersonSchema,
    sender: senderSchema,
    /** Absent for a Related role. */
    buyerRole: buyerRoleSchema.optional(),
    account: accountSchema,
    touch: touchSchema,
    /**
     * Present when one answer writes the whole sequence (P2): the touches, in
     * order. `touch` is then the first of them.
     */
    sequence: z.array(z.enum(TOUCH_KINDS)).min(1).max(SEQUENCE.length).optional(),
    thread: z.array(threadEntrySchema).max(20),
    pack: packSliceSchema,
    /** Live ids only (§3). The runtime filters before the model sees them. */
    facts: productFactsSchema,
    voice: voiceSchema,
    standard: standardSchema,
    lookup: lookupResultSchema,
    /** v2.1 §2, replacing `recentOpeners`: the campaign's last twenty drafts, to avoid echoing. */
    recentDrafts: z.array(recentDraftSchema).max(20),
    redraft: redraftSchema.optional(),
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
export type OutreachPerson = z.infer<typeof outreachPersonSchema>;
export type Sender = z.infer<typeof senderSchema>;
export type LookupItem = z.infer<typeof lookupItemSchema>;
export type LookupResult = z.infer<typeof lookupResultSchema>;
export type RecentDraft = z.infer<typeof recentDraftSchema>;
export type Exemplar = z.infer<typeof exemplarSchema>;
export { factIdSchema, idSchema };
