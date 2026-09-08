import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { authCopy } from "@/lib/copy/auth";
import { prisma } from "@/lib/db";
import { MACHINE_WORDS } from "@/lib/copy/plainWords";
import {
  adminProcedure,
  createTRPCContext,
  createTRPCRouter,
  publicProcedure,
  repProcedure,
  type TRPCContext,
} from "@/server/api/trpc";
import {
  displayName,
  getSession,
  primaryEmail,
  profileFromClerkUser,
  type Session,
} from "@/server/auth/session";
import {
  ensureUser,
  emailDomain,
  isSharedEmailDomain,
  normaliseEmail,
  orgIdForDomain,
  type Actor,
} from "@/server/auth/upsertUser";

import { emptyAll, resetDatabase } from "../db/harness";

/**
 * `@clerk/nextjs/server` refuses to load outside a React Server Component, so
 * the module cannot even be imported here. Both functions are stubbed to
 * "nobody is signed in" — which is exactly the state the two cases below need,
 * because the bypass answers before either is called and the second case is
 * about a request with no Clerk session at all. Nothing that decides who may
 * do what is mocked: `getSession`, `createTRPCContext`, `ensureUser`, both
 * procedure builders and the database are all the real ones.
 */
vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: null }),
  currentUser: async () => null,
}));

/**
 * Sign-in and the two roles, without an identity provider anywhere near it.
 *
 * The session is the seam: `getSession()` is the only function that talks to
 * Clerk, and everything downstream of it takes a plain `{clerkId, email, name}`.
 * So these build one and drive the real procedure builders and the real
 * database — the network is the only thing mocked out, and the parts that
 * decide who may do what are not.
 */

beforeAll(async () => {
  await resetDatabase();
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await emptyAll();
});

/**
 * The live environment, as a writable record.
 *
 * A function and not a captured constant, and that matters: the `afterEach`
 * hooks below restore by replacing `process.env` wholesale, so a reference
 * taken once at module load points at an object nothing reads any more, and
 * every assignment through it silently does nothing. `@types/node` types
 * `NODE_ENV` read-only, which is exactly the variable these cases move, so the
 * cast is here rather than at each site.
 */
function environment(): Record<string, string | undefined> {
  return process.env as Record<string, string | undefined>;
}

/** A context as `createTRPCContext` would build it, for a given session. */
function contextFor(session: Session | null): TRPCContext {
  let pending: Promise<Actor> | undefined;
  return {
    prisma,
    headers: new Headers(),
    session,
    actor: () => {
      if (session === null) return Promise.reject(new Error("not signed in"));
      return (pending ??= ensureUser(prisma, session));
    },
  };
}

/** One procedure on each builder, reporting what the context resolved to. */
const router = createTRPCRouter({
  open: publicProcedure.query(() => "open"),
  mine: repProcedure.query(({ ctx }) => ({ orgId: ctx.orgId, userId: ctx.userId, role: ctx.role })),
  theirs: adminProcedure.query(({ ctx }) => ({ orgId: ctx.orgId, role: ctx.role })),
});

const caller = (session: Session | null) => router.createCaller(contextFor(session));

/**
 * A session, with a counter on the profile fetch.
 *
 * The count is the point of several cases below: `profile()` stands in for a
 * Clerk Backend API round trip, and the steady state has to make none.
 */
function sessionOf(
  clerkId: string | null,
  email: string | null,
  name: string | null = null,
): Session & { calls: () => number } {
  let calls = 0;
  return {
    clerkId,
    profile: async () => {
      calls += 1;
      return email === null ? null : { email, name };
    },
    calls: () => calls,
  };
}

const first = () => sessionOf("user_first", "Boss@Example.Test", "The Boss");
const second = () => sessionOf("user_second", "rep@example.test", "A Rep");

