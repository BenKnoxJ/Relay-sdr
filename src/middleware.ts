import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";

import { authCopy } from "@/lib/copy/auth";
import { clerkPublishableKey, devBypassEmail } from "@/lib/env";

/**
 * Signed in by default; public by exception.
 *
 * The list below is the whole public surface, and it is short on purpose: a
 * screen added next week is protected because nobody did anything, which is
 * the only way a default-deny rule survives contact with a growing app.
 */

/** The sign-in screen and everything Clerk hangs off it. */
const isAuthRoute = createRouteMatcher(["/sign-in(.*)"]);

/**
 * The API routes that answer without a session at this layer.
 *
 * `/api/health` because an uptime check that has to sign in is not an uptime
 * check.
 *
 * `/api/trpc` because tRPC is its own gate and a better one: `repProcedure`
 * and `adminProcedure` refuse per procedure, with the code and the message a
 * tRPC client can actually read. A blanket 401 from here would arrive as a
 * plain JSON body the client cannot deserialise, so it would surface as a
 * transform error rather than as UNAUTHORIZED — the gate would work and the
 * message would be useless. Every procedure but `publicProcedure` refuses
 * before it touches the database.
 */
export const PUBLIC_API_ROUTES = ["/api/health", "/api/trpc(.*)"];
const isPublicApiRoute = createRouteMatcher(PUBLIC_API_ROUTES);

const isApiRoute = createRouteMatcher(["/api/(.*)", "/trpc/(.*)"]);

const protect = clerkMiddleware(async (auth, request) => {
  const { userId } = await auth();

  if (isAuthRoute(request)) {
    // Already signed in: there is nothing to do on a sign-in screen.
    if (userId !== null) return NextResponse.redirect(new URL("/", request.url));
    return NextResponse.next();
  }

  if (isPublicApiRoute(request)) return NextResponse.next();

  if (isApiRoute(request)) {
    // Answered here rather than by `auth.protect()`, which returns a 404 to a
    // non-document request: a caller told the route does not exist goes
    // looking for a typo, and a caller told 401 signs in. No
    // `unauthenticatedUrl` either — a 200 carrying the HTML of a sign-in page
    // is the worst of the three for anything that has to parse the response.
    if (userId === null) {
      return NextResponse.json({ error: authCopy.signedOut }, { status: 401 });
    }
    return NextResponse.next();
  }

  // And the opposite for a page. `auth.protect()` alone decides whether to
  // redirect from request headers (`Sec-Fetch-Dest`, `Accept`), and falls
  // through to a 404 when they are not what it expects; naming the URL makes
  // the redirect unconditional (C360 PR #84, 2026-07-27).
  await auth.protect({ unauthenticatedUrl: new URL("/sign-in", request.url).toString() });
  return NextResponse.next();
});

/**
 * The local bypass short-circuits Clerk entirely, rather than being a branch
 * inside it: a developer running with `DEV_USER_EMAIL` set has no Clerk keys,
 * and `clerkMiddleware` would fail the request before any branch inside it
 * could answer. `devBypassEmail` is the single place that decides the bypass
 * applies — it refuses anything but an explicit `development` or `test`
 * environment — and `src/server/auth/session.ts` reads the same function.
 *
 * It is read per request, not once at module load, so a test can change the
 * environment and see it take effect.
 *
 * Nothing is written onto the request for the session to read. A header naming
 * the user to sign in as would be client-supplied, and forgeable; both ends
 * read the environment instead.
 */
/** Set once the "nothing is configured" line has been logged for this process. */
let warned = false;

export default function middleware(request: NextRequest, event: NextFetchEvent) {
  if (devBypassEmail() !== null) return NextResponse.next();

  // Neither an identity provider nor a bypass: there is no way to establish
  // who anybody is, so there is no request this deployment can answer safely.
  // `clerkMiddleware` would throw on its own here, per request, as an
  // unhandled 500 with a Clerk stack trace and nothing said about the missing
  // key. This fails closed on every path — including the ones the list above
  // makes public — and says why.
  if (clerkPublishableKey() === null) {
    if (!warned) {
      // Once per process. A misconfigured deployment gets one line that says
      // what to fix, not one line per request drowning it.
      warned = true;
      console.error(
        JSON.stringify({
          at: new Date().toISOString(),
          component: "middleware",
          event: "no-sign-in-configured",
          detail:
            "No way to sign anybody in: NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY was not set at build time, and DEV_USER_EMAIL is unset, malformed, or not permitted by this NODE_ENV. See docs/environment.md.",
        }),
      );
    }
    return new NextResponse(null, { status: 503 });
  }

  return protect(request, event);
}

export const config = {
  // Everything but Next's own assets and static files, plus the API and tRPC
  // routes explicitly — those are excluded by the first pattern's extension
  // list on some paths and have to be named.
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
