import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { authCopy } from "@/lib/copy/auth";
import { prisma } from "@/lib/db";
import { appRouter } from "@/server/api/root";
import { isRefusal } from "@/server/api/caller";
import { type TRPCContext } from "@/server/api/trpc";
import { type Session } from "@/server/auth/session";
import { ensureUser, type Actor } from "@/server/auth/upsertUser";

import { emptyAll, resetDatabase } from "../db/harness";
import { startInput } from "../lib/campaignPacks";

/** Same reason as `tests/api/auth.test.ts`: the module will not load outside an RSC. */
vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: null }),
  currentUser: async () => null,
}));

/**
 * What the shell asks for, and what it is allowed to be told.
 *
 * `me.get` is the only thing standing between a signed-in page and the row it
 * renders a name and a role out of, so these drive the real router against the
 * real database with only the identity provider stubbed out — the same seam
 * `tests/api/auth.test.ts` uses.
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

const caller = (session: Session | null) => appRouter.createCaller(contextFor(session));

function sessionOf(clerkId: string, email: string, name: string | null = null): Session {
  return { clerkId, profile: async () => ({ email, name }) };
}

const boss = () => sessionOf("user_boss", "boss@example.test", "The Boss");
const rep = () => sessionOf("user_rep", "rep@example.test", "A Rep");

describe("me.get", () => {
  it("@proof refuses a caller with no session", async () => {
    await expect(caller(null).me.get()).rejects.toThrow(authCopy.signedOut);
  });

  it("tells the shell who is signed in, and their role", async () => {
    await ensureUser(prisma, boss());
    const me = await caller(boss()).me.get();

    expect(me).toMatchObject({
      email: "boss@example.test",
      name: "The Boss",
      role: "admin",
      // The org is named for the domain it was derived from (Task 8).
      orgName: "example.test",
    });
  });

  it("calls everyone after the first a rep, which is what the nav reads", async () => {
    await ensureUser(prisma, boss());
    await ensureUser(prisma, rep());

    expect((await caller(rep()).me.get()).role).toBe("rep");
  });

  /**
   * Both are constants today and both are typed as what they will be: the
   * first campaign arrives with slice 1 and the mailbox connection with Task
   * 10b. They are here so the shell reads one shape now and the same shape
   * then, rather than growing a second source when the data lands.
   */
  it("reports no campaign and nothing connected, on day one", async () => {
    await ensureUser(prisma, boss());
    const me = await caller(boss()).me.get();

    expect(me.hasCampaign).toBe(false);
    expect(me.connections).toEqual({ mailbox: false, zoho: false });
  });

  it("@proof answers about the caller, never about anyone else", async () => {
    await ensureUser(prisma, boss());
    await ensureUser(prisma, rep());

    expect((await caller(rep()).me.get()).email).toBe("rep@example.test");
    expect((await caller(boss()).me.get()).email).toBe("boss@example.test");
  });
});

/**
 * The shell shows a refused rep the message on the error, so what counts as a
 * refusal decides what can reach a screen. tRPC wraps everything a procedure
 * throws, so the type alone cannot answer it.
 */
describe("isRefusal", () => {
  it("@proof accepts the two codes a procedure refuses with", async () => {
    const refused = await caller(null)
      .me.get()
      .then(() => null)
      .catch((error: unknown) => error);

    expect(isRefusal(refused)).toBe(true);
    expect((refused as TRPCError).message).toBe(authCopy.signedOut);
  });

  it("@proof refuses a fault, whatever tRPC wrapped it in", () => {
    // What a database outage looks like by the time it reaches the shell.
    expect(
      isRefusal(
        new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Can't reach database server at 127.0.0.1:5432",
        }),
      ),
    ).toBe(false);
    expect(isRefusal(new TRPCError({ code: "BAD_REQUEST", message: "invalid input" }))).toBe(false);
    expect(isRefusal(new Error("plain"))).toBe(false);
    expect(isRefusal(null)).toBe(false);
  });
});

describe("hasCampaign", () => {
  it("turns true once the rep starts a campaign, and only for that rep", async () => {
    await ensureUser(prisma, boss());
    await ensureUser(prisma, rep());

    await caller(rep()).campaigns.create(startInput());

    expect((await caller(rep()).me.get()).hasCampaign).toBe(true);
    expect((await caller(boss()).me.get()).hasCampaign).toBe(false);
  });
});
