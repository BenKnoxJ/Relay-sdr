import { describe, expect, it } from "vitest";

import { findingsFor, lintFixture } from "./lintFixture";

const RULE = "no-restricted-imports";

// The app/worker boundary (master doc §18) is only worth having if it survives
// someone trying to get around it. Each case here is an escape route that the
// enumerated-pattern version of the rule let through.
describe("app/worker boundary rule", () => {
  it("@proof blocks a relative escape from three directories deep", async () => {
    const findings = await lintFixture(
      "src/lib/a/b/c/x.ts",
      'import Page from "../../../app/page";\nexport const page = Page;\n',
    );

    expect(findingsFor(findings, RULE)).toHaveLength(1);
  });

  it("@proof blocks the same escape from one and two directories deep", async () => {
    for (const [file, specifier] of [
      ["src/lib/a/x.ts", "../app/page"],
      ["src/lib/a/b/x.ts", "../../server/api/root"],
      ["src/worker/a/b/c/d/x.ts", "../../../../server/api/trpc"],
    ] as const) {
      const findings = await lintFixture(
        file,
        `import thing from "${specifier}";\nexport const value = thing;\n`,
      );

      expect(findingsFor(findings, RULE), `${file} -> ${specifier}`).toHaveLength(1);
    }
  });

  it("@proof blocks the restricted packages and the aliased paths", async () => {
    for (const specifier of [
      "next",
      "next/headers",
      "@clerk/nextjs",
      "@/app/page",
      "@/server/api/root",
    ]) {
      const findings = await lintFixture(
        "src/worker/x.ts",
        `import thing from "${specifier}";\nexport const value = thing;\n`,
      );

      expect(findingsFor(findings, RULE), specifier).toHaveLength(1);
    }
  });

  it("@proof applies to .tsx as well as .ts", async () => {
    const findings = await lintFixture(
      "src/lib/ui/Thing.tsx",
      'import { headers } from "next/headers";\nexport const read = headers;\n',
    );

    expect(findingsFor(findings, RULE)).toHaveLength(1);
  });

  it("@proof blocks a dynamic import and a require, not just a static import", async () => {
    for (const source of [
      'await import("@clerk/nextjs/server")',
      'await import("next/headers")',
      'await import("../../../app/page")',
      'createRequire(import.meta.url)("next")',
    ]) {
      const findings = await lintFixture(
        "src/lib/a/b/c/x.ts",
        `import { createRequire } from "node:module";\nexport async function run() {\n  return ${source};\n}\n`,
      );

      // `no-restricted-imports` never visits these nodes, so the finding comes
      // from the paired no-restricted-syntax selectors.
      expect(findingsFor(findings, "no-restricted-syntax"), source).toHaveLength(1);
    }
  });

  it("@proof blocks the bare aliases, not just their sub-paths", async () => {
    // A barrel at src/server/index.ts is reachable as plain `@/server`.
    for (const specifier of ["@/app", "@/server"]) {
      const findings = await lintFixture(
        "src/lib/x.ts",
        `import thing from "${specifier}";\nexport const value = thing;\n`,
      );

      expect(findingsFor(findings, RULE), specifier).toHaveLength(1);
    }
  });

  it("@proof blocks non-canonical relative escapes", async () => {
    // Both of these resolve to src/app/page from src/lib/a/x.ts.
    for (const specifier of ["./../app/page", "../lib/../app/page"]) {
      const findings = await lintFixture(
        "src/lib/a/x.ts",
        `import thing from "${specifier}";\nexport const value = thing;\n`,
      );

      expect(findingsFor(findings, RULE), specifier).toHaveLength(1);
    }
  });

  it("@proof blocks createRequire through a namespace import as well as bare", async () => {
    for (const body of [
      'import { createRequire } from "node:module";\nexport const next = createRequire(import.meta.url)("next");',
      'import * as mod from "node:module";\nexport const next = mod.createRequire(import.meta.url)("next");',
    ]) {
      const findings = await lintFixture("src/worker/x.ts", `${body}\n`);

      // Two findings: the banned node:module import and the banned call.
      expect(findingsFor(findings, "no-restricted-syntax"), body).toHaveLength(1);
      expect(findingsFor(findings, RULE), body).toHaveLength(1);
    }
  });

  it("@proof blocks a dynamic import whose specifier is not a plain literal", async () => {
    for (const source of ["`next/headers`", "specifier", '"next/" + "headers"']) {
      const findings = await lintFixture(
        "src/lib/x.ts",
        `declare const specifier: string;\nexport async function run() {\n  return import(${source});\n}\n`,
      );

      expect(findingsFor(findings, "no-restricted-syntax"), source).toHaveLength(1);
    }
  });

  it("stays quiet on imports that do not cross the boundary", async () => {
    for (const [file, specifier] of [
      ["src/lib/a/b/c/x.ts", "../../../db"],
      ["src/lib/a/x.ts", "@/lib/db"],
      ["src/worker/x.ts", "@prisma/client"],
      ["src/lib/x.ts", "node:path"],
      // Same-side paths that contain the words "app" or "server" but cross
      // nothing. The blunt `**/server/**` glob blocked every one of these.
      ["src/lib/x.ts", "./server/tokens"],
      ["src/lib/x.ts", "@/lib/server/tokens"],
      ["src/lib/x.ts", "@/lib/app/config"],
      ["src/lib/x.ts", "@trpc/server/adapters/fetch"],
      ["src/worker/a/x.ts", "../shared/queue"],
      // `..` present but not reaching app/server, and app/server present but
      // no `..` — the two halves the escape regex requires together.
      ["src/lib/a/x.ts", "../applications/list"],
      ["src/lib/x.ts", "./apps/list"],
    ] as const) {
      const findings = await lintFixture(
        file,
        `import thing from "${specifier}";\nexport const value = thing;\n`,
      );

      expect(findingsFor(findings, RULE), `${file} -> ${specifier}`).toHaveLength(0);
    }
  });

  it("does not restrict the app layer, which is allowed to use Next", async () => {
    const findings = await lintFixture(
      "src/app/x.ts",
      'import { headers } from "next/headers";\nexport const read = headers;\n',
    );

    expect(findingsFor(findings, RULE)).toHaveLength(0);
  });

  it("keeps the boundary rules on the retention job, which is only exempt from the delete ban", async () => {
    const findings = await lintFixture(
      "src/lib/jobs/retention.ts",
      'export async function run() {\n  return import("next/headers");\n}\n',
    );

    expect(findingsFor(findings, "no-restricted-syntax")).toHaveLength(1);
  });
});
