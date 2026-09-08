import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { shellCopy } from "@/lib/copy/shell";
import { prisma } from "@/lib/db";

// The suite uses the same client the application does, so `src/lib/db.ts` is
// genuinely the only `new PrismaClient()` in the repository and the test
// exercises the production wiring rather than a parallel one of its own —
// including its `datasourceUrl`, so this also proves the client connects on
// the value `env()` validated rather than on schema.prisma's own env read.

afterAll(async () => {
  await prisma.$disconnect();
});

describe("scaffold", () => {
  it("@proof reaches the test database over the connection string env.ts parsed", async () => {
    const rows = await prisma.$queryRaw<Array<{ one: number }>>`SELECT 1 AS one`;
    expect(rows[0]?.one).toBe(1);
  });

  it("runs against a database whose name ends in _test", () => {
    const database = new URL(process.env.DATABASE_URL ?? "").pathname.slice(1);
    expect(database.endsWith("_test")).toBe(true);
  });

  it("keeps on-screen strings in the copy file", () => {
    expect(shellCopy.appName).toBe("Relay");
  });

  // The claim in CLAUDE.md is checkable, so check it rather than trusting it.
  it("@proof instantiates PrismaClient in exactly one file", () => {
    const root = path.resolve(import.meta.dirname, "..", "src");

    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return /\.tsx?$/.test(entry.name) ? [full] : [];
      });

    const offenders = walk(root)
      .filter((file) => /new\s+PrismaClient\s*\(/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(root, file));

    expect(offenders).toEqual(["lib/db.ts"]);
  });

  // Same claim, same treatment: `src/lib/env.ts` says nothing else touches
  // `process.env`, and an unvalidated read is exactly the drift it exists to
  // stop. Comments and doc lines are stripped first so the file's own prose
  // about the rule does not count as a breach of it.
  it("@proof reads process.env in exactly one file", () => {
    const root = path.resolve(import.meta.dirname, "..", "src");

    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return /\.tsx?$/.test(entry.name) ? [full] : [];
      });

    // String literals go first. Otherwise `fetch("https://…", { headers: { x:
    // process.env.Y } })` — the shape every integration will have — reads as a
    // line comment from the `//` in the url onwards, and the breach after it
    // is stripped along with the "comment".
    const code = (file: string): string =>
      readFileSync(file, "utf8")
        .replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, '""')
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");

    const offenders = walk(root)
      .filter((file) => /process\.env\b/.test(code(file)))
      .map((file) => path.relative(root, file));

    expect(offenders).toEqual(["lib/env.ts"]);
  });
});
