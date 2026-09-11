import { confidenceCeiling, hostOf, type Confidence } from "../../../agents/_shared/item.schema";
import type { ModuleId } from "../../../agents/research/output.schema";

/**
 * Mechanical slips corrected on write, not refused (research v3 §10 note 23).
 *
 * Across briefs E and A, fourteen of fifteen refused module writes were our
 * rules, not the research: a confidence word above what its urls support, a
 * `domains` list with a typo, "UK" for GB, a market-size line written as an
 * object, an empty list left out. Each cost a full rewrite of the module —
 * 30,000 characters and a turn — to change a word the runtime can derive. So
 * the runtime derives it, says what it changed, and refuses only for content.
 *
 * Never changed here: anything that needs judgement — a floor, an id that
 * does not match another module, a never-say phrase, a dead fact id, an
 * unsized seed list. Those are still refusals.
 */

export type Normalised = { content: unknown; notes: string[] };

const RANK: Record<Confidence, number> = { strong: 0, moderate: 1, weak: 2, speculative: 3 };
const isConfidence = (value: unknown): value is Confidence => typeof value === "string" && value in RANK;

/** Country names a model writes for a code lead gen needs. */
const COUNTRY_CODES: Record<string, string> = {
  uk: "GB",
  "u.k.": "GB",
  "united kingdom": "GB",
  "great britain": "GB",
  britain: "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  "england and wales": "GB",
  "northern ireland": "GB",
  ireland: "IE",
  "republic of ireland": "IE",
  "united states": "US",
  usa: "US",
  "united states of america": "US",
};

type Loose = Record<string, unknown>;
const isObject = (value: unknown): value is Loose => value !== null && typeof value === "object" && !Array.isArray(value);

