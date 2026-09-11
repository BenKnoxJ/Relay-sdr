import { z } from "zod";

import {
  COMPLETE_MODULE_SCHEMAS,
  DOMAIN_CAP,
  MODULE_IDS,
  domainCounts,
  crossModuleIssues,
  m04ScopeIssues,
  type LockedScope,
  type PageText,
  moduleFactIds,
  moduleNotYetFactIds,
  moduleOwnIds,
  type CompleteModule,
  type ModuleId,
  type PackShape,
} from "../../../agents/research/output.schema";
import { assertPlainWords } from "@/lib/copy/plainWords";
import { neverSayIssues, type NeverSayFile } from "@/lib/facts/neverSay";

import { authoredTexts } from "./authored";
import { normaliseModule } from "./normalise";

import { demoteStaleItems } from "./validate";

/**
 * The check `writeModule` runs as each module is written (research v3 §7 "On
 * write"): the module's schema and floors, derived confidence (on `Item`),
 * the twelve-month demotion, the per-module domain cap with its
 * primary-source carve-out, live fact ids, ids unique against the modules
 * already accepted, and rep words on the rep summary.
 *
 * What only the whole pack can show — every archetype covered by every
 * per-archetype module, every pain mapped, the hard filters echoed, the
 * buyer-words ratio, one candidate per archetype — is checked at ingest
 * (`validatePack`), because a module written before m03 cannot know the
 * archetypes yet.
 */

export type ModuleWriteContext = {
  /** The modules accepted so far on this job, by id, latest version each. */
  accepted: Partial<Record<ModuleId, unknown>>;
  liveFactIds: ReadonlySet<string>;
  /** Fact ids in the facts file that are not retired: what an m11 "not today" may cite (§10 note 9). */
  knownFactIds?: ReadonlySet<string>;
  /** Planned fact ids: an m11 answer citing one in `factIds` is moved to `notYetFactIds` (§10 notes 9, 23). */
  plannedFactIds?: ReadonlySet<string>;
  /** The product's never-say list (§10 note 20), linted over what the module's author wrote. */
  neverSay?: Pick<NeverSayFile, "entries">;
  /** v3.2 (§10 note 28): the rep's locked scope, enforced on m04's seed firms and recipes. */
  scope?: LockedScope;
  /** The text of a page the run read, for the place check. */
  pageText?: PageText;
  now: Date;
};

/**
 * The rep-words rule on the rep summary, unchanged — `assertPlainWords` decides
 * — with each refusal naming the words it caught and where. Brief A v3.2b was
 * told only "machine word … at $[4]" with the line echoed back; it guessed,
 * swapped "job" for a phrase with "touch" in it, and lost the module.
 */
export function repWordIssues(lines: readonly string[]): string[] {
  const banned = (text: string): boolean => {
    try {
      assertPlainWords([text]);
      return false;
    } catch {
      return true;
    }
  };
  return lines.flatMap((line, i) => {
    if (!banned(line)) return [];
    const tokens = line.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
    // The words the rule caught; a banned phrase of two words when no single word is.
    let words = [...new Set(tokens.filter(banned))];
    if (words.length === 0) words = [...new Set(tokens.slice(0, -1).map((token, n) => `${token} ${tokens[n + 1]}`).filter(banned))];
    if (words.length === 0) return [`lines.${i}: uses words a rep would not; rewrite it in plain words`];
    const named = words.map((word) => `"${word}"`).join(", ");
    return [`lines.${i}: ${named} ${words.length === 1 ? "is a word" : "are words"} a rep would not use — rewrite the line without ${words.length === 1 ? "it" : "them"}`];
  });
}

/**
 * m06 with `voice` on a kind of buyer rather than on its phrases (brief A
 * v3.2): a structural slip, refused with where the field belongs. Never
 * corrected by copying it down — `voice` is each phrase's own fact, and one
 * group holds words from different voices.
 */
export function groupVoiceIssues(id: ModuleId, content: unknown): string[] {
  if (id !== "m06" || content === null || typeof content !== "object") return [];
  const groups = (content as { perArchetype?: unknown }).perArchetype;
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((group, i) =>
    group !== null && typeof group === "object" && Object.hasOwn(group, "voice")
      ? [
          `perArchetype.${i}.voice: voice belongs on each phrase, not on the kind of buyer — one group can hold words from different voices. Remove perArchetype.${i}.voice and set perArchetype.${i}.phrases.<n>.voice on every phrase independently.`,
        ]
      : [],
  );
}

