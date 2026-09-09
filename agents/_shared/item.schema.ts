import { z } from "zod";

/**
 * `Item`, `Phrase` and the derived-confidence rule.
 *
 * Shared by the research pack (`agents/research`) and the outreach lookup
 * (`agents/outreach`), because the outreach definition says so in as many
 * words: "`LookupItem = Item` from the research contract". One file, so the two
 * cannot drift.
 *
 * The rule this file exists for is research v2's headline: **confidence is
 * derived, never asserted**. The model may write a confidence word, but the word
 * it writes must be at or below the ceiling its own evidence supports, and a
 * word above that ceiling is a validation error rather than a note for a
 * reviewer. That is the whole reason the schema is code and not prose.
 */

/** An http(s) source. A bare hostname is not a citation. */
export const urlSchema = z
  .string()
  .url()
  .refine((raw) => {
    const protocol = new URL(raw).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "must be an http:// or https:// URL");

/** A stable slug id. Ids are referenced across the pack, so they cannot be prose. */
export const idSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "ids are stable lower-case slugs");

/**
 * A fact id, as the facts file spells them (§12).
 *
 * Shape only. Whether the id exists and is `live` is checked against the facts
 * file at ingest, which this task does not have: the facts file is §12 and lands
 * with slice 1. `agents/outreach/rubric.md` records that gap.
 */
export const factIdSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/, "fact ids are dotted or dashed slugs");

export const CONFIDENCE = ["strong", "moderate", "weak", "speculative"] as const;
export type Confidence = (typeof CONFIDENCE)[number];

/** Strongest first, so "above the ceiling" is a smaller index. */
const CONFIDENCE_RANK: Record<Confidence, number> = {
  strong: 0,
  moderate: 1,
  weak: 2,
  speculative: 3,
};

export const evidenceSchema = z.object({
  /**
   * The sources. Empty is allowed **only** for a `speculative` item — the
   * definition's own schema line says `Url[1..]` while its confidence rule says
   * `speculative` needs zero URLs and must name what it inferred from, so the
   * floor lives in the ceiling refinement below where both readings can hold.
   */
  urls: z.array(urlSchema).max(12),
  /** A primary source: the firm, the regulator, the filing, the facts file. */
  primary: z.boolean(),
  /** The hosts of `urls`, so the domain spread is readable without re-parsing. */
  domains: z.array(z.string().min(1)).max(12),
});

export type Evidence = z.infer<typeof evidenceSchema>;

/**
 * The strongest word this evidence supports.
 *
 * Straight from research v2 §3: a primary source or three URLs across two
 * domains is `strong`; two URLs across two distinct domains is `moderate`; one
 * URL is `weak`; nothing is `speculative`.
 */
export function confidenceCeiling(evidence: Evidence): Confidence {
  const urls = new Set(evidence.urls).size;
  // Derived from the urls, **not** from `evidence.domains`. The whole point of
  // v2 is that confidence is derived rather than asserted, and `domains` is a
  // field the model writes: padding it with three invented hosts beside three
  // urls on one site would otherwise buy `strong`, which is precisely the
  // over-claim this rule exists to refuse. `domains` survives as a convenience
  // for a reader, and the refinement below checks it matches.
  const domains = new Set(evidence.urls.map(hostOf)).size;
  if (evidence.primary) return "strong";
  if (urls >= 3 && domains >= 2) return "strong";
  if (urls >= 2 && domains >= 2) return "moderate";
  if (urls >= 1) return "weak";
  return "speculative";
}

/**
 * The host of a url, lower-cased and without a leading `www.`.
 *
 * Total: every url here has already passed `urlSchema`, and a refinement that
 * can throw turns a validation error into a crash.
 */
export function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, "");
  } catch {
    return url.toLowerCase();
  }
}

/** True when the asserted word is stronger than the evidence allows. */
export function aboveCeiling(asserted: Confidence, evidence: Evidence): boolean {
  return CONFIDENCE_RANK[asserted] < CONFIDENCE_RANK[confidenceCeiling(evidence)];
}

const itemFields = {
  id: idSchema,
  text: z.string().min(1).max(600),
  /** The source's own words. Needed for the provenance check (§7). */
  quote: z.string().min(1).max(600).optional(),
  speaker: z.string().min(1).max(160).optional(),
  role: z.string().min(1).max(160).optional(),
  /** When the source said it. ISO date or date-time. */
  publishedAt: z.string().datetime({ offset: true }).or(z.string().date()).optional(),
  /** When this run read it. Always present: a citation with no read date cannot be re-checked. */
  accessedAt: z.string().datetime({ offset: true }).or(z.string().date()),
  evidence: evidenceSchema,
  confidence: z.enum(CONFIDENCE),
  /** Required for `speculative`: what the inference was made from. */
  inferredFrom: z.string().min(1).max(400).optional(),
};

