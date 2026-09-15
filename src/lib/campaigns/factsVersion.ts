import type { PrismaClient } from "@prisma/client";

/**
 * The facts version Start names beside the product (§23.1d, "Facts updated
 * 11 Sep, version 2").
 *
 * Read, never guessed. `ProductFactsVersion` is the org's pointer to the facts
 * file it runs on (`src/lib/repo/productFacts.ts`); the highest version for
 * the org and product is the active one, and `activatedAt` is when it was
 * pinned. Start used to carry a date and a version as literals in
 * `PRODUCTS`, which was a fact on the screen that was true of nothing; now a
 * product with no activated facts says so (`startCopy.factsNone`).
 *
 * `db` is a parameter and not the module's own import so the query can run
 * in a test against whatever client the test holds, and so this file stays
 * free of Next: it is `src/lib`, and the worker may one day need the same
 * answer.
 */
export type ActiveFactsVersion = {
  version: number;
  /** The day it was pinned, already in rep words ("Thu 11 Sep"). */
  activatedOn: string;
};

/**
 * The latest activated facts version for an org's product, or null when none
 * has been activated. Read-only.
 *
 * `label` turns the row's `activatedAt` into the words Start shows. It is a
 * parameter rather than an import of `dateLabel` so this module has no
 * opinion about the format and the page's own helper decides.
 */
export async function activeFactsVersion(
  db: Pick<PrismaClient, "productFactsVersion">,
  orgId: string,
  product: string,
  label: (activatedAt: Date) => string,
): Promise<ActiveFactsVersion | null> {
  const row = await db.productFactsVersion.findFirst({
    where: { orgId, product },
    orderBy: { version: "desc" },
    select: { version: true, activatedAt: true },
  });
  if (row === null) return null;
  return { version: row.version, activatedOn: label(row.activatedAt) };
}
