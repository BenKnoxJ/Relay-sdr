import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { COMPLETE_MODULE_SCHEMAS, MODULE_IDS, isModuleId, packIssues, type PackShape } from "../../agents/research/output.schema";
import { agentsDir } from "@/lib/agents/definitions";
import { KNOWLEDGE_SCRUB } from "@/lib/knowledge/load";

/**
 * The depth fixture (research v3 §7): Signal's May 2026 UK insurance pack,
 * converted to the v3 shape — bodies verbatim, claims from its tagged lines,
 * the modules it does not have listed missing. "A rule that refuses it is
 * wrong." Every refusal a rule makes of it must be one the fixture's manifest
 * names as one of the exemptions the definition grants (§7's three, and
 * §10 note 6: fields v3 added that the May pack predates); and every entry the manifest names
 * must still happen, so the list cannot go stale. A new rule that refuses
 * Signal-grade depth fails here.
 */

const DIR = path.join(path.dirname(agentsDir()), "fixtures", "agents", "research");
const pack = JSON.parse(readFileSync(path.join(DIR, "signal-may-insurance.v3.json"), "utf8")) as PackShape;
type Entry = { module: string; path: string; message: string; rule?: string };
const manifest = JSON.parse(readFileSync(path.join(DIR, "signal-may-insurance.v3.manifest.json"), "utf8")) as {
  presentModules: string[];
  missingModules: Array<{ module: string; why: string }>;
  exemptions: Entry[];
  ruleConflicts: Entry[];
  confidenceLowered: { count: number; total: number };
};

type Issue = { module: string | undefined; path: string; message: string };

function issuesOf(candidate: PackShape): Issue[] {
  const issues: Issue[] = [];
  const modules = candidate.modules as Record<string, unknown>;
  for (const id of MODULE_IDS) {
    if (modules[id] === undefined) continue;
    const parsed = COMPLETE_MODULE_SCHEMAS[id].safeParse(modules[id]);
    if (!parsed.success) for (const issue of parsed.error.issues) issues.push({ module: id, path: issue.path.join("."), message: issue.message });
  }
  for (const issue of packIssues(candidate)) {
    const [head, id, ...rest] = issue.path;
    issues.push({ module: head === "modules" && typeof id === "string" && isModuleId(id) ? id : undefined, path: rest.join("."), message: issue.message });
  }
  return issues;
}

const matches = (issue: Issue, entry: Entry): boolean =>
  (entry.module === issue.module || (issue.module === undefined && entry.module === "")) &&
  entry.message === issue.message &&
  (entry.path === issue.path || entry.path === "" || issue.path === "");

describe("the depth fixture: Signal's May pack against every v3 rule", () => {
  const issues = issuesOf(pack);
  const allowed = [...manifest.exemptions, ...manifest.ruleConflicts];

  it("is the May pack's modules and nothing invented: the rest are listed missing", () => {
    const present = MODULE_IDS.filter((id) => (pack.modules as Record<string, unknown>)[id] !== undefined);
    expect(present).toEqual(manifest.presentModules);
    expect(pack.missingModules).toEqual(manifest.missingModules.map((m) => m.module));
    expect(pack.partial).toBe(true);
  });

  it("is refused only where its manifest says, and every manifest entry still happens", () => {
    const unexplained = issues.filter((issue) => !allowed.some((entry) => matches(issue, entry)));
    expect(unexplained, unexplained.map((i) => `${i.module ?? "pack"}.${i.path}: ${i.message}`).join("\n")).toEqual([]);
    const stale = allowed.filter((entry) => !issues.some((issue) => matches(issue, entry)));
    expect(stale, stale.map((e) => `${e.module}.${e.path}: ${e.message}`).join("\n")).toEqual([]);
  });

  it("uses only the exemptions the definition grants: §7's three and §10 note 6's fourth", () => {
    expect([...new Set(manifest.exemptions.map((e) => e.rule))].every((rule) => ["m04-shape", "m06-buyer-words", "domain-cap", "v3-addition"].includes(rule ?? ""))).toBe(true);
    expect(manifest.ruleConflicts).toEqual([]);
  });

  it("names exactly the fields v3 added that the May pack predates (§10 notes 6, 13, 15, 25, 26)", () => {
    const kinds = [...new Set(manifest.exemptions.filter((e) => e.rule === "v3-addition").map((c) => `${c.module}:${c.path.replace(/\.\d+/g, ".*")}`))].sort();
    expect(kinds).toEqual([
      "m02:doNothing",
      "m04:perArchetype.*.seedFirms.*.country",
      "m06:perArchetype.*.phrases.*.voice",
      "m07:mappings.*.strength",
      "m09:perArchetype.*.angles.*.channelFit",
      "m09:perArchetype.*.angles.*.confidence",
      "m09:perArchetype.*.angles.*.id",
      "m18:unknowns.*.askOnFirstCall",
      "m18:unknowns.*.queriesTried",
      "m19:factsVersion",
    ]);
  });

  it("carries no fleet codename or VPS path in what it ships", () => {
    const text = JSON.stringify(pack);
    expect(KNOWLEDGE_SCRUB.exec(text)?.[0] ?? null).toBeNull();
  });
});
