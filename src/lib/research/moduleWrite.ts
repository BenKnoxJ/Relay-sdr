import { z } from "zod";

import {
  COMPLETE_MODULE_SCHEMAS,
  DOMAIN_CAP,
  MODULE_IDS,
  domainCounts,
  crossModuleIssues,
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
  now: Date;
};

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

  if (context.knownFactIds !== undefined) {
    for (const { where, ids } of moduleNotYetFactIds(pack, id)) {
      const unknown = ids.filter((factId) => !context.knownFactIds!.has(factId));
      if (unknown.length > 0) issues.push(`${where}: ${unknown.map((d) => JSON.stringify(d)).join(", ")} ${unknown.length === 1 ? "is" : "are"} not in the facts file, or retired`);
    }
  }

  if (context.neverSay !== undefined) issues.push(...neverSayIssues(authoredTexts(id, written), context.neverSay));

  if (id === "repSummary") {
    try {
      assertPlainWords([...(written as CompleteModule<"repSummary">).lines]);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : "the rep summary uses words a rep would not");
    }
  }

  return issues.length > 0 ? { ok: false, issues, normalised } : { ok: true, module: written, demoted, normalised };
}
