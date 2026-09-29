import { z } from "zod";

import { assertOutreachProse, assertPlainDashes } from "@/lib/copy/plainWords";

import { factIdSchema, idSchema } from "../_shared/item.schema";
import type { OutreachInput, TouchKind } from "./input.schema";

/**
 * `Draft` — `outreach.v2.signed.md` §5.
 *
 * Two shapes, discriminated on `kind`: a message (email or LinkedIn) and a call,
 * because §5's call touch produces a `talkingPoint` and not a body. §7's gates
 * are deliberately **not** all here. Two different things are being checked:
 *
 *   * what is true of a draft on its own — the close is last and it is the
 *     `ask`, at most two questions; no em dash; ids are ids — which is this schema; and
 *   * what is true of a draft *against its touch and its thread* — the word
 *     count for this touch kind, whether `opener.ref` resolves, whether each
 *     claim is a live fact — which needs the input and is `checkTouchLimits`
 *     below.
 *
 * Splitting them that way is the point: the first set can never pass, so it is a
 * schema; the second set is Tier A findings that redraft the touch, so it
 * returns a list rather than throwing.
 */

/**
 * v2.1 §4: the personalisation tier the opener rests on. `archetype_pain` is
 * v2's word and is read as `role_pain`.
 */
export const OPENER_KINDS = ["person_fact", "firm_fact", "role_pain", "archetype_pain"] as const;
export type OpenerKind = (typeof OPENER_KINDS)[number];

export const openerSchema = z
  .object({
    /** A lookup item id, an archetype pain id, the hook id or the buyer role id. The card renders from whatever it points at. */
    ref: idSchema,
    kind: z.enum(OPENER_KINDS),
  })
  .strict();

/**
 * The raw list is checked here, before `normaliseClaims` moves out the opener's
 * ref and any lookup or plan id the model listed, so it leaves room for those.
 */
const MAX_RAW_CLAIMS = 6;

const common = {
  opener: openerSchema,
  claims: z.array(factIdSchema).max(MAX_RAW_CLAIMS),
};

export const messageDraftSchema = z
  .object({
    kind: z.literal("message"),
    /** Email touches only. §13: a concrete noun phrase, 20 to 50 characters, no fake "Re:". */
    subject: z.string().min(1).max(200).optional(),
    body: z.string().min(1).max(5000),
    /** §5: the close, a question or (voice round) a statement. Must appear verbatim, once, as the last sentence. */
    ask: z.string().min(1).max(300),
    ...common,
  })
  .strict();

/** P2: the call script's objection handling, at most three short pairs. */
export const MAX_OBJECTIONS = 3;
/** P2: the voicemail the rep leaves when nobody answers. */
export const MAX_VOICEMAIL_WORDS = 40;

const objectionSchema = z.object({ objection: z.string().min(1).max(200), answer: z.string().min(1).max(400) }).strict();

const talkingPointObject = z
  .object({
    openingLine: z.string().min(1).max(300),
    oneQuestion: z.string().min(1).max(300),
    listenFor: z.string().min(1).max(600),
    numberSource: z.enum(["zoho", "switchboard", "find_a_number"]),
    /**
     * P2 (21 Sep 2026). Optional on the shape so a talking point written before
     * it still reads; the sequence asks for both, and `gateTouch` holds a call
     * script that comes back without a voicemail.
     */
    voicemail: z.string().min(1).max(400).optional(),
    objections: z.array(objectionSchema).max(MAX_OBJECTIONS).optional(),
    /**
     * The second call's own opener and question (M2, 23 Sep 2026).
     *
     * One script served both calls in the 22 Sep cohort, six times out of
     * six, so the rep rang twice and said the same words and left the same
     * voicemail. Optional on the shape, like `voicemail`, so a script written
     * before this still reads; the sequence asks for both and `gateTouch`
     * holds a call that comes back without them.
     */
    openingLine2: z.string().min(1).max(300).optional(),
    oneQuestion2: z.string().min(1).max(300).optional(),
  })
  .strict();