export type ModuleCheck =
  | { ok: true; module: CompleteModule<ModuleId>; demoted: string[]; normalised: string[] }
  | { ok: false; issues: string[]; normalised: string[] };

export function checkModuleWrite(id: ModuleId, content: unknown, context: ModuleWriteContext): ModuleCheck {
  // The model writes the fields; the state is the runtime's to set (§3: the
  // model never writes an `insufficient` module itself).
  // Mechanical slips first (§10 note 23): corrected and reported, never refused.
  const { content: fixed, notes: normalised } = normaliseModule(id, content, context.plannedFactIds === undefined ? {} : { plannedFactIds: context.plannedFactIds });
  const withStatus =
    fixed !== null && typeof fixed === "object" && !Array.isArray(fixed) ? { ...(fixed as Record<string, unknown>), status: "complete" } : fixed;

  const demoted: string[] = [];
  const edited = (demoteStaleItems({ modules: { [id]: withStatus } }, context.now, demoted) as { modules: Record<string, unknown> }).modules[id];
  const parsed = (COMPLETE_MODULE_SCHEMAS[id] as z.ZodType<CompleteModule<ModuleId>>).safeParse(edited);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || id}: ${issue.message}`), normalised };
  const written = parsed.data;

  const pack = { modules: { ...context.accepted, [id]: written }, partial: false, missingModules: [] } as unknown as PackShape;
  const issues: string[] = [];

  for (const [host, count] of domainCounts(pack, id)) {
    if (count > DOMAIN_CAP) {
      issues.push(`${count} pages from ${host} in this module; the cap is ${DOMAIN_CAP} per domain per module (a regulator, statistics body, ombudsman, trade-body register or the knowledge set is exempt: mark those evidence.primary)`);
    }
  }

  const own = moduleOwnIds(pack, id);
  const seen = new Set<string>();
  for (const ownId of own) {
    if (seen.has(ownId)) issues.push(`duplicate id ${JSON.stringify(ownId)} inside this module`);
    seen.add(ownId);
  }
  const elsewhere = new Set(MODULE_IDS.filter((other) => other !== id).flatMap((other) => moduleOwnIds(pack, other)));
  for (const ownId of seen) if (elsewhere.has(ownId)) issues.push(`id ${JSON.stringify(ownId)} is already used by another module; ids are unique across the pack`);

  for (const { where, ids } of moduleFactIds(pack, id)) {
    const dead = ids.filter((factId) => !context.liveFactIds.has(factId));
    if (dead.length > 0) issues.push(`${where}: ${dead.map((d) => JSON.stringify(d)).join(", ")} ${dead.length === 1 ? "is" : "are"} not a live fact id`);
  }

  // References to modules already accepted (§10 note 12): archetype ids from
  // m03, pain ids from m05, seed firms from m04, m00's hard filters.
  for (const found of crossModuleIssues(pack)) if (found.module === id) issues.push(found.message);

  // v3.2: the seed firms and recipes lead gen works from stay inside the rep's scope.
  if (id === "m04" && context.scope !== undefined) issues.push(...m04ScopeIssues(written as CompleteModule<"m04">, context.scope, context.pageText));

  if (context.knownFactIds !== undefined) {
    for (const { where, ids } of moduleNotYetFactIds(pack, id)) {
      const unknown = ids.filter((factId) => !context.knownFactIds!.has(factId));
      if (unknown.length > 0) issues.push(`${where}: ${unknown.map((d) => JSON.stringify(d)).join(", ")} ${unknown.length === 1 ? "is" : "are"} not in the facts file, or retired`);
    }
  }

  if (context.neverSay !== undefined) issues.push(...neverSayIssues(authoredTexts(id, written), context.neverSay));

  if (id === "repSummary") issues.push(...repWordIssues([...(written as CompleteModule<"repSummary">).lines]));

  return issues.length > 0 ? { ok: false, issues, normalised } : { ok: true, module: written, demoted, normalised };
}
