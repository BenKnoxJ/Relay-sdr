import { z } from "zod";

import { assertPlainDashes, assertPlainWords } from "@/lib/copy/plainWords";

import { factIdSchema, idSchema } from "../_shared/item.schema";
import type { OutreachInput, TouchKind } from "./input.schema";

/**
 * `Draft` — `outreach.v2.signed.md` §5.
 *
 * Two shapes, discriminated on `kind`: a message (email or LinkedIn) and a call,
 * because §5's call touch produces a `talkingPoint` and not a body. §7's gates
 * are deliberately **not** all here. Two different things are being checked:
 *
 *   * what is true of a draft on its own — one question, last, and it is the
 *     `ask`; no em dash; ids are ids — which is this schema; and
 *   * what is true of a draft *against its touch and its thread* — the word
 *     count for this touch kind, "shorter than the last", the five-gram overlap,
 *     whether `opener.ref` resolves — which needs the input and is
 *     `checkTouchLimits` below.
 *
 * Splitting them that way is the point: the first set can never pass, so it is a
 * schema; the second set is Tier A findings that redraft the touch, so it
 * returns a list rather than throwing.
 */

export const openerSchema = z
  .object({
    /** A lookup item id or an archetype pain id. The card renders from whatever it points at. */
    ref: idSchema,
    kind: z.enum(["person_fact", "archetype_pain"]),
  })
  .strict();

const common = {
  opener: openerSchema,
  claims: z.array(factIdSchema).max(3),
};

export const messageDraftSchema = z
  .object({
    kind: z.literal("message"),
    /** Email touches only. §13: a concrete noun phrase, 20 to 50 characters, no fake "Re:". */
    subject: z.string().min(1).max(200).optional(),
    body: z.string().min(1).max(5000),
    /** §5: the one question. Must appear verbatim, once, as the last sentence. */
    ask: z.string().min(1).max(300),
    ...common,
  })
  .strict();

export const callDraftSchema = z
  .object({
    kind: z.literal("call"),
    talkingPoint: z
      .object({
        openingLine: z.string().min(1).max(300),
        oneQuestion: z.string().min(1).max(300),
        listenFor: z.string().min(1).max(600),
        numberSource: z.enum(["zoho", "switchboard", "find_a_number"]),
      })
      .strict()
      .superRefine((point, ctx) => {
        if (words(point.openingLine) > 25) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["openingLine"], message: "an opening line is 25 words or fewer (§5)" });
        }
      }),
    ...common,
  })
  .strict();

export const outreachOutputSchema = z
  .discriminatedUnion("kind", [messageDraftSchema, callDraftSchema])
  .superRefine((draft, ctx) => {
    // Checked on the union rather than on `messageDraftSchema`: zod 3's
    // `discriminatedUnion` takes plain objects, and a refined member is not one.
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
      // §12 rubric row 12: plain words on the body, the reasons and the talking points.
      try {
        assertPlainWords(text);
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: field.split("."),
          message: error instanceof Error ? error.message : "the draft uses words a rep would not",
        });
      }
    }
  });

/**
 * The strings on a draft that a rep actually reads, by name.
 *
 * Named rather than walked, and that is the whole point. `assertPlainWords`
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
  return [
    ["talkingPoint.openingLine", draft.talkingPoint.openingLine],
    ["talkingPoint.oneQuestion", draft.talkingPoint.oneQuestion],
    ["talkingPoint.listenFor", draft.talkingPoint.listenFor],
  ];
}

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
  const questions = (body.match(/\?/g) ?? []).length;
  if (questions !== 1) {
    // §6 rule 4 and rubric row 4: exactly one question, and it is the ask.
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["body"], message: `a draft asks one question; this one asks ${questions}` });
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

/** §5's per-touch limits. Lower bound, upper bound, and whether a shrink is required. */
const LIMITS: Record<TouchKind, { minWords?: number; maxWords?: number; maxChars?: number; shrinks?: boolean; noLink?: boolean }> = {
  email1: { minWords: 50, maxWords: 150 },
  email2: { maxWords: 100, shrinks: true },
  breakup: { maxWords: 60, shrinks: true },
  // §5: 300 characters on Premium, else 200. The lower bound is what a draft
  // must satisfy without knowing the rep's plan, so 200 is the gate and the
  // extra hundred is headroom a Premium account does not need.
  li_connect: { maxChars: 200, noLink: true },
  li_dm: { minWords: 50, maxWords: 80, noLink: true },
  call: {},
};

/** A Tier A finding, in rep words (§7). */
export type Finding = { rule: string; text: string };

/**
 * The gates that need the touch and the thread.
 *
 * Returns findings rather than throwing: §7's Tier A result is "reject and
 * redraft the failing touch only, with findings, max two, then `needs_you` with
 * the reasons", and a thrown error cannot carry a list.
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
  if (limits.noLink === true && /https?:\/\//i.test(text)) {
    findings.push({ rule: "no-link", text: "A LinkedIn message carries no link." });
  }
  if (limits.shrinks === true) {
    // §6 rule 7: a follow-up shrinks. Measured against the previous touch this
    // person actually received, not against the campaign's template — which is
    // the same reason the rule exists.
    const previous = [...input.thread]
      .filter((entry) => entry.ordinal < input.touch.ordinal)
      .sort((a, b) => b.ordinal - a.ordinal)[0];
    if (previous !== undefined && length >= words(previous.body)) {
      findings.push({
        rule: "shorter-than-the-last",
        text: `This is ${length} words and the one before it was ${words(previous.body)}; a follow-up is shorter.`,
      });
    }
  }

  // §5: `opener.ref` must resolve — to a lookup item for `person_fact`, to an
  // archetype pain for `archetype_pain`. A dangling id renders an evidence line
  // on the card with nothing behind it.
  const resolved =
    draft.opener.kind === "person_fact"
      ? input.lookup.items.some((item) => item.id === draft.opener.ref)
      : input.pack.archetype.pains.some((pain) => pain.id === draft.opener.ref);
  if (!resolved) {
    findings.push({ rule: "opener-ref", text: "The opener points at something that is not in the lookup or the pack." });
  }
  // §4: inference from firm type is never usable. An unusable lookup cannot be
  // the opener, however well it reads.
  if (draft.opener.kind === "person_fact" && !input.lookup.usable) {
    findings.push({ rule: "opener-usable", text: "There is no usable fact about this person, so open on the archetype." });
  }

  // §5 and §7: every claim must be a live fact, and a fact's number must appear.
  for (const claim of draft.claims) {
    const fact = input.facts.facts.find((candidate) => candidate.id === claim);
    if (fact === undefined) {
      findings.push({ rule: "claim-id", text: `The claim ${claim} is not a fact this product has.` });
      continue;
    }
    const numbers = fact.text.match(/\d[\d,.]*/g) ?? [];
    const body = draft.kind === "message" ? draft.body : `${draft.talkingPoint.openingLine} ${draft.talkingPoint.oneQuestion}`;
    if (numbers.length > 0 && !numbers.some((number) => body.includes(number))) {
      findings.push({ rule: "claim-number", text: `The claim ${claim} carries a number that is not in the message.` });
    }
  }
  if (input.touch.kind === "email1" && draft.claims.length > 1) {
    findings.push({ rule: "one-claim", text: "A first email carries at most one product claim." });
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