function refineTalkingPoint(point: z.infer<typeof talkingPointObject>, ctx: z.RefinementCtx): void {
  if (words(point.openingLine) > 25) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["openingLine"], message: "an opening line is 25 words or fewer (§5)" });
  }
  if (point.openingLine2 !== undefined && words(point.openingLine2) > 25) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["openingLine2"], message: "an opening line is 25 words or fewer (§5)" });
  }
  // M2: the second call is a second call, not the first one read out again.
  if (point.openingLine2 !== undefined && point.openingLine2.trim() === point.openingLine.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["openingLine2"], message: "the second call opens differently from the first" });
  }
  if (point.oneQuestion2 !== undefined && point.oneQuestion2.trim() === point.oneQuestion.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["oneQuestion2"], message: "the second call asks something the first call did not" });
  }
  if (point.voicemail !== undefined && words(point.voicemail) > MAX_VOICEMAIL_WORDS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["voicemail"], message: `a voicemail is ${MAX_VOICEMAIL_WORDS} words or fewer` });
  }
}

export const callDraftSchema = z
  .object({
    kind: z.literal("call"),
    talkingPoint: talkingPointObject.superRefine(refineTalkingPoint),
    ...common,
  })
  .strict();

/**
 * The rules a draft satisfies on its own, whichever shape it is. On the union
 * rather than on `messageDraftSchema`: zod 3's `discriminatedUnion` takes plain
 * objects, and a refined member is not one.
 */
function refineDraft(draft: z.infer<typeof messageDraftSchema> | z.infer<typeof callDraftSchema>, ctx: z.RefinementCtx): void {
  if (draft.kind === "message") checkMessageShape(draft, ctx);
  // §6 rule 5 (no em dashes) and §12 rubric row 12 (plain words), on the
  // prose and only the prose. See `authoredProse`.
  for (const [field, text] of authoredProse(draft)) {
    // §6 rule 5: no em dashes. `assertPlainDashes` is the repository's own rule
    // and catches the spaced en dash too.
    try {
      assertPlainDashes(text);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: field.split("."),
        message: error instanceof Error ? error.message : "banned dash",
      });
    }
    // §12 rubric row 12: plain words on the body, the reasons and the talking
    // points, against the prose list. `MACHINE_WORDS` is the list for Relay's
    // own copy, and in an email "touch" is English and Atlas and Vector are
    // firms a rep writes to. The outreach list adds what a prospect must never
    // read: "Relay" and "pipeline" (P5c).
    try {
      assertOutreachProse(text);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: field.split("."),
        message: error instanceof Error ? error.message : "the draft uses words a rep would not",
      });
    }
  }
}

export const outreachOutputSchema = z.discriminatedUnion("kind", [messageDraftSchema, callDraftSchema]).superRefine(refineDraft);

/** A message draft and nothing else, with the same rules as the union. */
export const messageOutputSchema = messageDraftSchema.superRefine(refineDraft);

/**
 * The shape a touch is written in. A structured-output call is given exactly
 * one target: offered the folded message-or-call union, a first email could
 * come back as a call (the 15 Sep cohort's shape failures). The call touch
 * keeps the union, which is what its drafts are validated against today.
 */
export function outputSchemaFor(kind: TouchKind): z.ZodType<OutreachOutput> {
  return kind === "call" ? outreachOutputSchema : messageOutputSchema;
}

