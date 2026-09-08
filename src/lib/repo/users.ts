import { type PrismaClient, type Role, type User } from "@prisma/client";

import { mutate } from "./mutate";

/**
 * The three writes sign-in makes.
 *
 * They live here, and not in `src/server/auth/`, for the reason the write ban
 * exists: `src/lib/repo/**` is the only place a Prisma write is legal, because
 * `mutate` is the only place a transaction is opened (master doc §25, rule 4).
 * A caller passing `apply` from outside this directory would trip the lint on
 * its own `tx.user.create`, and disabling the rule per call site is how a write
 * path stops being one.
 *
 * Nothing here knows about Clerk. It takes a plain identity and returns a row;
 * `src/server/auth/upsertUser.ts` decides which of the three applies.
 */

/** The identity a signed-in person carries, normalised. */
export type UserIdentity = {
  /** Null for the local `DEV_USER_EMAIL` bypass, which Clerk has never seen. */
  clerkId: string | null;
  /** Lower-cased. `@@unique([orgId, email])` is a byte comparison in Postgres. */
  email: string;
  name: string | null;
};

/**
 * Create the org and its first user, together, in one transaction.
 *
 * One Event, not two. `mutate` writes exactly one Event per transaction, and
 * splitting this into an `org.created` call followed by a `user.upserted` one
 * would put the org's creation and its only admin in separate transactions —
 * so a failure between them leaves an org with no users, which is precisely
 * the state "the first user of an org is its admin" cannot recover from. The
 * two rows are one act, and `after` records both.
 *
 * The org id is the caller's, not a cuid: it is derived from the email domain,
 * so the primary key itself is what stops two concurrent first sign-ins from
 * creating two orgs. The loser gets a unique violation and re-reads.
 */
export async function createOrgWithFirstUser(
  db: PrismaClient,
  input: { orgId: string; orgName: string; user: UserIdentity },
): Promise<User> {
  const { orgId, orgName, user } = input;

  return mutate(db, {
    orgId,
    // The user does not exist yet, so there is no `actorUserId` to name. The
    // sign-in machinery made this, not a person acting inside the product.
    actor: { kind: "system" },
    kind: "org.created",
    after: {
      org: { id: orgId, name: orgName },
      user: { email: user.email, role: "admin" },
    },
    apply: async (tx) => {
      await tx.org.create({ data: { id: orgId, name: orgName } });
      return tx.user.create({
        data: {
          orgId,
          clerkId: user.clerkId,
          email: user.email,
          name: user.name,
          // The first user of an org is its admin: somebody has to be able to
          // onboard the reps (master doc §8, "the admin onboards reps"), and
          // on a self-serve first sign-in there is nobody else to do it.
          role: "admin",
        },
      });
    },
  });
}

/** Add a user to an org that already has one. Everyone after the first is a rep. */
export async function createUserInOrg(
  db: PrismaClient,
  input: { orgId: string; user: UserIdentity; role: Role },
): Promise<User> {
  const { orgId, user, role } = input;

  return mutate(db, {
    orgId,
    actor: { kind: "system" },
    kind: "user.upserted",
    after: { email: user.email, role },
    apply: (tx) =>
      tx.user.create({
        data: { orgId, clerkId: user.clerkId, email: user.email, name: user.name, role },
      }),
  });
}

/**
 * Link a user row to the provider account that just signed in as it: the first
 * real Clerk sign-in of a user the local bypass created.
 *
 * `clerkId` is the only field it can write, and only over a null. Re-pointing
 * a user row at a different Clerk account is how one person signs in as
 * another, so this function cannot express it: the condition is in the SQL,
 * not only in the caller.
 */
export async function linkClerkId(
  db: PrismaClient,
  input: { orgId: string; userId: string; clerkId: string },
): Promise<User> {
  const { orgId, userId, clerkId } = input;

  return mutate(db, {
    orgId,
    actor: { kind: "user", userId },
    kind: "user.upserted",
    before: { clerkId: null },
    after: { clerkId },
    // `clerkId: null` is in the `where`, not only in the caller's check. The
    // caller reads the row and then writes it, and between those two a second
    // request can claim the same row; with the condition in the statement the
    // loser matches no rows and Prisma raises P2025 rather than quietly
    // re-pointing a user at a different sign-in account.
    // `AND`, because `clerkId` at the top level of a `WhereUniqueInput` is the
    // unique selector and is typed as the string itself; the filter form is
    // how "and it is still null" is expressed.
    apply: (tx) => tx.user.update({ where: { id: userId, AND: { clerkId: null } }, data: { clerkId } }),
  });
}
