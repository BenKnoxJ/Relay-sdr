import { z } from "zod";

import {
  COMPLETE_MODULE_SCHEMAS,
  DOMAIN_CAP,
  MODULE_IDS,
  domainCounts,
  moduleFactIds,
  moduleOwnIds,
  type CompleteModule,
  type ModuleId,
  type PackShape,
} from "../../../agents/research/output.schema";
import { assertPlainWords } from "@/lib/copy/plainWords";

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
  now: Date;
};

export type ModuleCheck =
  | { ok: true; module: CompleteModule<ModuleId>; demoted: string[] }
  | { ok: false; issues: string[] };

export function checkModuleWrite(id: ModuleId, content: unknown, context: ModuleWriteContext): ModuleCheck {
  // The model writes the fields; the state is the runtime's to set (§3: the
  // model never writes an `insufficient` module itself).
  const withStatus =
    content !== null && typeof content === "object" && !Array.isArray(content) ? { ...(content as Record<string, unknown>), status: "complete" } : content;

  const demoted: string[] = [];
  const edited = (demoteStaleItems({ modules: { [id]: withStatus } }, context.now, demoted) as { modules: Record<string, unknown> }).modules[id];
  const parsed = (COMPLETE_MODULE_SCHEMAS[id] as z.ZodType<CompleteModule<ModuleId>>).safeParse(edited);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || id}: ${issue.message}`) };
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

  if (id === "repSummary") {
    try {
      assertPlainWords([...(written as CompleteModule<"repSummary">).lines]);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : "the rep summary uses words a rep would not");
    }
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, module: written, demoted };
}