/**
 * The ceiling rule, as a refinement both `Item` and `Phrase` carry.
 *
 * Below the ceiling is allowed — an agent is free to under-claim — and above it
 * is rejected, naming both words so a reviewer can see which half was wrong.
 */
export function withCeilingRule<T extends z.ZodTypeAny>(schema: T): T {
  return schema.superRefine((value: z.infer<T>, ctx: z.RefinementCtx) => {
    const item = value as { confidence: Confidence; evidence: Evidence; inferredFrom?: string };
    if (aboveCeiling(item.confidence, item.evidence)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confidence"],
        message: `confidence "${item.confidence}" is above the ceiling "${confidenceCeiling(item.evidence)}" its evidence supports (${new Set(item.evidence.urls).size} url(s) across ${new Set(item.evidence.domains.map((d) => d.toLowerCase())).size} domain(s), primary: ${item.evidence.primary})`,
      });
    }
    if (item.confidence === "speculative" && item.inferredFrom === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["inferredFrom"],
        message: "a speculative item must name what it is inferred from",
      });
    }
    // `domains` must be the hosts of `urls`. Not load-bearing for the ceiling
    // any more, and still worth refusing: a list that disagrees with the urls is
    // either an attempt to pad the evidence or a pack whose domain-cap figures
    // cannot be trusted.
    const actual = new Set(item.evidence.urls.map(hostOf));
    const claimed = new Set(item.evidence.domains.map((domain) => hostOf(`https://${domain}/`)));
    if (actual.size !== claimed.size || [...actual].some((host) => !claimed.has(host))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence", "domains"],
        message: `domains must be the hosts of urls: urls give [${[...actual].sort().join(", ")}], domains say [${[...claimed].sort().join(", ")}]`,
      });
    }
    if (item.confidence !== "speculative" && item.evidence.urls.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence", "urls"],
        message: `"${item.confidence}" needs at least one url; only a speculative item may cite none`,
      });
    }
  }) as unknown as T;
}

/**
 * The item's fields as a plain object, before the ceiling rule.
 *
 * Exported so outreach can `.extend({ about })` — its `LookupItem` is "`Item`
 * from the research contract" plus one field, and an intersection would not do:
 * `itemSchema` is `.strict()`, so `itemSchema.and(...)` rejects the very field
 * the extension adds.
 */
export const itemObject = z.object(itemFields).strict();

export const itemSchema = withCeilingRule(itemObject);
export type Item = z.infer<typeof itemSchema>;

/**
 * A phrase buyers use — or a phrase a vendor used, flagged as such.
 *
 * `notBuyer` is not decoration. The outreach audit's finding was a cohort of
 * openers built on vendor prose presented as buyer words, so the flag is a
 * required field and the rubric counts it.
 */
export const phraseObject = z
  .object({
    ...itemFields,
    /** What to say. */
    say: z.string().min(1).max(300),
    /** What not to say, when the contrast is the point. */
    notThis: z.string().min(1).max(300).optional(),
    /** True when a vendor or consultant said it, not a buyer. */
    notBuyer: z.boolean(),
  })
  .strict();

export const phraseSchema = withCeilingRule(phraseObject);
export type Phrase = z.infer<typeof phraseSchema>;

/** Months between a publication date and now, or null when undated. */
export function monthsOld(item: { publishedAt?: string }, now: Date): number | null {
  if (item.publishedAt === undefined) return null;
  const published = new Date(item.publishedAt);
  if (Number.isNaN(published.getTime())) return null;
  return (now.getTime() - published.getTime()) / (1000 * 60 * 60 * 24 * 365.25 / 12);
}

/** Research v2 §3: a dated signal older than this cannot be `strong`. */
export const RECENCY_MONTHS = 12;

/**
 * Demote a stale item's confidence to `weak`.
 *
 * The definition says items older than twelve months "drop to `weak`
 * automatically", and automatic means before validation rather than during it:
 * a transform inside the schema would make the parsed value silently differ from
 * the model's, which is exactly the kind of invisible edit §24 is written
 * against. So the ingest calls this and then validates, and the schema rejects
 * anything stale that is still above `weak` — the demotion is a step a reader
 * can see, and skipping it is an error rather than a shrug.
 */
export function demoteStale<T extends { publishedAt?: string; confidence: Confidence }>(
  item: T,
  now: Date,
): T {
  const age = monthsOld(item, now);
  if (age === null || age <= RECENCY_MONTHS) return item;
  return CONFIDENCE_RANK[item.confidence] < CONFIDENCE_RANK.weak ? { ...item, confidence: "weak" } : item;
}

/** True when a dated item is older than the recency window and still over-claimed. */
export function staleAndOverClaimed(item: { publishedAt?: string; confidence: Confidence }, now: Date): boolean {
  const age = monthsOld(item, now);
  return age !== null && age > RECENCY_MONTHS && CONFIDENCE_RANK[item.confidence] < CONFIDENCE_RANK.weak;
}
