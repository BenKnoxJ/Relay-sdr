import { z } from "zod";

import { factIdSchema, idSchema, itemSchema, phraseSchema, urlSchema } from "../../_shared/item.schema";

/**
 * The modules of the research pack — `research.v3.signed.md` §3, one schema
 * per module, each in two states.
 *
 * A module is prose the campaign agent reads (`body`), the checkable
 * statements the prose rests on (`claims`, every one an `Item` the provenance
 * check runs over), and the structured fields the module's consumers need.
 * Floors are structural minimums (§3 table); there is no ceiling on prose.
 *
 * `complete` is what the model writes through `writeModule`; the runtime
 * validates against it and hands issues back. `insufficient` is what the
 * runtime stores after a second refusal (§3, §7): the body and claims as
 * written, the issues that refused it, and none of the structured floors.
 * The model never writes an `insufficient` module itself.
 */

export const MODULE_IDS = [
  "m00",
  "repSummary",
  "execSummary",
  "m01",
  "m02",
  "m03",
  "m04",
  "m05",
  "m06",
  "m07",
  "m08",
  "m09",
  "m10",
  "m11",
  "m12",
  "m13",
  "m14",
  "m15",
  "m16",
  "m17",
  "m18",
  "m19",
] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

/** The order the method writes them in (§5); the same as `MODULE_IDS`. */
export const MODULE_TITLES: Record<ModuleId, string> = {
  m00: "Steering note and hard filters",
  repSummary: "Summary for the rep",
  execSummary: "Executive summary",
  m01: "Market and company landscape",
  m02: "Competitive landscape",
  m03: "Persona intelligence",
  m04: "Targeting specification",
  m05: "Pains by archetype",
  m06: "Buyer words",
  m07: "Solution mapping",
  m08: "ICP definition",
  m09: "Messaging and positioning",
  m10: "Where buyers gather",
  m11: "Objections",
  m12: "Contact rules",
  m13: "Dated events and deadlines",
  m14: "Changes since the last pack",
  m15: "Proof the rep may use",
  m16: "Campaign candidates",
  m17: "Contradictions",
  m18: "Unknowns",
  m19: "Sources",
};

const text = (max: number) => z.string().min(1).max(max);
const lines = z.array(text(600));
const claims = z.array(itemSchema).max(200);

/** Fields every module carries. */
const base = {
  body: z.string().min(1),
  claims,
};

/** An `insufficient` module: the runtime's record of a module refused twice. */
export const insufficientModuleSchema = z
  .object({
    status: z.literal("insufficient"),
    ...base,
    issues: z.array(z.string().min(1)).min(1),
  })
  .strict();

/** A complete module: `base` plus the module's own fields, floors as refinements. */
function complete<T extends z.ZodRawShape>(fields: T) {
  return z.object({ status: z.literal("complete"), ...base, ...fields }).strict();
}

// ---------------------------------------------------------------------------
// m00 — steering note and hard filters (§2, §5 step 1)

export const hardFiltersSchema = z
  .object({
    geography: z.array(text(120)).min(1),
    sizeCap: text(120).optional(),
    subSectorsIn: z.array(text(160)),
    subSectorsOut: z.array(text(160)),
    firmsOut: z.array(text(160)),
    other: z.array(text(300)),
  })
  .strict();

export const m00Schema = complete({
  hardFilters: hardFiltersSchema,
  /** The regulatory or commercial spine the campaign hangs on. */
  spine: text(1000),
  /** What the product displaces. */
  displacement: text(1000),
  /** What "ready now" looks like for this buyer. */
  readyNow: lines.min(1),
  /** What must not lead the messaging. */
  mustNotLead: lines,
  /** The offer hook, as live fact ids. */
  offerHook: z.array(factIdSchema),
  /** Prior packs read, by id, and the hypotheses taken from them to verify. */
  priorPacksRead: z.array(z.string().min(1)),
  hypotheses: lines,
});

// ---------------------------------------------------------------------------
// repSummary — five lines in rep words (§3)

export const repSummarySchema = complete({
  /** Who to reach, why now, what to say first, the biggest unknown, the size of the opportunity. */
  lines: z.tuple([text(300), text(300), text(300), text(300), text(300)]),
});

// ---------------------------------------------------------------------------
// execSummary

export const execSummarySchema = complete({
  wedge: text(1000),
  icp: text(1000),
  archetypesNamed: z.array(text(160)).min(1),
  competitivePosition: text(1000),
  /** Constraints every downstream agent must respect (integrations, unshipped features, claims that may not be made). */
  productConstraints: lines.min(1),
  verdict: text(600),
}).refine((m) => m.claims.length >= 3, { message: "the executive summary rests on at least three claims", path: ["claims"] });