/**
 * The strings on a draft that a rep actually reads, by name.
 *
 * Named rather than walked, and that is the whole point. `assertPlainProse`
 * reaches every string on a value it is handed, and a draft's strings are not
 * all prose: `claims` is a list of fact ids and `opener.ref` is a lookup id.
 * Ids are separated by dashes and dots, both of which are word boundaries, so a
 * perfectly ordinary id — `fact-pipeline-value`, `pain-signal-1` — matches the
 * banned list and fails a draft that has nothing wrong with it. The enum
 * literals survive today only because `_` is *not* a word boundary
 * (`numberSource: "find_a_number"`, `opener.kind: "person_fact"`), which is an
 * accident and not a rule: rename one enum member with a dash in it and the
 * schema starts rejecting valid drafts again.
 *
 * So the sweep is a list of fields, and adding a rendered string to the schema
 * means adding it here. That is the same rule research and lead gen already
 * keep with `authoredText`, and the reason
 * `src/lib/copy/plainWords.ts` says to check "the copy it chose" rather than a
 * whole object: the list is ordinary English and thirteen first names, and it is
 * only safe pointed at prose.
 *
 * The paths are dotted so a finding names the field a rep would have to fix.
 */
function authoredProse(
  // The union's two members rather than `OutreachOutput`, which is inferred from
  // the schema this is called inside: naming it here would make the schema's
  // type depend on its own inference.
  draft: z.infer<typeof messageDraftSchema> | z.infer<typeof callDraftSchema>,
): [string, string][] {
  if (draft.kind === "message") {
    const out: [string, string][] = [
      ["body", draft.body],
      ["ask", draft.ask],
    ];
    if (draft.subject !== undefined) out.unshift(["subject", draft.subject]);
    return out;
  }
  const point = draft.talkingPoint;
  return [
    ["talkingPoint.openingLine", point.openingLine],
    ["talkingPoint.oneQuestion", point.oneQuestion],
    ["talkingPoint.listenFor", point.listenFor],
    ...(point.openingLine2 === undefined ? [] : ([["talkingPoint.openingLine2", point.openingLine2]] as [string, string][])),
    ...(point.oneQuestion2 === undefined ? [] : ([["talkingPoint.oneQuestion2", point.oneQuestion2]] as [string, string][])),
    ...(point.voicemail === undefined ? [] : ([["talkingPoint.voicemail", point.voicemail]] as [string, string][])),
    ...(point.objections ?? []).flatMap((pair, index): [string, string][] => [
      [`talkingPoint.objections.${index}.objection`, pair.objection],
      [`talkingPoint.objections.${index}.answer`, pair.answer],
    ]),
  ];
}

/** The most question marks a message carries (voice round): one mid-body question and the close, as the rep's own email does. */
export const MAX_QUESTIONS = 2;

/** The §5 and §6 rules a message draft satisfies on its own, with no touch in hand. */
function checkMessageShape(draft: z.infer<typeof messageDraftSchema>, ctx: z.RefinementCtx): void {
  const body = draft.body.trim();
  const ask = draft.ask.trim();
  const occurrences = countOccurrences(body, ask);
  if (occurrences === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ask"], message: "the ask must appear in the body verbatim" });
  } else if (occurrences > 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ask"], message: `the ask appears ${occurrences} times; it appears once` });
  } else if (!body.endsWith(ask)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ask"], message: "the ask is the last sentence" });
  }
  // Voice round (28 Sep 2026): the ask is the close, and a close need not be a question. The rep's approved cold
  // email asks a question mid-body and closes on another, so a message carries at most two; any touch may close
  // on a statement (standard v3).
  const questions = (body.match(/\?/g) ?? []).length;
  if (questions > MAX_QUESTIONS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["body"], message: `a draft asks at most ${MAX_QUESTIONS} questions; this one asks ${questions}` });
  }
  if (/^\s*[-*•]\s/m.test(draft.body)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["body"], message: "no bullets in an email (§6 rule 5)" });
  }
  if (draft.subject !== undefined && /^\s*re:/i.test(draft.subject)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["subject"], message: 'never a fake "Re:" (§13)' });
  }
}

export type OutreachOutput = z.infer<typeof outreachOutputSchema>;
export type MessageDraft = z.infer<typeof messageDraftSchema>;

/**
 * The per-touch limits (outreach standard v3, 28 Sep 2026), one row per kind and read only by that kind.
 * Email 1 50 to 100 words, Email 2 at most 90, the last email at most 50, the connection note at most 200
 * characters, the LinkedIn message 40 to 70 words and its follow-up at most 50. The call's limits are on
 * its schema (the opening lines and the voicemail).
 */
