import type { ModuleId } from "../../../agents/research/output.schema";
import type { NeverSayText } from "@/lib/facts/neverSay";

/**
 * The text a module's author wrote, for the never-say lint (research v3 §10
 * note 20): every string leaf except other people's words (quotes, speakers,
 * roles), urls and dates, ids and enums, and the fields whose job is to name
 * what must not be said (`avoid`, `notThis`, `mustNotLead`, `issues`). Whole
 * sections that describe other parties — competitors, adjacent products,
 * disqualified buyers — are skipped, since "a free trial" there is their
 * claim, not ours.
 *
 * `aboutProduct` marks the fields where the pack speaks for the product
 * (angles, objection answers, proof, capabilities, the summaries): there a
 * phrase fires without the product being named in the sentence.
 */

const SKIP_KEYS = new Set([
  "quote",
  "speaker",
  "role",
  "url",
  "urls",
  "source",
  "domains",
  "evidence",
  "avoid",
  "notThis",
  "mustNotLead",
  "issues",
  "inferredFrom",
  "id",
  "archetypeId",
  "painId",
  "factId",
  "factIds",
  "notYetFactIds",
  "seedFirmIds",
  "priorPackId",
  "priorPackIds",
  "status",
  "kind",
  "part",
  "strength",
  "fit",
  "confidence",
  "voice",
  "publishedAt",
  "accessedAt",
  "date",
  "queriesTried",
  "titles",
  "excludeTitles",
  "industries",
  "countries",
  "region",
]);

/** Sections about other parties, by module and top-level field. */
const SKIP_SECTIONS: Partial<Record<ModuleId, string[]>> = {
  m02: ["competitors", "adjacent", "pricingTable"],
  m08: ["disqualifiers"],
};

/** Where the pack speaks for the product: `module.path`, with `*` for an index. */
const PRODUCT_VOICE = [
  /^m09\.perArchetype\.\d+\.angles\.\d+\.text$/,
  /^m11\.perArchetype\.\d+\.objections\.\d+\.answer$/,
  /^m15\.proof\.\d+\.text$/,
  /^m07\.mappings\.\d+\.capability$/,
  /^repSummary\.lines\.\d+$/,
  /^execSummary\.(wedge|competitivePosition)$/,
];

export function authoredTexts(id: ModuleId, module: unknown): NeverSayText[] {
  const out: NeverSayText[] = [];
  const skipSections = new Set(SKIP_SECTIONS[id] ?? []);
  const walk = (value: unknown, path: string, depth: number): void => {
    if (typeof value === "string") {
      out.push({ where: path, text: value, ...(PRODUCT_VOICE.some((pattern) => pattern.test(path)) ? { aboutProduct: true } : {}) });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${path}.${index}`, depth + 1));
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        if (SKIP_KEYS.has(key)) continue;
        if (depth === 0 && skipSections.has(key)) continue;
        walk(inner, `${path}.${key}`, depth + 1);
      }
    }
  };
  walk(module, id, 0);
  return out;
}