// ---------------------------------------------------------------------------
// m01 — market and company landscape

export const fitSchema = z.enum(["HIGH", "MEDIUM", "LOW", "OUT"]);

export const m01Schema = complete({
  marketSize: lines.min(1),
  subSegments: z
    .array(
      z
        .object({
          name: text(160),
          countEstimate: text(160).optional(),
          sizeRange: text(160).optional(),
          fit: fitSchema,
          why: text(600),
        })
        .strict(),
    )
    .min(4),
  bodies: z.array(z.object({ name: text(160), role: text(400), relevance: text(400), url: urlSchema.optional() }).strict()),
  /** Dated triggers from the last twelve months. */
  triggers: z.array(itemSchema).min(3),
  activityMetrics: lines,
  nextSixMonths: lines,
}).refine((m) => m.claims.length >= 5, { message: "the landscape rests on at least five claims", path: ["claims"] });

// ---------------------------------------------------------------------------
// m02 — competitive landscape

export const competitorSchema = z
  .object({
    name: text(160),
    url: urlSchema.optional(),
    positioning: text(600),
    pricing: text(300).optional(),
    pricingGated: z.boolean(),
    strengths: lines,
    weaknesses: lines,
    /** Moves in the last six months, dated. */
    recentMoves: z.array(itemSchema),
  })
  .strict();

export const m02Schema = complete({
  competitors: z.array(competitorSchema).min(3),
  adjacent: z.array(z.object({ name: text(160), note: text(600) }).strict()),
  doNothing: text(600),
  /** The product beside each competitor: name, price, minimum, commitment. */
  pricingTable: z
    .array(z.object({ name: text(160), price: text(160), minimum: text(160).optional(), commitment: text(160).optional() }).strict())
    .min(2),
  discoveryChannels: lines.min(1),
});

// ---------------------------------------------------------------------------
// m03 — persona intelligence

export const roleSchema = z
  .object({
    title: text(160),
    seniority: text(80),
    /** signs the purchase, champions it, or runs it day to day */
    part: z.enum(["signs", "champions", "runs"]),
    needs: text(400),
  })
  .strict();

export const dealEconomicsSchema = z
  .object({
    seatRange: text(120).optional(),
    plan: text(120).optional(),
    yearOneValue: text(160).optional(),
    salesCycle: text(120).optional(),
    budgetLine: text(120).optional(),
    /** The live pricing facts the figures rest on; empty means speculative (§3 rule). */
    factIds: z.array(factIdSchema),
    confidence: z.enum(["strong", "moderate", "weak", "speculative"]),
    note: text(400).optional(),
  })
  .strict()
  .refine((d) => d.factIds.length > 0 || d.confidence === "speculative", {
    message: "deal economics without a live pricing fact id must be speculative",
    path: ["confidence"],
  });

export const archetypeSchema = z
  .object({
    id: idSchema,
    name: text(120),
    /** A situation — sector, size, circumstance — never a job title. */
    situation: text(1000),
    sizeRange: text(120),
    dominantPain: itemSchema,
    roles: z.array(roleSchema).min(2),
    openingAngle: text(1000),
    dealEconomics: dealEconomicsSchema,
  })
  .strict();

export const m03Schema = complete({
  archetypes: z.array(archetypeSchema).min(3).max(5),
});

// ---------------------------------------------------------------------------
// m04 — targeting specification

/** Lead gen's recipe, six fields exactly (leadgen v2 §2). */
export const recipeSchema = z
  .object({
    titles: z.array(text(120)).min(1).max(40),
    excludeTitles: z.array(text(120)).max(40),
    sizeBand: z
      .object({ min: z.number().int().nonnegative(), max: z.number().int().positive() })
      .strict()
      .refine((band) => band.min < band.max, "sizeBand.min must be below sizeBand.max"),
    countries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(20),
    industries: z.array(text(120)).min(1).max(30),
    triggers: z.array(text(160)).max(30),
  })
  .strict();

export const triggerRowSchema = z
  .object({ signal: text(300), strength: z.enum(["HOT", "WARM"]), whereToFind: text(300), url: urlSchema.optional() })
  .strict();

export const seedFirmSchema = z
  .object({
    id: idSchema,
    name: text(200),
    domain: z.string().min(1).max(253).optional(),
    region: text(80),
    size: z
      .object({
        status: z.enum(["confirmed", "estimated", "unknown"]),
        value: text(120).optional(),
        source: urlSchema.optional(),
      })
      .strict()
      .refine((s) => s.status === "unknown" || s.value !== undefined, { message: "a confirmed or estimated size needs a value", path: ["value"] }),
    signal: itemSchema,
  })
  .strict();

