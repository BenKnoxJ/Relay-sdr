import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { factsDir } from "@/lib/facts/load";

/**
 * The facts file's "never say" list: phrases a pack must not state about the
 * product, drawn from the signed facts file's usage notes and the brand-voice
 * article (`facts/<product>.v<version>.never-say.json`).
 *
 * Linted over what the research agent authored — module bodies and its own
 * structured prose — never over a quote, a speaker's words or a url, which
 * the caller leaves out. A match whose sentence says "never", "not", "avoid"
 * or the like before it is guidance about the phrase, not a use of it, and is
 * skipped, unless the entry is `negatable: false` (a name that must never
 * appear at all). Audit 2026-09-10 (brief E): the pack said "independently
 * audited" where the note says "internally audited", and named a firm the
 * facts file says must never be referenced.
 */

const entrySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    /** A regex source, compiled case-insensitive. */
    pattern: z.string().min(1),
    sayInstead: z.string().min(1),
    factId: z.string().min(1).optional(),
    why: z.string().min(1),
    /** `false` for a name that must never appear, even in guidance. Default `true`. */
    negatable: z.boolean().optional(),
    /**
     * `true` (the default): fires only in a sentence that names the product —
     * a pack is full of competitors, disqualified buyers and other people's
     * claims, and "EvaluAgent offers a free trial" is a finding, not our copy.
     * `false` for a phrase that is wrong in any sentence (a name, the product's
     * own certification claim).
     */
    productOnly: z.boolean().optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    try {
      new RegExp(entry.pattern, "gi");
    } catch (error) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["pattern"], message: `does not compile: ${error instanceof Error ? error.message : String(error)}` });
    }
  });

export const neverSayFileSchema = z
  .object({
    product: z.string().regex(/^[a-z0-9-]+$/),
    version: z.number().int().positive(),
    source: z.string().min(1),
    entries: z.array(entrySchema).min(1),
  })
  .strict()
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    file.entries.forEach((entry, index) => {
      if (seen.has(entry.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["entries", index, "id"], message: `duplicate id ${entry.id}` });
      seen.add(entry.id);
    });
  });

export type NeverSayFile = z.infer<typeof neverSayFileSchema>;
export type NeverSayEntry = NeverSayFile["entries"][number];

export function neverSayPath(product: string, version: number): string {
  if (!/^[a-z0-9-]+$/.test(product)) throw new Error(`loadNeverSay: product ${JSON.stringify(product)} is not a plain slug`);
  if (!Number.isInteger(version) || version < 1) throw new Error(`loadNeverSay: version ${version} is not a positive integer`);
  return path.join(factsDir(), `${product}.v${version}.never-say.json`);
}

export function loadNeverSay(product: string, version: number): NeverSayFile {
  const file = neverSayPath(product, version);
  if (!existsSync(file)) throw new Error(`loadNeverSay: no never-say list at ${file}`);
  const parsed = neverSayFileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) {
    throw new Error(`loadNeverSay: ${file} does not parse: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`).join("; ")}`);
  }
  if (parsed.data.product !== product || parsed.data.version !== version) {
    throw new Error(`loadNeverSay: ${file} says it is ${parsed.data.product} v${parsed.data.version}, not ${product} v${version}`);
  }
  return parsed.data;
}

/**
 * A negation or a reporting word before the match, in the same sentence,
 * makes it guidance or a report of someone else's claim rather than ours:
 * "never say pen-tested", "buyers who need real-time assist are out", "the
 * wiki says 'typically within minutes'".
 */
const GUIDANCE =
  /\b(?:never|not|no|don['’]t|do not|doesn['’]t|does not|isn['’]t|is not|aren['’]t|are not|avoid|avoids|without|rather than|instead of|nor|cannot|can['’]t|won['’]t|ban|banned|hold|exclude[sd]?|excluding|out|disqualif\w*|claims?|claimed|says?|said|tells?|told|states?|stated|calling|called|describ\w*|lists?|listed|advertis\w*|wrong(?:ly)?|incorrect(?:ly)?|over-?claim\w*|stale|outdated)\b/i;
/**
 * The product named before the phrase, in its sentence: what makes a phrase
 * our claim. Named after it ("coaching workflows, which Insights360 does not
 * have") the phrase is about someone else.
 */
const PRODUCT = /\b(?:insights ?360|the product|the platform|our (?:platform|product|tool|service)|we)\b/i;

/** The sentence up to a match: from the last sentence end before it. */
function sentenceBefore(text: string, index: number): string {
  let start = 0;
  for (const found of text.slice(0, index).matchAll(/[.;\n!?](?:\s|$)/g)) start = (found.index ?? 0) + 1;
  return text.slice(start, index);
}

/**
 * A text to lint. `aboutProduct` marks a field written in the product's own
 * voice — m09 angles, m15 proof, m11 answers, m07 capabilities, the two
 * summaries — where "was independently audited" is our claim even though the
 * sentence never names the product (brief E, m09 and m15, 2026-09-10).
 */
export type NeverSayText = { where: string; text: string; aboutProduct?: boolean };

/** One issue per hit: where, what it said, and what to say instead. */
export function neverSayIssues(texts: ReadonlyArray<NeverSayText>, list: Pick<NeverSayFile, "entries">): string[] {
  const issues: string[] = [];
  const compiled = list.entries.map((entry) => ({ entry, regex: new RegExp(entry.pattern, "gi") }));
  for (const { where, text, aboutProduct } of texts) {
    for (const { entry, regex } of compiled) {
      regex.lastIndex = 0;
      for (const match of text.matchAll(regex)) {
        if (match[0].length === 0) continue;
        const before = sentenceBefore(text, match.index ?? 0);
        if (entry.productOnly !== false && aboutProduct !== true && !PRODUCT.test(`${before}${match[0]}`)) continue;
        if (entry.negatable !== false && GUIDANCE.test(before)) continue;
        issues.push(`${where}: says "${match[0]}" — say instead: ${entry.sayInstead} (${entry.why})`);
      }
    }
  }
  return issues;
}
