import type { ModuleId } from "./modules";
import { completeModule, type PackShape } from "./pack";

/**
 * The urls a module cites outside its `Item`s — a regulator it names, a
 * competitor's page, a list source, a seed firm's size source, a venue, a
 * contact rule's source, a dated event's source. Provenance checks each was
 * read this run (§7): on brief E (2026-09-10) nine of twelve venue urls and
 * every contact-rule source had never been fetched or seen, and nothing
 * noticed because none of them is an `Item`.
 *
 * Written out per module, like `moduleItems`, so a url field added later
 * shows up here as a missing line rather than a silently unchecked one. m19
 * is the list of sources itself and is not here.
 */
export function moduleUrlFields(pack: PackShape, id: ModuleId): Array<{ where: string; url: string }> {
  const out: Array<{ where: string; url: string }> = [];
  const add = (where: string, url: string | undefined): void => {
    if (url !== undefined) out.push({ where, url });
  };
  switch (id) {
    case "m01":
      completeModule(pack, "m01")?.bodies.forEach((body, i) => add(`m01.bodies.${i}.url`, body.url));
      break;
    case "m02":
      completeModule(pack, "m02")?.competitors.forEach((competitor, i) => add(`m02.competitors.${i}.url`, competitor.url));
      break;
    case "m04":
      completeModule(pack, "m04")?.perArchetype.forEach((target, i) => {
        target.listSources.forEach((source, j) => add(`m04.perArchetype.${i}.listSources.${j}.url`, source.url));
        target.seedFirms.forEach((firm, j) => add(`m04.perArchetype.${i}.seedFirms.${j}.size.source`, firm.size.source));
      });
      break;
    case "m10":
      completeModule(pack, "m10")?.entries.forEach((entry, i) => add(`m10.entries.${i}.url`, entry.url));
      break;
    case "m12":
      completeModule(pack, "m12")?.rules.forEach((rule, i) => add(`m12.rules.${i}.source`, rule.source));
      break;
    case "m13":
      completeModule(pack, "m13")?.entries.forEach((entry, i) => add(`m13.entries.${i}.source`, entry.source));
      break;
    default:
      break;
  }
  return out;
}
