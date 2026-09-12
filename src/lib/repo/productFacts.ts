import type { PrismaClient, ProductFactsVersion } from "@prisma/client";

import { mutate } from "./mutate";

/**
 * The pointer from an org to the facts file it runs on (master doc §12, §25).
 *
 * `ProductFactsVersion` is `(orgId, product, version, hash)`, unique per org on
 * the first three. The file lives in the repository; the row says which
 * version this org has activated and what its bytes hashed to when it did. A
 * research pack or a draft that cites `version 1` can then be checked against
 * the file that was actually version 1 for that org, and a redeploy that
 * changed the file under the same version number is refused rather than
 * silently re-pointed.
 *
 * Idempotent: the first call for an org writes the row and one
 * `facts.activated` Event; every later call with the same hash is a read and
 * writes nothing. A different hash at the same version is the one thing this
 * function will not do, because there is no honest Event for "the facts changed
 * and nobody bumped the version".
 */

export class FactsHashMismatchError extends Error {
  constructor(
    readonly orgId: string,
    readonly product: string,
    readonly version: number,
    readonly pinned: string,
    readonly offered: string,
  ) {
    super(
      `facts: ${product} v${version} is pinned for this org at ${pinned.slice(0, 12)}… but the file on disk hashes to ${offered.slice(0, 12)}… — bump the version, do not edit a version in place`,
    );
    this.name = "FactsHashMismatchError";
  }
}

export type EnsureFactsVersionInput = {
  orgId: string;
  product: string;
  version: number;
  hash: string;
  /** Named on the Event so a reviewer can see a run cited an unsigned file. */
  draft: boolean;
};

export type EnsureFactsVersionResult = { row: ProductFactsVersion; created: boolean };

export async function ensureFactsVersion(
  db: PrismaClient,
  input: EnsureFactsVersionInput,
): Promise<EnsureFactsVersionResult> {
  const existing = await db.productFactsVersion.findUnique({
    where: { orgId_product_version: { orgId: input.orgId, product: input.product, version: input.version } },
  });
  if (existing !== null) {
    if (existing.hash !== input.hash) {
      throw new FactsHashMismatchError(input.orgId, input.product, input.version, existing.hash, input.hash);
    }
    return { row: existing, created: false };
  }
  const row = await mutate(db, {
    orgId: input.orgId,
    actor: { kind: "system" },
    kind: "facts.activated",
    after: { product: input.product, version: input.version, hash: input.hash, draft: input.draft },
    apply: async (tx) => {
      // Two workers activating the same version at once: the unique index
      // decides, and the loser's transaction rolls back its Event with it.
      return tx.productFactsVersion.create({
        data: { orgId: input.orgId, product: input.product, version: input.version, hash: input.hash },
      });
    },
  });
  return { row, created: true };
}