describe("placing a sign-in", () => {
  it("folds an address to one mailbox before it is used as a key", () => {
    expect(normaliseEmail("  Boss@Example.Test ")).toBe("boss@example.test");
    expect(emailDomain("boss@example.test")).toBe("example.test");
  });

  it("refuses an address it cannot take a domain from", () => {
    for (const bad of ["boss", "@example.test", "boss@"]) {
      expect(() => emailDomain(bad), bad).toThrow(/domain/);
    }
  });

  it("gives one domain one org id, and two domains two", () => {
    expect(orgIdForDomain("example.test")).toBe(orgIdForDomain("example.test"));
    expect(orgIdForDomain("example.test")).not.toBe(orgIdForDomain("other.test"));
  });
});

describe("first sign-in", () => {
  it("@proof creates the org and its admin, and records it", async () => {
    const actor = await ensureUser(prisma, first());

    const org = await prisma.org.findUniqueOrThrow({ where: { id: actor.orgId } });
    expect(org.name).toBe("example.test");

    const user = await prisma.user.findUniqueOrThrow({ where: { id: actor.userId } });
    expect(user.email).toBe("boss@example.test");
    expect(user.name).toBe("The Boss");
    expect(user.clerkId).toBe("user_first");
    // The first person through the door has to be able to onboard the rest
    // (master doc §8).
    expect(actor.role).toBe("admin");

    const events = await prisma.event.findMany({ where: { orgId: actor.orgId } });
    expect(events.map((event) => event.kind)).toEqual(["org.created"]);
  });

  it("@proof makes everyone after the first a rep", async () => {
    const admin = await ensureUser(prisma, first());
    const rep = await ensureUser(prisma, second());

    expect(rep.orgId).toBe(admin.orgId);
    expect(rep.role).toBe("rep");
    expect(rep.userId).not.toBe(admin.userId);

    const kinds = await prisma.event.findMany({
      where: { orgId: admin.orgId },
      orderBy: { createdAt: "asc" },
      select: { kind: true },
    });
    expect(kinds.map((event) => event.kind)).toEqual(["org.created", "user.upserted"]);
  });

  it("puts a different company in a different org", async () => {
    const ours = await ensureUser(prisma, first());
    const theirs = await ensureUser(prisma, sessionOf("user_other", "boss@other.test"));

    expect(theirs.orgId).not.toBe(ours.orgId);
    // And is the admin of their own, not a rep in ours.
    expect(theirs.role).toBe("admin");
  });

  it("@proof refuses a free mailbox provider, which is not a company", async () => {
    // The org is the email domain. Without this, everyone holding a gmail.com
    // address is a rep in whichever org the first gmail.com address created.
    for (const domain of ["gmail.com", "outlook.com", "icloud.com", "proton.me"]) {
      expect(isSharedEmailDomain(domain), domain).toBe(true);
      await expect(
        ensureUser(prisma, sessionOf(`user_${domain}`, `someone@${domain}`)),
        domain,
      ).rejects.toThrow(/work email/);
    }
    expect(await prisma.org.count()).toBe(0);
    expect(isSharedEmailDomain("example.test")).toBe(false);
  });

  it("@proof refuses a session the provider gives no address for", async () => {
    await expect(ensureUser(prisma, sessionOf("user_x", null))).rejects.toThrow(
      /no usable email/,
    );
    expect(await prisma.user.count()).toBe(0);
  });
});

