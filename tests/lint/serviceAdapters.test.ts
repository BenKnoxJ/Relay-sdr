/**
 * "An integration adapter never touches the database" is the sentence at the
 * top of `src/lib/services/types.ts`, and a sentence is not an invariant. These
 * are what make it one.
 *
 * It matters because of what the adapters hold: a live Graph client rotates a
 * refresh token mid-request, and the obvious next line is to write it back. The
 * moment one does, `mutate()` stops being the only writer and a state change
 * commits without its Event (§25, rule 4). The token goes out through a
 * callback instead — see `ServicesDeps` in `src/lib/services/index.ts`.
 */
import { describe, expect, it } from "vitest";

import { findingsFor, lintFixture } from "./lintFixture";

const RULE = "no-restricted-imports";

const ADAPTER = "src/lib/services/graphMail/live.ts";
/** Same layer, no adapter ban: proves the finding comes from the path, not the code. */
const ELSEWHERE = "src/lib/jobs/queue.ts";

function source(specifier: string): string {
  return `import thing from "${specifier}";\nexport const value = thing;\n`;
}

describe("adapters have no database access", () => {
  it("@proof blocks the database and repository modules by their aliased paths", async () => {
    for (const specifier of ["@/lib/db", "@/lib/repo", "@/lib/repo/users", "@prisma/client"]) {
      const findings = await lintFixture(ADAPTER, source(specifier));
      expect(findingsFor(findings, RULE), specifier).toHaveLength(1);
    }
  });

  it("@proof blocks the same modules reached relatively, at any depth", async () => {
    for (const [file, specifier] of [
      ["src/lib/services/x.ts", "../db"],
      ["src/lib/services/zoho/live.ts", "../../db"],
      ["src/lib/services/zoho/live.ts", "../../repo/users"],
      ["src/lib/services/a/b/c/x.ts", "../../../../db"],
      ["src/lib/services/zoho/live.ts", "./../../db"],
    ] as const) {
      const findings = await lintFixture(file, source(specifier));
      expect(findingsFor(findings, RULE), `${file} -> ${specifier}`).toHaveLength(1);
    }
  });

  it("@proof leaves the same imports alone outside the adapters", async () => {
    // `src/lib/jobs/queue.ts` is a legitimate database writer. If it were caught
    // here the rule would be matching the code rather than the layer, and the
    // test above would prove nothing.
    for (const specifier of ["@/lib/db", "@prisma/client"]) {
      const findings = await lintFixture(ELSEWHERE, source(specifier));
      expect(findingsFor(findings, RULE), specifier).toHaveLength(0);
    }
  });

  it("@proof blocks the database reached by dynamic import or require", async () => {
    // `no-restricted-imports` only visits static nodes, so `await import(...)`
    // needs its own selector or the ban above is not the "total" thing its
    // comment claims.
    for (const code of [
      'export const db = await import("@/lib/db");',
      'export const db = await import("../../db");',
      'export const m = await import("@/lib/repo/mutate");',
      'export const p = await import("@prisma/client");',
      'const r = require("@/lib/db");\nexport const db = r;',
    ]) {
      const findings = await lintFixture(ADAPTER, code);
      expect(findingsFor(findings, "no-restricted-syntax"), code).not.toHaveLength(0);
    }
  });

  it("@proof still blocks Next and Clerk inside the adapters", async () => {
    // Flat config replaces a rule's options rather than merging them, so the
    // adapter block has to restate the boundary patterns. If it ever stops
    // doing so, this is the test that says which invariant was traded for the
    // other.
    for (const specifier of ["next", "next/headers", "@clerk/nextjs", "@/server/api/root", "node:module"]) {
      const findings = await lintFixture(ADAPTER, source(specifier));
      expect(findingsFor(findings, RULE), specifier).toHaveLength(1);
    }
  });

  it("@proof leaves an adapter's own imports alone", async () => {
    for (const specifier of ["zod", "@/lib/env", "../crypto", "../types", "./live", "node:crypto"]) {
      const findings = await lintFixture(ADAPTER, source(specifier));
      expect(findingsFor(findings, RULE), specifier).toHaveLength(0);
    }
  });

  it("@proof reports the real adapter sources as clean", async () => {
    // The rule is only worth having if the code it guards passes it. This is
    // also what catches a widening of the pattern that starts matching
    // `../types` or `@/lib/env`.
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const root = path.resolve(import.meta.dirname, "..", "..");
    for (const file of [
      "src/lib/services/index.ts",
      "src/lib/services/types.ts",
      "src/lib/services/graphMail/live.ts",
      "src/lib/services/graphMail/mock.ts",
      "src/lib/services/graphMail/auth.ts",
      "src/lib/services/zoho/live.ts",
      "src/lib/services/zoho/mock.ts",
    ]) {
      const code = await readFile(path.join(root, file), "utf8");
      const findings = await lintFixture(file, code);
      expect(findings, `${file}: ${JSON.stringify(findings)}`).toEqual([]);
    }
  });
});
