import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { shellCopy } from "@/lib/copy/shell";
import { prisma } from "@/lib/db";

// The suite uses the same client the application does, so `src/lib/db.ts` is
// genuinely the only `new PrismaClient()` in the repository and the test
// exercises the production wiring rather than a parallel one of its own.

afterAll(async () => {
  await prisma.$disconnect();
});

describe("scaffold", () => {
  it("@proof reaches the test database over the datasource in schema.prisma", async () => {
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
});
