import { createHash } from "node:crypto";

import { Prisma, type PrismaClient, type Role, type User } from "@prisma/client";

import {
  createOrgWithFirstUser,
  createUserInOrg,
  linkClerkId,
  type UserIdentity,
} from "@/lib/repo/users";

import { type Session } from "./session";

/**
 * First sign-in: place the person in an org, give them a role, and hand the
 * caller back the three values every request is authorised against.
 *
 * Reads live here; the writes are in `src/lib/repo/users.ts`, because that is
 * the only directory a Prisma write is legal in (master doc §25, rule 4).
 */

/** What every authorised request is scoped and checked against. */
export type Actor = { orgId: string; userId: string; role: Role };

/** The account exists and has been switched off. Not a sign-in failure. */
export class DeactivatedUserError extends Error {
  constructor(readonly userId: string) {
    super(`user ${userId} is deactivated`);
    this.name = "DeactivatedUserError";
  }
}

/**
 * The email already belongs to a different provider account in this org.
 * Re-pointing the row would sign one person in as another, so it is refused.
 */
export class IdentityConflictError extends Error {
  constructor(readonly userId: string) {
    super(`user ${userId} is already linked to a different sign-in account`);
    this.name = "IdentityConflictError";
  }
}

/** Signed in at the provider, but carrying nothing Relay can place them by. */
export class UnplaceableSessionError extends Error {
  constructor(reason: string) {
    super(`cannot place this sign-in: ${reason}`);
    this.name = "UnplaceableSessionError";
  }
}

/**
 * Domains that are one mailbox provider rather than one company.
 *
 * The org is derived from the email domain, so without this the holder of any
 * `gmail.com` address is a member of the org the first `gmail.com` address
 * created — a stranger with `ctx.orgId` over somebody else's pipeline. A
 * corporate domain is a company; a free provider's is not, and there is no way
 * to tell the two apart except by naming the providers.
 *
 * It is a list, so it is incomplete by construction: a small shared domain
 * nobody wrote down still joins as a rep. That is the residual risk in
 * self-serve joining at all, and the reason the model itself — self-serve
 * versus the admin onboarding each rep, which is what master doc §8 actually
 * describes — is flagged for a decision rather than settled here.
 */
const SHARED_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "yahoo.co.uk",
  "ymail.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "yandex.ru",
  "qq.com",
  "163.com",
  "126.com",
  "naver.com",
  "hey.com",
  "fastmail.com",
  "tutanota.com",
  "tuta.io",
  "duck.com",
]);

/** Is this domain one company, or one mailbox provider? */
export function isSharedEmailDomain(domain: string): boolean {
  return SHARED_EMAIL_DOMAINS.has(domain);
}

/**
 * Everything below compares emails as bytes, because Postgres does: the
 * `@@unique([orgId, email])` on `users` would hold `Ben@x.test` and `ben@x.test`
 * as two people in one org. Every real provider treats the two as one mailbox,
 * so they are folded to one here, once, at the edge.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** The domain half of a normalised address. */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) {
    throw new UnplaceableSessionError("the address has no domain");
  }
  return email.slice(at + 1);
}

/**
 * The org id for a domain, derived rather than looked up.
 *
 * `orgs` has one column that is unique — its primary key — and no `domain`
 * column to add one to without a migration this task does not carry. Deriving
 * the id from the domain makes the primary key itself the constraint: two
 * people from the same company signing in for the first time at the same
 * moment cannot create two orgs, because the second insert collides and the
 * caller re-reads. A `@@unique` on `orgs.name` would say the same thing more
 * plainly and is the follow-up if the derived id proves awkward; it needs a
 * migration, which this task was scoped without.
 *
 * The cost is that org ids are not cuids, the same wart `jobs` carries for the
 * same kind of reason (Task 4). It is one row per tenant, and it reads as what
 * it is.
 */
