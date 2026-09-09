import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db";
import { mutate } from "@/lib/repo/mutate";
import { ensureFactsVersion, FactsHashMismatchError } from "@/lib/repo/productFacts";

import { emptyAll, resetDatabase } from "../db/harness";

/**
 * The org's pointer to its facts file: written once, read after, never
 * re-pointed in place.
 */

const ORG_A = "org_facts_a";
const ORG_B = "org_facts_b";
const HASH = "a".repeat(64);
const OTHER = "b".repeat(64);

beforeAll(async () => {
  await resetDatabase();
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await emptyAll();
  for (const orgId of [ORG_A, ORG_B]) {
    await mutate(prisma, {
      orgId,
      actor: { kind: "system" },
      kind: "org.created",
      apply: (tx) => tx.org.create({ data: { id: orgId, name: orgId } }),
    });
  }
});

describe("ensureFactsVersion", () => {
  it("writes the row and one Event the first time, and nothing the second", async () => {
    const eventsBefore = await prisma.event.count();
    const first = await ensureFactsVersion(prisma, { orgId: ORG_A, product: "insights360", version: 1, hash: HASH, draft: true });
    expect(first.created).toBe(true);
    expect(first.row).toMatchObject({ orgId: ORG_A, product: "insights360", version: 1, hash: HASH });
    const activated = await prisma.event.findFirst({ where: { orgId: ORG_A, kind: "facts.activated" } });
    expect(activated?.after).toMatchObject({ product: "insights360", version: 1, hash: HASH, draft: true });

    const second = await ensureFactsVersion(prisma, { orgId: ORG_A, product: "insights360", version: 1, hash: HASH, draft: true });
    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(await prisma.event.count()).toBe(eventsBefore + 1);
  });

  it("refuses a different hash at the same version, and writes nothing", async () => {
    await ensureFactsVersion(prisma, { orgId: ORG_A, product: "insights360", version: 1, hash: HASH, draft: true });
    const eventsBefore = await prisma.event.count();
    await expect(
      ensureFactsVersion(prisma, { orgId: ORG_A, product: "insights360", version: 1, hash: OTHER, draft: false }),
    ).rejects.toBeInstanceOf(FactsHashMismatchError);
    expect(await prisma.event.count()).toBe(eventsBefore);
    // The next version is a new pointer, not an edit.
    const next = await ensureFactsVersion(prisma, { orgId: ORG_A, product: "insights360", version: 2, hash: OTHER, draft: false });
    expect(next.created).toBe(true);
  });

  it("is scoped to the org: two orgs each pin their own version 1", async () => {
    await ensureFactsVersion(prisma, { orgId: ORG_A, product: "insights360", version: 1, hash: HASH, draft: true });
    const other = await ensureFactsVersion(prisma, { orgId: ORG_B, product: "insights360", version: 1, hash: OTHER, draft: true });
    expect(other.created).toBe(true);
    expect(await prisma.productFactsVersion.count()).toBe(2);
  });
});
