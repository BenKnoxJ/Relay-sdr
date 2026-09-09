import { z } from "zod";

import { MOTIONS, regionSchema, researchBriefSchema } from "../research/input.schema";

/**
 * What the orchestrator's three model calls are given — `orchestrator.v2.signed.md` §2.
 *
 * One input schema and one output schema for three calls, discriminated on
 * `step`. Three sibling definitions would be the other option and would be
 * wrong: §2's headline is "still exactly three" model steps of *one* agent, and
 * splitting them would make "no fourth call" a property nothing holds.
 */

/** §8: the six questions, and nothing else. Anything else gets the fixed copy line. */
export const QUESTIONS = [
  "how-is-it-going",
  "what-is-waiting-on-me",
  "how-many-replied",
  "when-is-the-next-batch",
  "what-has-it-cost",
  "why-is-it-paused",
] as const;

/** §7's reason vocabulary. The copy file renders them; the model never invents one. */
export const HALT_REASONS = [
  "bad_output",
  "took_too_long",
  "failed_twice",
  "not_enough_evidence",
  "mailbox_paused",
  "credits_capped",
] as const;

/** §5's states, as the state machine names them. */
export const CAMPAIGN_STATES = [
  "brief",
  "researching",
  "researching_stopped",
  "plan_ready",
  "finding_people",
  "drafting",
  "running",
  "paused",
  "done",
] as const;

/** What the model may fill in, and the values it may use (§2 pre-fill row). */
export const allowedValuesSchema = z
  .object({
    motions: z.array(z.enum(MOTIONS)).min(1),
    regions: z.array(regionSchema).min(1),
    howMany: z.array(z.number().int().positive()).min(1),
    channels: z.array(z.string().min(1).max(60)).min(1),
  })
  .strict();

export const prefillInputSchema = z
  .object({
    step: z.literal("pre-fill"),
    /** What the rep typed on Start. */
    sentence: z.string().min(1).max(2000),
    /** The products they may choose. A product not on this list may never be invented. */
    products: z.array(z.string().min(1).max(120)).min(1).max(50),
    allowed: allowedValuesSchema,
    defaults: z.object({ weeks: z.number().int().positive().max(52) }).strict(),
  })
  .strict();

export const nameInputSchema = z
  .object({
    step: z.literal("name"),
    brief: researchBriefSchema,
  })
  .strict();

/** §2's `CampaignView`: everything the answer may contain, already computed. */
export const campaignViewSchema = z
  .object({
    state: z.enum(CAMPAIGN_STATES),
    counts: z.record(z.string().min(1).max(60), z.number().int().nonnegative()),
    reason: z.enum(HALT_REASONS).optional(),
    running: z
      .object({ kind: z.string().min(1).max(60), since: z.string().datetime({ offset: true }) })
      .strict()
      .optional(),
    /** What happens next, in words a rep reads. Always present: Q6 may have to name it. */
    nextEvent: z.string().min(1).max(300),
    spend: z
      .object({
        credits: z.number().int().nonnegative(),
        /** Model spend in USD, as a decimal string — the same shape `AgentRun.costTotal` has. */
        model: z.string().regex(/^\d+\.\d{1,6}$/),
      })
      .strict(),
  })
  .strict();

export const answerInputSchema = z
  .object({
    step: z.literal("answer"),
    question: z.enum(QUESTIONS),
    view: campaignViewSchema,
  })
  .strict();

export const orchestratorInputSchema = z.discriminatedUnion("step", [
  prefillInputSchema,
  nameInputSchema,
  answerInputSchema,
]);

export type OrchestratorInput = z.infer<typeof orchestratorInputSchema>;
export type CampaignView = z.infer<typeof campaignViewSchema>;