const isHttpUrl = (value: unknown): boolean => {
  if (typeof value !== "string") return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

export function normaliseModule(id: ModuleId, content: unknown, context: { plannedFactIds?: ReadonlySet<string> } = {}): Normalised {
  if (!isObject(content)) return { content, notes: [] };
  const copy = structuredClone(content);
  const notes: string[] = [];

  if (copy.claims === undefined) {
    copy.claims = [];
    notes.push("claims: none given, set to an empty list");
  }
  if (id === "repSummary" && typeof copy.body !== "string" && Array.isArray(copy.lines)) {
    copy.body = copy.lines.filter((line) => typeof line === "string").join("\n");
    notes.push("body: set from the five lines");
  }

  // Every Item, wherever it sits: derive `domains` and hold `confidence` to what the urls support.
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, i) => walk(entry, `${path}.${i}`));
      return;
    }
    if (!isObject(value)) return;
    const evidence = value.evidence;
    if (isObject(evidence) && Array.isArray(evidence.urls) && isConfidence(value.confidence)) {
      const urls = evidence.urls.filter((url): url is string => typeof url === "string");
      const hosts = [...new Set(urls.map(hostOf))];
      const claimed = Array.isArray(evidence.domains) ? evidence.domains.filter((d): d is string => typeof d === "string").map((d) => hostOf(`https://${d}/`)) : [];
      if (hosts.length !== new Set(claimed).size || hosts.some((host) => !claimed.includes(host))) {
        evidence.domains = hosts;
        notes.push(`${path}.evidence.domains: set to the hosts of its urls`);
      }
      const ceiling = confidenceCeiling({ urls, primary: evidence.primary === true, domains: hosts });
      if (RANK[value.confidence] < RANK[ceiling]) {
        notes.push(`${path}.confidence: lowered from ${value.confidence} to ${ceiling}, what its evidence supports`);
        value.confidence = ceiling;
        if (ceiling === "speculative" && value.inferredFrom === undefined) value.inferredFrom = "no source was cited";
      }
    }
    for (const [key, inner] of Object.entries(value)) if (key !== "evidence") walk(inner, `${path}.${key}`);
  };
  walk(copy, id);

  // m01: a market-size line written as { figure, source, note }.
  if (id === "m01" && Array.isArray(copy.marketSize)) {
    copy.marketSize = copy.marketSize.map((line, i) => {
      if (!isObject(line)) return line;
      const figure = [line.figure, line.value, line.text, line.label].find((part) => typeof part === "string") as string | undefined;
      const note = typeof line.note === "string" ? line.note : undefined;
      const source = typeof line.source === "string" ? line.source : typeof line.url === "string" ? line.url : undefined;
      if (figure === undefined) return line;
      notes.push(`m01.marketSize.${i}: written as one line`);
      return [figure, note].filter((part) => part !== undefined).join(" — ") + (source === undefined ? "" : ` (${source})`);
    });
  }

  // m01: a sub-segment's count or size written as a number (brief C v3.2: `countEstimate: 3`).
  if (id === "m01" && Array.isArray(copy.subSegments)) {
    copy.subSegments.forEach((segment, i) => {
      if (!isObject(segment)) return;
      for (const field of ["countEstimate", "sizeRange"] as const) {
        const value = segment[field];
        if (typeof value === "number" && Number.isFinite(value)) {
          segment[field] = String(value);
          notes.push(`m01.subSegments.${i}.${field}: the number ${value} written as text`);
        }
      }
    });
  }

  // m04: a size note written where the size's source url goes (brief E: "Headcount not verified this run").
  if (id === "m04" && Array.isArray(copy.perArchetype)) {
    copy.perArchetype.forEach((target, i) => {
      const firms = isObject(target) && Array.isArray(target.seedFirms) ? target.seedFirms : [];
      firms.forEach((firm, j) => {
        const size = isObject(firm) ? firm.size : undefined;
        if (!isObject(size) || size.source === undefined || isHttpUrl(size.source)) return;
        if (typeof size.source === "string" && size.value === undefined) size.value = size.source;
        delete size.source;
        notes.push(`m04.perArchetype.${i}.seedFirms.${j}.size.source: a note, not a url — kept as the size's value`);
      });
    });
  }

  // m11: a planned fact cited as an answer's ground can only mean "not today" (§10 note 9).
  if (id === "m11" && context.plannedFactIds !== undefined && Array.isArray(copy.perArchetype)) {
    const planned = context.plannedFactIds;
    copy.perArchetype.forEach((entry, i) => {
      const objections = isObject(entry) && Array.isArray(entry.objections) ? entry.objections : [];
      objections.forEach((objection, j) => {
        if (!isObject(objection) || !Array.isArray(objection.factIds)) return;
        const moved = objection.factIds.filter((factId): factId is string => typeof factId === "string" && planned.has(factId));
        if (moved.length === 0) return;
        objection.factIds = objection.factIds.filter((factId) => !moved.includes(factId as string));
        const already = Array.isArray(objection.notYetFactIds) ? objection.notYetFactIds : [];
        objection.notYetFactIds = [...new Set([...already, ...moved])];
        notes.push(`m11.perArchetype.${i}.objections.${j}: planned facts ${moved.join(", ")} moved to notYetFactIds`);
      });
    });
  }

  // Stable ids on angles, venues, objections, contact rules and dated events (§10 note 26): assigned when missing.
  const slug = (value: unknown): string =>
    String(value ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "item";
  const assign = (rows: unknown, make: (row: Loose, index: number) => string, where: string): void => {
    if (!Array.isArray(rows)) return;
    const used = new Set(rows.filter(isObject).map((row) => row.id).filter((id): id is string => typeof id === "string"));
    rows.forEach((row, index) => {
      if (!isObject(row) || typeof row.id === "string") return;
      let id = make(row, index);
      for (let n = 2; used.has(id); n += 1) id = `${make(row, index)}-${n}`;
      used.add(id);
      row.id = id;
      notes.push(`${where}.${index}.id: assigned ${id}`);
    });
  };
  if (id === "m09" && Array.isArray(copy.perArchetype)) {
    copy.perArchetype.forEach((entry, i) => {
      if (isObject(entry)) assign(entry.angles, (row, n) => `${slug(entry.archetypeId)}-angle-${typeof row.rank === "number" ? row.rank : n + 1}`, `m09.perArchetype.${i}.angles`);
    });
  }
  if (id === "m11" && Array.isArray(copy.perArchetype)) {
    copy.perArchetype.forEach((entry, i) => {
      if (isObject(entry)) assign(entry.objections, (_row, n) => `${slug(entry.archetypeId)}-objection-${n + 1}`, `m11.perArchetype.${i}.objections`);
    });
  }
  if (id === "m10") assign(copy.entries, (row) => `venue-${slug(row.name)}`, "m10.entries");
  if (id === "m12") assign(copy.rules, (row, n) => `rule-${slug(row.channel)}-${n + 1}`, "m12.rules");
  if (id === "m13") assign(copy.entries, (row, n) => `event-${slug(row.date)}-${n + 1}`, "m13.entries");

  // m04: country names to the ISO codes lead gen searches with, in the recipe and on each seed firm.
  const toCode = (country: unknown, where: string): unknown => {
    if (typeof country !== "string") return country;
    // "United Kingdom (England, Scotland, Wales)" — the bracket is a note (brief A).
    const trimmed = country.replace(/\s*\(.*\)\s*$/, "").trim();
    const mapped = /^[a-z]{2}$/i.test(trimmed) && trimmed.toLowerCase() !== "uk" ? trimmed.toUpperCase() : COUNTRY_CODES[trimmed.toLowerCase()];
    if (mapped !== undefined && mapped !== country) notes.push(`${where}: ${JSON.stringify(country)} → ${mapped}`);
    return mapped ?? country;
  };
  if (id === "m04" && Array.isArray(copy.perArchetype)) {
    copy.perArchetype.forEach((target, i) => {
      if (!isObject(target)) return;
      const recipe = target.recipe;
      if (isObject(recipe) && Array.isArray(recipe.countries)) {
        recipe.countries = recipe.countries.map((country, j) => toCode(country, `m04.perArchetype.${i}.recipe.countries.${j}`));
      }
      if (Array.isArray(target.seedFirms)) {
        target.seedFirms.forEach((firm, j) => {
          if (isObject(firm) && firm.country !== undefined) firm.country = toCode(firm.country, `m04.perArchetype.${i}.seedFirms.${j}.country`);
        });
      }
    });
  }

  return { content: copy, notes };
}

