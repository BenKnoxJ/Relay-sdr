import { z } from "zod";

import { assertPlainWords } from "@/lib/copy/plainWords";

import { MOTIONS, regionSchema } from "../research/input.schema";

/**
 * What the orchestrator's three model calls return — `orchestrator.v2.signed.md` §2.
 *
 * Discriminated on `step`, matching the input. Every field is optional in the
 * pre-fill draft on purpose: §2's rule is "fill only what the sentence
 * supports", and §9's is that a missing field shows as a dash on the Start card.
 * A schema with required fields would force the model to guess, which is the
 * failure the `guessed` list exists to make visible.
 */

export const briefDraftSchema = z
  .object({
    step: z.literal("pre-fill"),
    product: z.string().min(1).max(120).optional(),
    motion: z.enum(MOTIONS).optional(),
    /** The rep's own words, kept (§2). */
    who: z.string().min(1).max(500).optional(),
    region: regionSchema.optional(),
    howMany: z.number().int().positive().max(500).optional(),
    weeks: z.number().int().positive().max(52).optional(),
    channels: z.array(z.string().min(1).max(60)).max(8).optional(),
    /**
     * Which fields were filled from something softer than the sentence.
     *
     * Present and possibly empty, never absent: "this was guessed" and "nothing
     * was guessed" have to be different answers, and an absent list makes them
     * the same one.
     */
    guessed: z.array(z.string().min(1).max(40)).max(8),
  })
  .strict();

export const campaignNameSchema = z
  .object({
    step: z.literal("name"),
    /** §2: forty characters, rep words, renamable. */
    name: z.string().min(1).max(40),
  })
  .strict();

/**
 * §2: two sentences at most.
 *
 * The count is enforced on the union below rather than here, because zod 3's
 * `discriminatedUnion` takes plain objects and a refined member is no longer
 * one. Same for the plain-words check.
 */
export const answerSchema = z
  .object({
    step: z.literal("answer"),
    answer: z.string().min(1).max(400),
  })
  .strict();

/**
 * Sentences, counted the blunt way.
 *
 * A terminator followed by whitespace or the end of the string. It miscounts an
 * abbreviation, and that is the right error to make: the cap exists to stop a
 * paragraph, and "Mr. Smith replied." counting as two costs a rewrite where a
 * cleverer rule would cost a paragraph on a rep's screen.
 */
export function sentenceCount(text: string): number {
  return text
    .split(/[.!?]+(?:\s|$)/)
    .map((part) => part.trim())
    .filter((part) => part !== "").length;
}

const union = z.discriminatedUnion("step", [briefDraftSchema, campaignNameSchema, answerSchema]);

export const orchestratorOutputSchema = union.superRefine((value, ctx) => {
  if (value.step === "answer" && sentenceCount(value.answer) > 2) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["answer"],
      message: "an answer is two sentences at most",
    });
  }
  // §10 row 10: `assertPlainWords` on every model output. The name and the
  // answer both land on a rep's screen verbatim.
  try {
    assertPlainWords(value);
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : "the output uses words a rep would not",
    });
  }
});

export type OrchestratorOutput = z.infer<typeof orchestratorOutputSchema>;
export type BriefDraft = z.infer<typeof briefDraftSchema>;
