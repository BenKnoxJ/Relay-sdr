import { auth, currentUser } from "@clerk/nextjs/server";

import { devBypassEmail } from "@/lib/env";

/**
 * Who is making this request, as far as the identity provider is concerned.
 *
 * This is the Clerk half of sign-in and nothing more: it says who arrived, not
 * what they may do. The org, the Relay user id and the role come from
 * `ensureUser`, which reads them out of the database — a role held in Clerk
 * metadata would be invisible to the worker (master doc §18), which runs
 * without Clerk and still has to know whose run it is executing.
 */

/** Email and display name, as the provider holds them. */
export type Profile = { email: string; name: string | null };

export type Session = {
  /** Null for the local `DEV_USER_EMAIL` bypass, which Clerk has never seen. */
  clerkId: string | null;
  /**
   * The rest of the identity, fetched on demand.
   *
   * Lazy, and that is the whole point of the shape. `currentUser()` is a
   * Clerk Backend API round trip, and calling it while building the context
   * would put one on every tRPC request — public procedures included — for a
   * value only the first sign-in of a given person needs. `ensureUser` looks
   * the user up by `clerkId` first and only reaches for this on a miss, so the
   * steady state is one indexed SELECT and no HTTP at all.
   *
   * Memoised by the builders below, so two callers in one request share one
   * round trip.
   */
  profile: () => Promise<Profile | null>;
};

/** The shape of `currentUser()` this module reads. Narrowed so tests can build one. */
type ClerkUserFields = {
  primaryEmailAddressId: string | null;
  emailAddresses: Array<{
    id: string;
    emailAddress: string;
    verification: { status: string } | null;
  }>;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
};

/**
 * An address Clerk has proved the holder controls.
 *
 * Load-bearing, not hygiene. The org and the role are derived from the email
 * domain, so an unverified address is a claim to be a member of whichever
 * company it names — and, if nobody from that company has signed in yet, a
 * claim to be its admin. Anyone can type anyone's domain into a sign-up form.
 */
function isVerified(address: { verification: { status: string } | null }): boolean {
  return address.verification?.status === "verified";
}

/**
 * The address Clerk marks primary, or the only one on the account.
 *
 * Not "the first in the list": the order is Clerk's, and picking arbitrarily
 * from a two-address account would place the same person in a different org
 * on different requests, because the org is derived from the domain. With no
 * primary and more than one verified address there is no defensible answer, so
 * there is no answer — the sign-in fails rather than guessing which tenant
 * they are in.
 *
 * Unverified addresses are not candidates at all. See `isVerified`.
 */
export function primaryEmail(user: ClerkUserFields): string | null {
  const { primaryEmailAddressId, emailAddresses } = user;
  const verified = emailAddresses.filter(isVerified);

  if (primaryEmailAddressId !== null) {
    const match = verified.find((address) => address.id === primaryEmailAddressId);
    if (match !== undefined) return match.emailAddress;
    // A primary that is not verified is not fallen back from: picking a
    // different address would place them somewhere they did not ask to be.
    if (emailAddresses.some((address) => address.id === primaryEmailAddressId)) return null;
  }
  if (verified.length === 1) return verified[0]?.emailAddress ?? null;
  return null;
}

/** A display name, or null. Clerk lets every part of it be empty. */
export function displayName(user: ClerkUserFields): string | null {
  const full = [user.firstName, user.lastName].filter((part) => part !== null && part !== "").join(" ");
  return full !== "" ? full : (user.username ?? null);
}

/** The profile a Clerk user makes, or null if it carries no usable email. */
export function profileFromClerkUser(user: ClerkUserFields): Profile | null {
  const email = primaryEmail(user);
  if (email === null) return null;
  return { email, name: displayName(user) };
}

/** Run `load` at most once, however many callers ask. */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => (pending ??= load());
}

/**
 * The session for the request in flight, or null when nobody is signed in.
 *
 * The bypass is checked before Clerk, not after: a developer running with
 * `DEV_USER_EMAIL` set has no Clerk keys at all, and calling `auth()` first
 * would fail the request before the bypass could answer it. `devBypassEmail`
 * is the one place that decides whether the bypass applies, shared with the
 * middleware so the two cannot disagree about whether a request is signed in.
 *
 * There is deliberately no header carrying the bypass rep from the middleware
 * to here. A request header is client-supplied, and one that names the user to
 * sign in as is a forgery away from being an authentication bypass; both ends
 * read the same environment instead, so there is nothing on the wire to forge.
 */
export async function getSession(): Promise<Session | null> {
  const bypass = devBypassEmail();
  if (bypass !== null) {
    return { clerkId: null, profile: async () => ({ email: bypass, name: null }) };
  }

  const { userId } = await auth();
  if (userId === null || userId === undefined) return null;

  return {
    clerkId: userId,
    profile: once(async () => {
      const user = await currentUser();
      return user === null ? null : profileFromClerkUser(user);
    }),
  };
}