export const targetingSchema = z
  .object({
    archetypeId: idSchema,
    recipe: recipeSchema,
    hardFiltersEchoed: z.array(text(300)).min(1),
    triggerTaxonomy: z.array(triggerRowSchema).min(3),
    listSources: z.array(z.object({ name: text(160), url: urlSchema, note: text(300).optional() }).strict()).min(1),
    /** Validation sample, not the list. */
    seedFirms: z.array(seedFirmSchema).min(2),
  })
  .strict();

export const m04Schema = complete({
  perArchetype: z.array(targetingSchema).min(1),
});

// ---------------------------------------------------------------------------
// m05 — pains by archetype

export const m05Schema = complete({
  perArchetype: z
    .array(
      z
        .object({
          archetypeId: idSchema,
          /** Most acute first. */
          pains: z.array(itemSchema).min(4),
        })
        .strict(),
    )
    .min(1),
});

// ---------------------------------------------------------------------------
// m06 — buyer words

export const m06Schema = complete({
  perArchetype: z.array(z.object({ archetypeId: idSchema, phrases: z.array(phraseSchema).min(3) }).strict()).min(1),
});

// ---------------------------------------------------------------------------
// m07 — solution mapping

export const m07Schema = complete({
  mappings: z
    .array(
      z
        .object({
          painId: idSchema,
          /** The shipped capability, as the knowledge set names it. */
          capability: text(300),
          factIds: z.array(factIdSchema),
          mustNotImply: text(400).optional(),
        })
        .strict(),
    ),
  unmatched: z.array(z.object({ painId: idSchema, roadmapStatus: text(300), note: text(400).optional() }).strict()),
});

// ---------------------------------------------------------------------------
// m08 — ICP definition

export const m08Schema = complete({
  idealCompany: lines.min(1),
  idealBuyer: lines.min(1),
  disqualifiers: z.array(z.object({ who: text(300), why: text(600) }).strict()).min(1),
  hardFiltersEchoed: hardFiltersSchema,
});

// ---------------------------------------------------------------------------
// m09 — messaging and positioning

export const angleSchema = z
  .object({
    rank: z.number().int().positive(),
    text: text(1000),
    confidence: z.enum(["strong", "moderate", "weak", "speculative"]),
    channelFit: z.array(text(80)).min(1),
  })
  .strict();

export const m09Schema = complete({
  brandConstraints: lines,
  perArchetype: z
    .array(
      z
        .object({
          archetypeId: idSchema,
          angles: z.array(angleSchema).min(5),
          doDont: z.array(z.object({ use: text(200), avoid: text(200), why: text(300).optional() }).strict()).min(1),
          /** Verbatim phrases from primary sources content and outreach may reuse. */
          verbatim: z.array(itemSchema).min(3),
          vocabulary: z.array(text(160)),
        })
        .strict(),
    )
    .min(1),
});

// ---------------------------------------------------------------------------
// m10 — where buyers gather

export const m10Schema = complete({
  entries: z
    .array(
      z
        .object({
          kind: z.enum(["press", "event", "association", "community", "review-site", "publication"]),
          name: text(200),
          url: urlSchema,
          date: z.string().optional(),
          audience: text(300),
          why: text(400),
          archetypeIds: z.array(idSchema).optional(),
        })
        .strict(),
    )
    .min(5),
});

// ---------------------------------------------------------------------------
// m11 — objections

export const m11Schema = complete({
  perArchetype: z
    .array(
      z
        .object({
          archetypeId: idSchema,
          objections: z
            .array(
              z
                .object({
                  objection: text(400),
                  /** Grounded only in live facts and the shipped column; absent means "no grounded answer". */
                  answer: text(800).optional(),
                  factIds: z.array(factIdSchema),
                })
                .strict(),
            )
            .min(3),
        })
        .strict(),
    )
    .min(1),
});

// ---------------------------------------------------------------------------
// m12 — contact rules

export const m12Schema = complete({
  rules: z
    .array(z.object({ channel: text(60), region: text(80), rule: text(800), source: urlSchema, bars: z.boolean() }).strict())
    .min(1),
});

// ---------------------------------------------------------------------------
// m13 — dated events and deadlines (facts, no allocation)

export const m13Schema = complete({
  entries: z.array(z.object({ date: z.string().min(4), what: text(400), source: urlSchema, why: text(400) }).strict()),
  noneFound: z.boolean(),
  queriesTried: z.array(text(300)),
}).refine((m) => m.noneFound || m.entries.length >= 3, { message: "at least three dated entries, or noneFound with the queries tried", path: ["entries"] })
  .refine((m) => !m.noneFound || m.queriesTried.length > 0, { message: "noneFound must name the queries tried", path: ["queriesTried"] });

