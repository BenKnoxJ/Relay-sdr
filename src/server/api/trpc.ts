/**
 * tRPC server setup — context, initialisation, and the procedure builders.
 *
 * Relay is App Router, so the context is built from the fetch adapter's
 * `Request`, not from Next's `req`/`res` pair.
 */
import { initTRPC } from "@trpc/server";
import { type FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import superjson from "superjson";
import { ZodError } from "zod";

import { prisma } from "@/lib/db";

export const createTRPCContext = ({ req }: FetchCreateContextFnOptions) => {
  return {
    prisma,
    headers: req.headers,
  };
};

export type TRPCContext = ReturnType<typeof createTRPCContext>;

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

/** Unauthenticated procedure. Auth lands with the Clerk task. */
export const publicProcedure = t.procedure;
