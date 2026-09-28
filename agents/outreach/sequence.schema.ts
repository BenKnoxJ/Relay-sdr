import { z } from "zod";

import { SEQUENCE, type TouchKind } from "./input.schema";
import { MAX_OBJECTIONS, callDraftSchema, messageDraftSchema, outputSchemaFor, type OutreachOutput } from "./output.schema";

/**
 * P2 (21 Sep 2026): one answer drafts a person's whole sequence.
 *
 * The sequence holds the seven existing touch shapes, one per key. What the
 * model is offered is the *structure* only: the per-touch rules (one question,
 * last, and it is the ask; no em dash; plain words; a short voicemail) are the
 * refinements on `outputSchemaFor(kind)`, and they are run touch by touch after
 * the answer arrives (`touchesOf`). Put inside the answer's schema, one touch
 * breaking one rule would refuse all seven and pay for the whole sequence again.
 */

const objectionSchema = z.object({ objection: z.string().min(1).max(200), answer: z.string().min(1).max(400) }).strict();

/** The call touch as the sequence asks for it: the voicemail and the objections are required here. */
const sequenceCallSchema = callDraftSchema.extend({
  talkingPoint: z
    .object({
      openingLine: z.string().min(1).max(300),
      oneQuestion: z.string().min(1).max(300),
      listenFor: z.string().min(1).max(600),
      numberSource: z.enum(["zoho", "switchboard", "find_a_number"]),
      voicemail: z.string().min(1).max(400),
      objections: z.array(objectionSchema).max(MAX_OBJECTIONS),
      /** M2: the second call's own opener and question. Required here; the sequence asks for both calls. */
      openingLine2: z.string().min(1).max(300),
      oneQuestion2: z.string().min(1).max(300),
    })
    .strict(),
});

export const sequenceOutputSchema = z
  .object({
    email1: messageDraftSchema,
    email2: messageDraftSchema,
    breakup: messageDraftSchema,
    li_connect: messageDraftSchema,
    li_dm: messageDraftSchema,
    li_dm2: messageDraftSchema,
    call: sequenceCallSchema,
  })
  .strict();

export type SequenceOutput = z.infer<typeof sequenceOutputSchema>;

/** One touch of an answer, after its own rules: the draft, or why it is out of shape. */
export type ParsedTouch = { kind: TouchKind; output: OutreachOutput | null; issues: string[] };

/** Each touch of a sequence answer, checked against its own touch's full shape. */
export function touchesOf(answer: SequenceOutput): ParsedTouch[] {
  return SEQUENCE.map((kind) => {
    const parsed = outputSchemaFor(kind).safeParse(answer[kind]);
    if (parsed.success) return { kind, output: parsed.data, issues: [] };
    return { kind, output: null, issues: parsed.error.issues.map((issue) => `${[kind, ...issue.path].join(".")}: ${issue.message}`) };
  });
}
