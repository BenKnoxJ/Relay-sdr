import { redirect } from "next/navigation";

import { Nav } from "@/components/Nav";
import { initialsFor } from "@/lib/shell";
import { isRefusal, me } from "@/server/api/caller";
import { getSession } from "@/server/auth/session";

/**
 * The signed-in shell: the nav, and the page inside it.
 *
 * Auth happens here and once. Every page under `(app)` is behind it, so a
 * screen added next week is protected because nobody did anything — the same
 * default-deny shape `src/middleware.ts` takes for the whole app. The
 * middleware is the first gate and this is the second: a page must not depend
 * on middleware configuration for whether it renders a stranger's nav.
 */

/** Signed in, and not allowed any further. One line, and no way onward. */
function Refused({ message }: { message: string }) {
  return (
    <div className="grid min-h-screen place-items-center px-6">
      <p className="type-body max-w-measure text-center text-muted">{message}</p>
    </div>
  );
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (session === null) redirect("/sign-in");

  // Signed in at the provider, and refused here: a switched-off account, an
  // address re-pointed to another sign-in, or one Relay cannot place. None of
  // them is fixed by signing in again, and sending them to `/sign-in` would
  // loop — the middleware bounces a signed-in caller straight back. So the
  // refusal is rendered, in the words the copy file already has, without a nav
  // to a shell they are not in.
  //
  // The CODE is what is checked, not the type. tRPC wraps everything a
  // procedure throws in a `TRPCError`, so a database outage arrives here as
  // one too — with the driver's own message on it. Showing that would put
  // "Can't reach database server at ..." on a rep's screen as though it were
  // copy. Only the two codes `repProcedure` raises deliberately carry a
  // rep-facing line; the rest is a fault and is thrown on.
  let who: Awaited<ReturnType<typeof me>>;
  try {
    who = await me();
  } catch (error) {
    if (isRefusal(error)) return <Refused message={error.message} />;
    throw error;
  }

  return (
    <div className="px-6 pb-7 pt-card-rail">
      <Nav role={who.role} initials={initialsFor(who.name, who.email)} hasCampaign={who.hasCampaign} />
      <main>{children}</main>
    </div>
  );
}