// ---------------------------------------------------------------------------
// m14 — changes since the last pack

export const m14Schema = complete({
  applicable: z.boolean(),
  changes: z.array(
    z
      .object({
        kind: z.enum(["trigger", "archetype", "price", "contradiction", "other"]),
        text: text(600),
        priorPackId: z.string().min(1),
      })
      .strict(),
  ),
});

// ---------------------------------------------------------------------------
// m15 — proof the rep may use

export const m15Schema = complete({
  proof: z.array(z.object({ factId: factIdSchema, text: text(400), allowed: z.boolean(), note: text(400).optional() }).strict()).min(1),
});

// ---------------------------------------------------------------------------
// m16 — campaign candidates (findings, not a plan)

export const candidateSchema = z
  .object({
    id: idSchema,
    rank: z.number().int().positive(),
    archetypeId: idSchema,
    leadAngle: text(600),
    channelFit: z.array(text(80)).min(1),
    whyNow: text(600),
    seedFirmIds: z.array(idSchema),
    wrongIf: text(600),
  })
  .strict();

export const m16Schema = complete({
  candidates: z.array(candidateSchema).min(1),
});

// ---------------------------------------------------------------------------
// m17 — contradictions

export const contradictionSchema = z
  .object({
    id: idSchema,
    text: text(600),
    kind: z.enum(["against", "disagree"]),
    meaning: text(600),
    a: itemSchema.optional(),
    b: itemSchema.optional(),
  })
  .strict()
  .refine((c) => c.kind !== "disagree" || (c.a !== undefined && c.b !== undefined), {
    message: "sources that disagree are recorded as a and b",
    path: ["b"],
  });

export const m17Schema = complete({
  entries: z.array(contradictionSchema),
  noneFound: z.boolean(),
}).refine((m) => m.noneFound || m.entries.length >= 1, { message: "at least one contradiction, or noneFound after a search", path: ["entries"] });

// ---------------------------------------------------------------------------
// m18 — unknowns

export const unknownSchema = z
  .object({
    id: idSchema,
    text: text(600),
    kind: z.enum(["not-found", "confirmed-absent", "unreadable", "conflicting", "out-of-budget"]),
    whyItMatters: text(600),
    askOnFirstCall: text(400).optional(),
    queriesTried: z.array(text(300)),
  })
  .strict()
  .refine((u) => u.kind !== "not-found" || u.queriesTried.length > 0, {
    message: "a not-found unknown names the queries tried",
    path: ["queriesTried"],
  });

export const m18Schema = complete({
  unknowns: z.array(unknownSchema).min(1),
});

// ---------------------------------------------------------------------------
// m19 — sources

export const m19Schema = complete({
  sources: z.array(z.object({ url: urlSchema, title: text(300), accessedAt: z.string().date() }).strict()).min(1),
  knowledgeArticles: z.array(z.string().min(1)),
  factsVersion: z.number().int().positive(),
  priorPackIds: z.array(z.string().min(1)),
});

// ---------------------------------------------------------------------------

/** The complete schema per module: what `writeModule` validates and the model is shown. */
export const COMPLETE_MODULE_SCHEMAS = {
  m00: m00Schema,
  repSummary: repSummarySchema,
  execSummary: execSummarySchema,
  m01: m01Schema,
  m02: m02Schema,
  m03: m03Schema,
  m04: m04Schema,
  m05: m05Schema,
  m06: m06Schema,
  m07: m07Schema,
  m08: m08Schema,
  m09: m09Schema,
  m10: m10Schema,
  m11: m11Schema,
  m12: m12Schema,
  m13: m13Schema,
  m14: m14Schema,
  m15: m15Schema,
  m16: m16Schema,
  m17: m17Schema,
  m18: m18Schema,
  m19: m19Schema,
} as const;

export type CompleteModule<M extends ModuleId> = z.infer<(typeof COMPLETE_MODULE_SCHEMAS)[M]>;
export type InsufficientModule = z.infer<typeof insufficientModuleSchema>;
export type Module<M extends ModuleId> = CompleteModule<M> | InsufficientModule;

/** Either state, for the assembled pack. */
export function moduleSchema<M extends ModuleId>(id: M) {
  return z.union([COMPLETE_MODULE_SCHEMAS[id], insufficientModuleSchema]);
}

export function isModuleId(value: string): value is ModuleId {
  return (MODULE_IDS as readonly string[]).includes(value);
}