/**
 * Apply `fixes` — `{ path, value }` pairs, dotted paths as the refusal's
 * issues name them — to the last refused version of a module (§10 note 23),
 * so a refusal is answered with the fields that were wrong instead of the
 * whole module again. `value: null` removes the field or the list entry.
 */
export function applyFixes(base: Loose, fixes: ReadonlyArray<{ path: string; value?: unknown }>): { content: Loose; errors: string[] } {
  const content = structuredClone(base);
  const errors: string[] = [];
  for (const { path, value } of fixes) {
    const parts = path.split(".").filter((part) => part.length > 0);
    // A path may start with the module id, as the issues sometimes do.
    let cursor: unknown = content;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const key = parts[i]!;
      const next = Array.isArray(cursor) ? cursor[Number(key)] : isObject(cursor) ? cursor[key] : undefined;
      if (next === undefined || next === null || typeof next !== "object") {
        errors.push(`${path}: no ${key} to fix`);
        cursor = undefined;
        break;
      }
      cursor = next;
    }
    if (cursor === undefined) continue;
    const last = parts.at(-1)!;
    if (Array.isArray(cursor)) {
      const index = Number(last);
      if (!Number.isInteger(index) || index < 0 || index > cursor.length) {
        errors.push(`${path}: ${last} is not an index of this list`);
        continue;
      }
      if (value === null) cursor.splice(index, 1);
      else cursor[index] = value;
    } else if (isObject(cursor)) {
      if (value === null) delete cursor[last];
      else cursor[last] = value;
    }
  }
  return { content, errors };
}
