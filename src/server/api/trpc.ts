/**
 * tRPC server setup — context, initialisation, and the procedure builders.
 *
 * Relay is App Router, so the context is built from the fetch adapter's
 * `Request`, not from Next's `req`/`res` pair.
 */
import { type PrismaClient, type Role } from "@prisma/client";
import { initTRPC, TRPCError } from "@trpc/server";
import { type FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import superjson from "superjson";
import { ZodError } from "zod";

import { authCopy } from "@/lib/copy/auth";
import { prisma } from "@/lib/db";
import { getSession, type Session } from "@/server/auth/session";
import {
  DeactivatedUserError,
  ensureUser,
  IdentityConflictError,
  UnplaceableSessionError,
  type Actor,
} from "@/server/auth/upsertUser";

export type TRPCContext = {
  prisma: PrismaClient;
  headers: Headers;
  /** Who arrived, per the identity provider. Null when nobody is signed in. */
  session: Session | null;
  /**
   * The org, user and role this request acts as, resolved on demand.
   *
   * Deliberately lazy rather than a value on the context: resolving it is a
   * database read (and, once per person, a write), and `publicProcedure` has
   * no business making either. Memoised, so two procedures in one batched
   * request resolve it once.
   */
  actor: () => Promise<Actor>;
};

export const createTRPCContext = async ({
  req,
}: FetchCreateContextFnOptions): Promise<TRPCContext> => {
  const session = await getSession();

  let pending: Promise<Actor> | undefined;

  return {
    prisma,
    headers: req.headers,
    session,
    actor: () => {
      if (session === null) {
        return Promise.reject(new TRPCError({ code: "UNAUTHORIZED", message: authCopy.signedOut }));
      }
      // The promise is memoised, not the result: two concurrent procedures in
      // one batch would otherwise both miss the cache and both try the first
      // sign-in insert. A rejection is dropped rather than kept, so one
      // transient database error does not fail every other procedure in the
      // batch and every retry after it.
      return (pending ??= ensureUser(prisma, session).catch((error: unknown) => {
        pending = undefined;
        throw error;
      }));
    },
  };
};

const t = initTRPC.context<TRPCContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError:
          error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    };
  },
});

export const createTRPCRouter = t.router;

/**
 * Unauthenticated. `/api/health` and nothing else, for now: a procedure on
 * this builder has no `orgId`, so it cannot read a tenant's data by accident.
 */
export const publicProcedure = t.procedure;

/**
 * Signed in, any role.
 *
 * The three values it adds to the context are the whole point. Every write in
 * a router takes `ctx.orgId` and `ctx.userId` and never a field off `input`:
 * an `orgId` that arrives in a request body is a tenant the caller chose for
 * themselves. `eslint.config.mjs` refuses the shape that would do it, and
 * `tests/lint/tenantId.test.ts` pins the refusal.
 */
export const repProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (ctx.session === null) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: authCopy.signedOut });
  }

  let actor: Actor;
  try {
    actor = await ctx.actor();
  } catch (error) {
    // A switched-off account is not a failed sign-in: they are who they say
    // they are, and are not allowed in. Same for an email whose sign-in
    // account has been re-pointed, which is refused rather than followed.
    if (error instanceof DeactivatedUserError) {
      throw new TRPCError({ code: "FORBIDDEN", message: authCopy.noLongerActive });
    }
    // Not the same answer as a deactivated account, deliberately: an admin
    // told to switch this person back on finds `deactivated_at` null and
    // nothing to do.
    if (error instanceof IdentityConflictError) {
      throw new TRPCError({ code: "FORBIDDEN", message: authCopy.addressAlreadyInUse });
    }
    // Signed in at the provider and not placeable here. FORBIDDEN rather than
    // UNAUTHORIZED on purpose: signing in again cannot fix it, so a client
    // that retries on 401 would loop.
    if (error instanceof UnplaceableSessionError) {
      throw new TRPCError({ code: "FORBIDDEN", message: authCopy.needsWorkEmail });
    }
    throw error;
  }

  return next({
    ctx: {
      ...ctx,
      session: ctx.session,
      orgId: actor.orgId,
      userId: actor.userId,
      role: actor.role,
    },
  });
});

/**
 * Signed in as the sales manager.
 *
 * Built on `repProcedure`, so the role check runs after the org and user are
 * resolved and can never be the only thing standing between a request and a
 * tenant's data. The message names who can open the page, not which check
 * refused it (master doc §22.4).
 */
export const adminProcedure = repProcedure.use(({ ctx, next }) => {
  if (ctx.role !== ("admin" satisfies Role)) {
    throw new TRPCError({ code: "FORBIDDEN", message: authCopy.adminOnly });
  }
  return next({ ctx });
});
