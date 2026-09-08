import { TRPCError } from "@trpc/server";
import { headers } from "next/headers";
import { cache } from "react";

import { appRouter } from "@/server/api/root";
import { createContextFromHeaders } from "@/server/api/trpc";

/**
 * The routers, called straight from a server component.
 *
 * No HTTP: `createCaller` runs the procedure in this process, against a
 * context built the same way the fetch adapter builds one. A page that fetched
 * its own `/api/trpc` would be a request to itself, with the session forwarded
 * by hand, and every procedure's guards would then be protecting a call whose
 * caller is the server. This way `repProcedure` runs over the real session and
 * a page gets the same refusal a browser would.
 */
export const serverCaller = async () =>
  appRouter.createCaller(await createContextFromHeaders(await headers()));

/**
 * Who is signed in, once per render.
 *
 * `cache` is React's per-request memo, not a cache with a lifetime: the layout
 * and the page it wraps both need this and both run in one render pass, so
 * without it the shell costs two identical reads on every page view. It is
 * request-scoped by construction, so one rep's answer cannot reach another.
 */
export const me = cache(async () => (await serverCaller()).me.get());

/**
 * A refusal a procedure chose, rather than a fault it wrapped.
 *
 * The CODE and not the type, because the type says nothing: tRPC wraps
 * everything a procedure throws in a `TRPCError`, so a database outage arrives
 * as one too, carrying the driver's own message. `repProcedure` raises exactly
 * two codes deliberately — FORBIDDEN for a switched-off account, an address
 * re-pointed to another sign-in, or one Relay cannot place, and UNAUTHORIZED
 * for no session — and only those two carry a line out of `src/lib/copy`.
 *
 * Anything else is a fault, and putting "Can't reach database server at ..."
 * on a rep's screen would be showing it to them as though it were copy.
 */
export function isRefusal(error: unknown): error is TRPCError {
  return error instanceof TRPCError && (error.code === "FORBIDDEN" || error.code === "UNAUTHORIZED");
}
