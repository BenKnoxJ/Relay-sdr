import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";

import { shellCopy } from "@/lib/copy/shell";

const prisma = new PrismaClient();

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
});