describe("later sign-ins", () => {
  it("@proof writes nothing at all the second time", async () => {
    const actor = await ensureUser(prisma, first());
    const events = await prisma.event.count();
    const updatedAt = (await prisma.user.findUniqueOrThrow({ where: { id: actor.userId } }))
      .updatedAt;

    const again = await ensureUser(prisma, first());

    expect(again).toEqual(actor);
    expect(await prisma.event.count()).toBe(events);
    expect(await prisma.user.count()).toBe(1);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: actor.userId } })).updatedAt,
    ).toEqual(updatedAt);
  });

  it("@proof asks the provider who they are once, and never again", async () => {
    // `profile()` is a Clerk Backend API round trip. Making one per request —
    // which is what building it into the context would do — puts an HTTP call
    // on every procedure in the application, public ones included.
    const session = first();
    await ensureUser(prisma, session);
    expect(session.calls()).toBe(1);

    const again = first();
    await ensureUser(prisma, again);
    expect(again.calls()).toBe(0);
  });

  it("@proof leaves the stored name alone when the bypass signs in as the same person", async () => {
    const named = await ensureUser(prisma, first());
    // The bypass knows an address and no name. Writing that back would erase
    // the name Clerk gave, once per request.
    await ensureUser(prisma, sessionOf(null, "boss@example.test"));

    const user = await prisma.user.findUniqueOrThrow({ where: { id: named.userId } });
    expect(user.name).toBe("The Boss");
    expect(await prisma.event.count()).toBe(1);
  });

  it("@proof claims a bypass-created user on their first real sign-in", async () => {
    // The local bypass has no Clerk id, so the row it creates has none.
    const viaBypass = await ensureUser(prisma, sessionOf(null, "boss@example.test"));
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: viaBypass.userId } })).clerkId,
    ).toBeNull();

    const viaClerk = await ensureUser(prisma, first());

    // The same person, not a second one: the address found the row, and the
    // provider id was written onto it rather than a duplicate being created.
    expect(viaClerk.userId).toBe(viaBypass.userId);
    expect(await prisma.user.count()).toBe(1);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: viaBypass.userId } })).clerkId,
    ).toBe("user_first");
  });

  it("@proof refuses to re-point a user at a different sign-in account", async () => {
    await ensureUser(prisma, first());

    await expect(
      ensureUser(prisma, sessionOf("user_impostor", "boss@example.test")),
    ).rejects.toThrow(/different sign-in account/);

    // And the rep is told something an admin can act on, rather than being
    // sent to switch on an account that was never switched off.
    await expect(
      caller(sessionOf("user_impostor", "boss@example.test")).mine(),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: authCopy.addressAlreadyInUse });
  });
});

describe("concurrent first sign-ins", () => {
  it("@proof makes one org and one admin, not two", async () => {
    const people = Array.from({ length: 6 }, (_, i) =>
      sessionOf(`user_${i}`, `person${i}@example.test`),
    );

    const actors = await Promise.all(people.map((session) => ensureUser(prisma, session)));

    // One org, because the org id is derived from the domain and is the
    // primary key: the losers of the race collide and re-read.
    expect(new Set(actors.map((actor) => actor.orgId)).size).toBe(1);
    expect(await prisma.org.count()).toBe(1);
    expect(await prisma.user.count()).toBe(people.length);
    expect(actors.filter((actor) => actor.role === "admin")).toHaveLength(1);
  });
});

describe("the two roles", () => {
  it("@proof lets a rep through repProcedure and stops them at adminProcedure", async () => {
    await ensureUser(prisma, first());
    const rep = caller(second());

    await expect(rep.mine()).resolves.toMatchObject({ role: "rep" });
    await expect(rep.theirs()).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: authCopy.adminOnly,
    });
  });

  it("@proof lets the admin through both", async () => {
    const admin = caller(first());

    await expect(admin.mine()).resolves.toMatchObject({ role: "admin" });
    await expect(admin.theirs()).resolves.toMatchObject({ role: "admin" });
  });

  it("@proof refuses a signed-out caller everywhere but the public procedure", async () => {
    const nobody = caller(null);

    await expect(nobody.open()).resolves.toBe("open");
    for (const call of [nobody.mine(), nobody.theirs()]) {
      await expect(call).rejects.toMatchObject({
        code: "UNAUTHORIZED",
        message: authCopy.signedOut,
      });
    }
  });

  it("@proof puts the session's org on the context, and nothing from the caller", async () => {
    const admin = await ensureUser(prisma, first());
    const result = await caller(first()).mine();

    expect(result.orgId).toBe(admin.orgId);
    expect(result.userId).toBe(admin.userId);
  });

  it("@proof refuses a switched-off account without pretending it is signed out", async () => {
    const admin = await ensureUser(prisma, first());
    await prisma.$executeRaw`UPDATE users SET deactivated_at = now() WHERE id = ${admin.userId}`;

    await expect(caller(first()).mine()).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: authCopy.noLongerActive,
    });
  });

  it("says none of it in machine words", () => {
    for (const message of [authCopy.adminOnly, authCopy.signedOut, authCopy.noLongerActive]) {
      expect(MACHINE_WORDS.test(message), message).toBe(false);
    }
  });

  it("does not touch the database for a public procedure", async () => {
    // `actor()` is lazy, so an unauthenticated read never resolves one. If it
    // stopped being lazy this rejects instead of returning.
    const context = contextFor(null);
    await expect(router.createCaller(context).open()).resolves.toBe("open");
  });
});

