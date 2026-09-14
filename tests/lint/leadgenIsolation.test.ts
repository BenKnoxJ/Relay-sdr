import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { findingsFor, lintFixture } from "./lintFixture";

// Loading the flat config (Next's shareable configs included) is the slow
// part, and it happens once; outside a test so no single test pays for it.
beforeAll(async () => {
  await lintFixture("src/lib/leadgen/warmup.ts", "export const warm = 1;\n");
}, 60_000);

/**
 * Lead gen reads `LeadGenHandoffV1` and nothing of Research (leadgen v2.1 §3,
 * rubric row 14), and makes no model call (§0). The lint block holds the
 * first line; the scan below holds both against the real files, dynamic
 * imports included.
 */

const RULE = "no-restricted-imports";
const ROOT = path.resolve(import.meta.dirname, "..", "..");

const source = (specifier: string) => `import thing from "${specifier}";\nexport const value = thing;\n`;

describe("the lint block", () => {
  it("@proof refuses Research and the campaign boundary from lead gen's contract and core", async () => {
    for (const [file, specifier] of [
      ["agents/leadgen/input.schema.ts", "../research/output.schema"],
      ["agents/leadgen/output.schema.ts", "../research/output/modules"],
      ["src/lib/leadgen/translate.ts", "../../../agents/research/output.schema"],
      ["src/lib/leadgen/rank.ts", "@/lib/campaigns/packSelectors"],
      ["src/lib/leadgen/holds.ts", "@/lib/research/scrub"],
      ["src/lib/leadgen/findPeople.ts", "../campaigns/leadgenHandoff"],
    ] as const) {
      expect(findingsFor(await lintFixture(file, source(specifier)), RULE), `${file} -> ${specifier}`).toHaveLength(1);
    }
  });

  it("@proof keeps the app/worker boundary on the core", async () => {
    expect(findingsFor(await lintFixture("src/lib/leadgen/rank.ts", source("next/server")), RULE)).toHaveLength(1);
  });

  it("@proof allows lead gen's own contract, copy and services", async () => {
    for (const [file, specifier] of [
      ["src/lib/leadgen/findPeople.ts", "../../../agents/leadgen/input.schema"],
      ["src/lib/leadgen/rank.ts", "@/lib/copy/people"],
      ["src/lib/leadgen/crm.ts", "@/lib/services/types"],
      ["agents/leadgen/output.schema.ts", "@/lib/copy/plainWords"],
    ] as const) {
      expect(findingsFor(await lintFixture(file, source(specifier)), RULE), `${file} -> ${specifier}`).toHaveLength(0);
    }
  });

  it("@proof leaves the campaign boundary itself free to read Research", async () => {
    expect(findingsFor(await lintFixture("src/lib/campaigns/leadgenHandoff.ts", source("../../../agents/research/output.schema")), RULE)).toHaveLength(0);
  });
});

function files(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir)).flatMap((name) => {
    const relative = path.join(dir, name);
    return statSync(path.join(ROOT, relative)).isDirectory() ? files(relative) : /\.tsx?$/.test(name) ? [relative] : [];
  });
}

function specifiers(file: string): string[] {
  const text = readFileSync(path.join(ROOT, file), "utf8");
  return [...text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g)].map((match) => match[1]!);
}

describe("the real files", () => {
  const leadgen = [...files("agents/leadgen"), ...files("src/lib/leadgen")];

  it("has lead gen files to check", () => {
    expect(leadgen.length).toBeGreaterThan(5);
  });

  it("imports nothing of Research or the campaign boundary, statically or dynamically", () => {
    const offending = leadgen.flatMap((file) =>
      specifiers(file)
        .filter((specifier) => /(^|\/)research(\/|$)|(^|\/)campaigns(\/|$)/.test(specifier))
        .map((specifier) => `${file}: ${specifier}`),
    );
    expect(offending).toEqual([]);
  });

  it("imports no model client or agent loop: lead gen is code", () => {
    const offending = leadgen.flatMap((file) =>
      specifiers(file)
        .filter((specifier) => /^(ai|@ai-sdk\/|@anthropic-ai\/|@relay\/claude-code-bridge)|@\/lib\/agents\/(run|provider|model|mcpTools)/.test(specifier))
        .map((specifier) => `${file}: ${specifier}`),
    );
    expect(offending).toEqual([]);
  });
});
