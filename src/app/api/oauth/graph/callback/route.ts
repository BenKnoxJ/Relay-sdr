import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { getSession } from "@/server/auth/session";
import { completeGraphConnect } from "@/server/auth/graphCallback";
import { ensureUser } from "@/server/auth/upsertUser";

/**
 * Where Microsoft sends the rep back to (master doc §19).
 *
 * The one callback in Relay, and it is thin on purpose: parse the query
 * string, ask `completeGraphConnect` what happened, and turn the answer into a
 * redirect. Everything with a decision in it lives in that function, where it
 * can be driven without Next.
 *
 * Not on `PUBLIC_API_ROUTES`, deliberately. The middleware's default-deny sends
 * an unauthenticated hit here to a 401 before it can spend a state, and the
 * session it insists on is what `completeGraphConnect` checks the state's owner
 * against.
 */

// A code is exchanged per request, so this must never be prerendered or cached.
export const dynamic = "force-dynamic";

/**
 * `?connected=mailbox` on success, `?connect=<reason>` on anything else.
 *
 * Built from `APP_URL`, the same origin the `redirect_uri` is built from, and
 * for the same reason: the rep arrives here from Microsoft, so the Host on the
 * request is worth exactly as much as whatever proxy set it. Nothing
 * attacker-controlled is reflected either way, but an origin taken off the
 * request is one misconfigured hop from sending a signed-in rep somewhere that
 * is not Relay.
 *
 * The request's own origin is the fallback, and only because `APP_URL` is
 * optional — a laptop running `next dev` has not set one, and there is no
 * other absolute URL to redirect to. A deployment serving real traffic sets it.
 */
function back(request: Request, query: string): NextResponse {
  const url = new URL(`/settings?${query}`, env().APP_URL ?? request.url);
  return NextResponse.redirect(url);
}

export async function GET(request: Request): Promise<NextResponse> {
  const session = await getSession();
  // The middleware answers this first in a running deployment. Repeated here
  // because a route that depends on another layer for its only authorisation
  // check is one edit to a matcher away from having none.
  if (session === null) return back(request, "connect=link");

  const actor = await ensureUser(prisma, session);
  const params = new URL(request.url).searchParams;

  const outcome = await completeGraphConnect(prisma, {
    code: params.get("code"),
    state: params.get("state"),
    error: params.get("error"),
    actorUserId: actor.userId,
  });

  // Nothing from the query string is echoed into the redirect: the reason is
  // one of three constants this process chose, and the code that arrived is
  // never written anywhere.
  return outcome.ok ? back(request, "connected=mailbox") : back(request, `connect=${outcome.reason}`);
}