describe("the local bypass", () => {
  const saved = { ...process.env };



  afterEach(() => {
    process.env = { ...saved };
  });

  it("@proof signs a request in only where the environment says development or test", async () => {
    const { devBypassEmail } = await import("@/lib/env");

    for (const NODE_ENV of ["development", "test"]) {
      environment().NODE_ENV = NODE_ENV;
      environment().DEV_USER_EMAIL = "rep@example.test";
      expect(devBypassEmail(), NODE_ENV).toBe("rep@example.test");
    }

    for (const NODE_ENV of ["production", "staging", "", undefined]) {
      if (NODE_ENV === undefined) delete environment().NODE_ENV;
      else environment().NODE_ENV = NODE_ENV;
      environment().DEV_USER_EMAIL = "rep@example.test";
      expect(devBypassEmail(), String(NODE_ENV)).toBeNull();
    }
  });

  it("@proof takes no part of the signed-in identity from a request header", async () => {
    // The brief's shape had the middleware hand the bypass rep to the context
    // in a request header. It was dropped: a header is client-supplied, and
    // one naming the user to sign in as is a forgery away from being an
    // authentication bypass. Both ends read the environment instead, so there
    // is nothing on the wire to forge — and this is what keeps it that way.
    const authSources = ["src/server/auth/session.ts", "src/server/auth/upsertUser.ts", "src/middleware.ts"];
    for (const file of authSources) {
      const source = readFileSync(path.resolve(import.meta.dirname, "..", "..", file), "utf8");
      expect(source, file).not.toMatch(/headers?\s*[.[]/i);
      expect(source.toLowerCase(), file).not.toContain("x-relay-dev-user");
    }

    // And behaviourally: a request carrying one is still nobody.
    environment().NODE_ENV = "production";
    delete environment().DEV_USER_EMAIL;
    const context = contextFor(null);
    context.headers.set("x-relay-dev-user", "boss@example.test");
    await expect(router.createCaller(context).mine()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});

describe("the real context factory, on the local bypass", () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  /**
   * The cases above build a context by hand, which is the only way to drive a
   * Clerk-backed session without an account. This one drives the factory the
   * application actually uses — `createTRPCContext` calling the real
   * `getSession()` — down the one path that needs no Clerk: the bypass. It is
   * what proves the hand-built context above is the same shape as the real one.
   */
  it("@proof signs the bypass rep in through getSession and createTRPCContext", async () => {
    environment().NODE_ENV = "development";
    environment().DEV_USER_EMAIL = "boss@example.test";

    const session = await getSession();
    expect(session).not.toBeNull();
    expect(session?.clerkId).toBeNull();
    expect(await session?.profile()).toEqual({ email: "boss@example.test", name: null });

    const context = (await createTRPCContext({
      req: new Request("https://relay.test/api/trpc/mine"),
      resHeaders: new Headers(),
      info: undefined,
    } as unknown as Parameters<typeof createTRPCContext>[0])) as TRPCContext;

    const result = await router.createCaller(context).mine();
    // First sign-in through the real factory: an org, and its admin.
    expect(result.role).toBe("admin");
    expect(await prisma.user.count()).toBe(1);
  });

  it("@proof is nobody when the environment does not permit the bypass", async () => {
    // The same `DEV_USER_EMAIL` that signed somebody in above. In an
    // environment that has not said it is a development or test one, it is
    // not a session at all, and the request falls through to Clerk — which,
    // here, has nobody signed in.
    environment().NODE_ENV = "production";
    environment().DEV_USER_EMAIL = "boss@example.test";

    expect(await getSession()).toBeNull();

    const context = (await createTRPCContext({
      req: new Request("https://relay.test/api/trpc/mine"),
      resHeaders: new Headers(),
      info: undefined,
    } as unknown as Parameters<typeof createTRPCContext>[0])) as TRPCContext;

    expect(context.session).toBeNull();
    await expect(router.createCaller(context).mine()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(await prisma.user.count()).toBe(0);
  });
});

describe("reading a Clerk user", () => {
  const base = {
    primaryEmailAddressId: null,
    emailAddresses: [] as Array<{
      id: string;
      emailAddress: string;
      verification: { status: string } | null;
    }>,
    firstName: null,
    lastName: null,
    username: null,
  };

  const verified = (id: string, emailAddress: string) => ({
    id,
    emailAddress,
    verification: { status: "verified" },
  });

  it("takes the address Clerk marks primary, not the first in the list", () => {
    expect(
      primaryEmail({
        ...base,
        primaryEmailAddressId: "id_2",
        emailAddresses: [
          verified("id_1", "personal@gmail.test"),
          verified("id_2", "boss@example.test"),
        ],
      }),
    ).toBe("boss@example.test");
  });

  it("@proof refuses to guess between two addresses with no primary", () => {
    // The org is derived from the domain, so guessing here would put the same
    // person in a different company on different requests.
    expect(
      primaryEmail({
        ...base,
        emailAddresses: [
          verified("id_1", "boss@example.test"),
          verified("id_2", "boss@other.test"),
        ],
      }),
    ).toBeNull();
    expect(
      profileFromClerkUser({
        ...base,
        emailAddresses: [
          verified("id_1", "boss@example.test"),
          verified("id_2", "boss@other.test"),
        ],
      }),
    ).toBeNull();
  });

  it("takes the only address when there is exactly one and no primary", () => {
    expect(
      primaryEmail({ ...base, emailAddresses: [verified("id_1", "solo@example.test")] }),
    ).toBe("solo@example.test");
  });

  it("@proof will not place a sign-in on an address Clerk has not verified", () => {
    // The org and the role come from the domain, so an unverified address is a
    // claim to be a member of whatever company it names — and, on an empty
    // org, to be its admin.
    const unverified = { id: "id_1", emailAddress: "boss@victimcorp.test", verification: null };
    expect(primaryEmail({ ...base, emailAddresses: [unverified] })).toBeNull();
    expect(
      primaryEmail({
        ...base,
        emailAddresses: [{ ...unverified, verification: { status: "unverified" } }],
      }),
    ).toBeNull();
    // Nor is an unverified primary silently fallen back from onto a verified
    // second address, which would place them somewhere they did not ask to be.
    expect(
      primaryEmail({
        ...base,
        primaryEmailAddressId: "id_1",
        emailAddresses: [unverified, verified("id_2", "someone@other.test")],
      }),
    ).toBeNull();
  });

  it("builds a name from the parts Clerk has, and falls back to the username", () => {
    expect(displayName({ ...base, firstName: "Ada", lastName: "Lovelace" })).toBe("Ada Lovelace");
    expect(displayName({ ...base, firstName: "Ada", lastName: "" })).toBe("Ada");
    expect(displayName({ ...base, username: "ada" })).toBe("ada");
    expect(displayName(base)).toBeNull();
  });
});