export function orgIdForDomain(domain: string): string {
  return `org_${createHash("sha256").update(domain).digest("hex").slice(0, 24)}`;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function actorOf(user: User): Actor {
  if (user.deactivatedAt !== null) throw new DeactivatedUserError(user.id);
  return { orgId: user.orgId, userId: user.id, role: user.role };
}

/**
 * The person behind `session`, creating them and their org if this is the
 * first time anyone has seen them.
 *
 * Idempotent by design: the common path is one indexed read and no write at
 * all, so this is safe to call on every request rather than only at sign-in —
 * which matters, because Relay has no Clerk webhook and no post-sign-in
 * callback to hang it off.
 */
export async function ensureUser(db: PrismaClient, session: Session): Promise<Actor> {
  return resolve(db, session, true);
}

async function resolve(db: PrismaClient, session: Session, mayRetry: boolean): Promise<Actor> {
  // The provider's own id first, and on its own: this is the steady-state path
  // for every request after the first, and it must cost one indexed read and
  // no HTTP. Reaching for `session.profile()` here would put a Clerk Backend
  // API round trip on every request in the application.
  if (session.clerkId !== null) {
    const found = await db.user.findUnique({ where: { clerkId: session.clerkId } });
    if (found !== null) return actorOf(found);
  }

  // Only now, having established this is somebody Relay has not seen, is the
  // provider worth asking who they are.
  const profile = await session.profile();
  if (profile === null) {
    throw new UnplaceableSessionError("the provider returned no usable email address");
  }

  const email = normaliseEmail(profile.email);
  const domain = emailDomain(email);
  if (isSharedEmailDomain(domain)) {
    // A free provider's domain is not a company. Letting one through would put
    // every holder of an address there in the same org.
    throw new UnplaceableSessionError("a work email address is required");
  }
  const orgId = orgIdForDomain(domain);
  const identity: UserIdentity = { clerkId: session.clerkId, email, name: profile.name };

  // Then the address, which is how the local bypass finds its user, and how a
  // bypass-created row is claimed by its owner's first real Clerk sign-in.
  const byEmail = await db.user.findUnique({ where: { orgId_email: { orgId, email } } });
  if (byEmail !== null) {
    if (byEmail.clerkId !== null && session.clerkId !== null && byEmail.clerkId !== session.clerkId) {
      throw new IdentityConflictError(byEmail.id);
    }
    // Deactivated is decided before anything is written. A switched-off
    // account that gets its `clerkId` linked and an Event recorded on the way
    // to being refused has been changed by a request it rejected.
    if (byEmail.deactivatedAt !== null) throw new DeactivatedUserError(byEmail.id);

    // The one field ever written to an existing row from here, and only ever
    // from null. Email and name are deliberately not synced back: the row is
    // Relay's record, and overwriting a stored name with whatever the provider
    // happens to hold — `null`, in the bypass's case — is a write per request
    // that loses information. Following a change at Clerk needs a webhook, and
    // is its own task.
    if (byEmail.clerkId === null && session.clerkId !== null) {
      try {
        return actorOf(
          await linkClerkId(db, {
            orgId: byEmail.orgId,
            userId: byEmail.id,
            clerkId: session.clerkId,
          }),
        );
      } catch (error) {
        // `linkClerkId` matches on `clerkId: null`, so a row claimed by
        // another request between the read above and this write matches
        // nothing and Prisma reports P2025. The check above was a read and
        // this is the enforcement: without it the second claim would win and
        // silently re-point somebody else's row.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
          throw new IdentityConflictError(byEmail.id);
        }
        throw error;
      }
    }
    return actorOf(byEmail);
  }

  try {
    const org = await db.org.findUnique({ where: { id: orgId } });
    const created =
      org === null
        ? await createOrgWithFirstUser(db, { orgId, orgName: domain, user: identity })
        : // Everyone after the first is a rep. There is no window where an org
          // exists with no users to miscount: the org and its admin are made in
          // one transaction.
          await createUserInOrg(db, { orgId, user: identity, role: "rep" });
    return actorOf(created);
  } catch (error) {
    // Somebody else got there first, between the reads above and this insert:
    // the org's primary key, `users.clerk_id` or `users(org_id, email)`. The
    // catch is outside the transaction `mutate` opened, so unlike a catch
    // inside one it can actually run — and what it does is start again, which
    // now takes the "already exists" path and, for a second person from the
    // same company, correctly makes them a rep rather than a second admin.
    if (mayRetry && isUniqueViolation(error)) return resolve(db, session, false);
    throw error;
  }
}
