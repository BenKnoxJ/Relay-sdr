import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { COMPLETE_MODULE_SCHEMAS, MODULE_IDS, isModuleId, packIssues, type PackShape } from "../../agents/research/output.schema";
import { agentsDir } from "@/lib/agents/definitions";
import { KNOWLEDGE_SCRUB } from "@/lib/knowledge/load";
import { normaliseModule } from "@/lib/research/normalise";

/**
 * The regression fixture (research v3 §10 note 24): brief A v3.1, the pack
 * the product owner signed at row 12 on 2026-09-11. Every later version of the rules
 * must accept it — after the write-time corrections a live write gets — apart
 * from the fields its manifest names as added after it was recorded. The May
 * pack (`researchDepthFixture.test.ts`) stays the external floor; this is the
 * Relay contract's own.
 */

const DIR = path.join(path.dirname(agentsDir()), "fixtures", "agents", "research");
const fixture = JSON.parse(readFileSync(path.join(DIR, "relay-a-insurance.v3.1.json"), "utf8")) as { pack: PackShape };
type Entry = { module: string; path: string; message: string; rule: string };
const manifest = JSON.parse(readFileSync(path.join(DIR, "relay-a-insurance.v3.1.manifest.json"), "utf8")) as { exemptions: Entry[] };

type Issue = { module: string | undefined; path: string; message: string };

function issuesOf(pack: PackShape): Issue[] {
  const modules = pack.modules as Record<string, Record<string, unknown>>;
  const corrected: Record<string, unknown> = {};
  const issues: Issue[] = [];
  for (const id of MODULE_IDS) {
    const stored = modules[id];
    if (stored === undefined) continue;
    const { status, ...content } = stored;
    const fixed = { ...(normaliseModule(id, content).content as Record<string, unknown>), status };
    corrected[id] = fixed;
    const parsed = COMPLETE_MODULE_SCHEMAS[id].safeParse(fixed);
    if (!parsed.success) for (const issue of parsed.error.issues) issues.push({ module: id, path: issue.path.join("."), message: issue.message });
  }
  for (const issue of packIssues({ ...pack, modules: corrected } as PackShape)) {
    const [head, id, ...rest] = issue.path;
    issues.push({ module: head === "modules" && typeof id === "string" && isModuleId(id) ? id : undefined, path: rest.join("."), message: issue.message });
  }
  return issues;
}

const matches = (issue: Issue, entry: Entry): boolean => entry.module === issue.module && entry.path === issue.path && entry.message === issue.message;

describe("the regression fixture: brief A v3.1 against today's rules", () => {
  const issues = issuesOf(fixture.pack);

  it("is complete: every module written, none insufficient, nothing missing", () => {
    const modules = fixture.pack.modules as Record<string, { status?: string }>;
    expect(MODULE_IDS.filter((id) => modules[id]?.status !== "complete")).toEqual([]);
    expect(fixture.pack).toMatchObject({ partial: false, missingModules: [] });
  });

  it("is refused only where its manifest says, and every manifest entry still happens", () => {
    const unexplained = issues.filter((issue) => !manifest.exemptions.some((entry) => matches(issue, entry)));
    expect(unexplained, unexplained.map((i) => `${i.module ?? "pack"}.${i.path}: ${i.message}`).join("\n")).toEqual([]);
    const stale = manifest.exemptions.filter((entry) => !issues.some((issue) => matches(issue, entry)));
    expect(stale, stale.map((e) => `${e.module}.${e.path}: ${e.message}`).join("\n")).toEqual([]);
  });

  it("exempts only fields added after it was recorded (§10 notes 25, 26, 28)", () => {
    expect(new Set(manifest.exemptions.map((e) => e.rule))).toEqual(new Set(["v3.2-addition"]));
    const kinds = [...new Set(manifest.exemptions.map((e) => `${e.module}:${e.path.replace(/\.\d+/g, ".*")}`))].sort();
    expect(kinds).toEqual([
      "m04:perArchetype.*.seedFirms.*.country",
      "m07:mappings.*.mustNotImply",
      "m16:candidates.*.angleIds",
      "m16:candidates.*.contactRuleIds",
      "m16:candidates.*.eventIds",
      "m16:candidates.*.objectionIds",
      "m16:candidates.*.painIds",
      "m16:candidates.*.venueIds",
    ]);
  });

  it("keeps six mappings partial and the rest direct, as signed", () => {
    const m07 = (fixture.pack.modules as Record<string, { mappings: Array<{ strength: string }> }>).m07!;
    expect(m07.mappings.filter((m) => m.strength === "partial")).toHaveLength(6);
    expect(m07.mappings.filter((m) => m.strength === "direct")).toHaveLength(14);
  });

  it("carries no fleet codename or VPS path", () => {
    expect(KNOWLEDGE_SCRUB.exec(JSON.stringify(fixture.pack))?.[0] ?? null).toBeNull();
  });
});
