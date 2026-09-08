import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The worker's JSON error contract rests on one property of its source, and
 * nothing but a comment guarded it: `src/lib/db.ts` reads the environment as
 * it loads, so a misconfigured worker throws during that module's evaluation.
 * Inside `main()` — behind `await import()` — the throw lands in `main().catch`
 * and comes out as `event: "failed"`. Hoisted to a static top-level import it
 * evaluates before the handler is registered and comes out as a raw stack
 * trace, which is exactly the regression this repository already made once.
 */
const source = readFileSync(
  path.resolve(import.meta.dirname, "..", "..", "src", "worker", "main.ts"),
  "utf8",
);

describe("worker entry point", () => {
  it("@proof never statically imports the database module", () => {
    // `import type` is erased before the module runs, so it cannot throw.
    const staticImports = [...source.matchAll(/^import\s+(?!type\b)[\s\S]*?from\s+"([^"]+)";/gm)]
      .map((match) => match[1])
      .filter((specifier) => specifier !== undefined);

    expect(staticImports).not.toContain("@/lib/db");
  });

  it("@proof loads the database module dynamically", () => {
    expect(source).toMatch(/await import\("@\/lib\/db"\)/);
  });
});