export const LIMITS: Record<TouchKind, { minWords?: number; maxWords?: number; maxChars?: number }> = {
  email1: { minWords: 50, maxWords: 100 },
  email2: { maxWords: 90 },
  breakup: { maxWords: 50 },
  li_connect: { maxChars: 200 },
  li_dm: { minWords: 40, maxWords: 70 },
  li_dm2: { maxWords: 50 },
  call: {},
};

/** A Tier A finding, in rep words. */
export type Finding = { rule: string; text: string };

/**
 * The checks that need the touch and its input: the length for this kind (truth check 8), whether the
 * opener points at something real (5), and whether every claim is a live fact whose number appears (2).
 * Returns findings rather than throwing, because a hold carries a list.
 */
export function checkTouchLimits(draft: OutreachOutput, input: OutreachInput): Finding[] {
  const findings: Finding[] = [];
  const limits = LIMITS[input.touch.kind];
  const text = draft.kind === "message" ? draft.body : draft.talkingPoint.openingLine;
  const length = words(text);

  if (limits.minWords !== undefined && length < limits.minWords) {
    findings.push({ rule: "length", text: `This is ${length} words; it needs at least ${limits.minWords}.` });
  }
  if (limits.maxWords !== undefined && length > limits.maxWords) {
    findings.push({ rule: "length", text: `This is ${length} words; the limit is ${limits.maxWords}.` });
  }
  if (limits.maxChars !== undefined && text.length > limits.maxChars) {
    findings.push({ rule: "length", text: `This is ${text.length} characters; the limit is ${limits.maxChars}.` });
  }

  // `opener.ref` must resolve: to a lookup item about the person for `person_fact`, about the firm for
  // `firm_fact`, and to an archetype pain, the hook or the buyer role for `role_pain`.
  const { kind, ref } = draft.opener;
  const lookupItem = input.lookup.items.find((item) => item.id === ref);
  const resolved =
    kind === "person_fact"
      ? lookupItem?.about === "person"
      : kind === "firm_fact"
        ? lookupItem?.about === "firm"
        : input.pack.archetype.pains.some((pain) => pain.id === ref) || input.pack.hook?.id === ref || input.buyerRole?.id === ref;
  if (!resolved) {
    findings.push({ rule: "opener-ref", text: "The opener points at something that is not in the lookup or the pack." });
  }
  // Inference from a firm's type is never usable: an unusable lookup cannot be the opener.
  if ((kind === "person_fact" || kind === "firm_fact") && !input.lookup.usable) {
    findings.push({ rule: "opener-usable", text: "There is no usable fact about this person or their firm, so open on the role problem." });
  }

  // Every claim must be a live fact, and a fact's number must appear where the rep reads it.
  for (const claim of draft.claims) {
    const fact = input.facts.facts.find((candidate) => candidate.id === claim);
    if (fact === undefined) {
      findings.push({ rule: "claim-id", text: `The claim ${claim} is not a fact this product has.` });
      continue;
    }
    // A figure, not a digit inside a name: "Insights360" carries no number a rep has to quote.
    const numbers = fact.text.match(/(?<![A-Za-z])\d[\d,.]*/g) ?? [];
    const body =
      draft.kind === "message"
        ? draft.body
        : [draft.talkingPoint.openingLine, draft.talkingPoint.oneQuestion, draft.talkingPoint.voicemail ?? "", ...(draft.talkingPoint.objections ?? []).map((pair) => pair.answer)].join(" ");
    // "50p" is how a rep says £0.50: the same figure.
    const said = body.replace(/\b(\d{1,2})p\b/g, (_, pence: string) => `£0.${pence.padStart(2, "0")}`);
    if (numbers.length > 0 && !numbers.some((number) => said.includes(number))) {
      findings.push({ rule: "claim-number", text: `The claim ${claim} carries a number that is not in the message.` });
    }
  }
  return findings;
}

function words(text: string): number {
  return text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}
