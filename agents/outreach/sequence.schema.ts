import { z } from "zod";

import { productFactsSchema } from "../research/input.schema";
import { SEQUENCE, TOUCH_KINDS, senderSchema, voiceSchema, type TouchKind } from "./input.schema";
import { MAX_OBJECTIONS, callDraftSchema, messageDraftSchema, outputSchemaFor, type OutreachOutput } from "./output.schema";

/**
 * P2 (21 Sep 2026): one answer drafts a person's whole sequence, and a second
 * pass humanizes it.
 *
 * **The sequence** holds the seven existing touch shapes, one per key. What the
 * model is offered is the *structure* only: the per-touch rules (one question,
 * last, and it is the ask; no em dash; plain words; a short voicemail) are the
 * refinements on `outputSchemaFor(kind)`, and they are run touch by touch after
 * the answer arrives (`touchesOf`). Put inside the answer's schema, one touch
 * breaking one rule would refuse all seven and pay for the whole sequence again.
 *
 * **The humanizer** returns the prose and nothing else. The opener, the claims
 * and the number source are not in its answer, so it cannot change them: code
 * puts the humanized words back on the drafted touch. Messaging v2 (22 Sep
 * 2026) lets it cut a message's product sentence; it says so with
 * `droppedProduct`, and code then clears that touch's claims, so no fact id
 * points at words that are gone. It can drop claims, never add or change one;
 * the job keeps the cleared version only for a clean cut (`isCleanCut`).
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

// ---------------------------------------------------------------------------
// The humanizer pass.

const humanMessageSchema = z
  .object({
    subject: z.string().min(1).max(200).optional(),
    body: z.string().min(1).max(5000),
    ask: z.string().min(1).max(300),
    /** True when the pass cut the touch's product sentence: its claims go with it. */
    droppedProduct: z.boolean().optional(),
  })
  .strict();

const humanCallSchema = z
  .object({
    openingLine: z.string().min(1).max(300),
    oneQuestion: z.string().min(1).max(300),
    listenFor: z.string().min(1).max(600),
    voicemail: z.string().min(1).max(400).optional(),
    objections: z.array(objectionSchema).max(MAX_OBJECTIONS).optional(),
  })
  .strict();

const humanTouchesSchema = z
  .object({
    email1: humanMessageSchema.optional(),
    email2: humanMessageSchema.optional(),
    breakup: humanMessageSchema.optional(),
    li_connect: humanMessageSchema.optional(),
    li_dm: humanMessageSchema.optional(),
    li_dm2: humanMessageSchema.optional(),
    call: humanCallSchema.optional(),
  })
  .strict();

export type HumanTouches = z.infer<typeof humanTouchesSchema>;

export const humanizeInputSchema = z
  .object({
    firstName: z.string().min(1).max(100),
    /** Who is writing: the rep's first name and company, which the call opener and voicemail keep. */
    sender: senderSchema,
    /** The standard's rules, so the pass edits towards the same standard the drafter wrote to. */
    rules: z.array(z.string().min(1).max(1000)).max(12),
    /** The live facts with their notes, so the pass can tell a fact from an inference and keep a fact's wording inside its notes. */
    facts: productFactsSchema,
    /** The rep's samples: the rhythm to aim for, never content. */
    voice: voiceSchema,
    /** The standard's tell list; none of it may appear. */
    bannedLexicon: z.array(z.string().min(1).max(80)).max(500),
    /** Each touch's words and its limits, as drafted. */
    touches: humanTouchesSchema,
    limits: z.record(z.enum(TOUCH_KINDS), z.string().max(200)),
  })
  .strict();

export type HumanizeInput = z.infer<typeof humanizeInputSchema>;

/** The humanizer's answer: the same touches, prose only. */
export const humanizeOutputSchema = humanTouchesSchema;

/** A drafted touch's prose, as the humanizer is given it. */
export function proseOf(output: OutreachOutput): NonNullable<HumanTouches[keyof HumanTouches]> {
  if (output.kind === "message") return { ...(output.subject === undefined ? {} : { subject: output.subject }), body: output.body, ask: output.ask };
  const point = output.talkingPoint;
  return {
    openingLine: point.openingLine,
    oneQuestion: point.oneQuestion,
    listenFor: point.listenFor,
    ...(point.voicemail === undefined ? {} : { voicemail: point.voicemail }),
    ...(point.objections === undefined ? {} : { objections: point.objections }),
  };
}

/**
 * The humanized words on the drafted touch: the opener, the claims and the
 * number source are the drafted ones, whatever the humanizer answered. Null
 * when the answer for this touch is missing or the wrong shape.
 */
export function withProse(drafted: OutreachOutput, prose: HumanTouches[keyof HumanTouches] | undefined): OutreachOutput | null {
  if (prose === undefined) return null;
  if (drafted.kind === "message") {
    const message = humanMessageSchema.safeParse(prose);
    if (!message.success) return null;
    // A subject only where the draft had one: the humanizer does not invent a thread.
    const subject = drafted.subject === undefined ? undefined : (message.data.subject ?? drafted.subject);
    const claims = message.data.droppedProduct === true ? [] : drafted.claims;
    return { ...drafted, ...(subject === undefined ? {} : { subject }), body: message.data.body, ask: message.data.ask, claims };
  }
  const call = humanCallSchema.safeParse(prose);
  if (!call.success) return null;
  return { ...drafted, talkingPoint: { ...drafted.talkingPoint, ...call.data } };
}
