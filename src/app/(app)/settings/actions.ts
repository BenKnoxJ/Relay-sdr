"use server";

import { TRPCError } from "@trpc/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { mailboxCopy } from "@/lib/copy/settings";
import { ORG_DEFAULT_DAILY_CAP } from "@/lib/repo/connections";
import { isGone, isRefusal, serverCaller } from "@/server/api/caller";

/**
 * What the Mailbox card's three controls submit to.
 *
 * Server actions rather than a client calling tRPC over HTTP, for the reason
 * `(app)/actions.ts` gives: Relay has no client transport, and an action is a
 * public endpoint that goes through the same router and the same
 * `repProcedure` a browser would hit. The guard is the procedure's.
 */

/**
 * Where a refused action sends the rep back to.
 *
 * There is no `error.tsx` under `(app)`, so an action that rejects replaces the
 * whole page with Next's default error screen — which for "this copy of Relay
 * has no mailbox connection configured" is the wrong answer twice over: it
 * loses the page, and it says nothing the rep can act on. A refusal the
 * procedure chose becomes a banner on the card instead. Anything else is a
 * fault and is rethrown, because a database outage is not a connect failure.
 */
function refusalPath(error: unknown): string {
  if (error instanceof TRPCError && error.code === "PRECONDITION_FAILED") {
    return "/settings?connect=setup";
  }
  // Signed out between the page rendering and the button being pressed. Back to
  // Settings, where the middleware sends them to sign in.
  if (isRefusal(error)) return "/settings";
  throw error;
}

/** Connect: mint a state, then hand the rep to the provider's consent screen. */
export async function connectMailbox(): Promise<void> {
  let destination: string;
  try {
    const caller = await serverCaller();
    destination = (await caller.connections.startGraphConnect()).url;
  } catch (error) {
    destination = refusalPath(error);
  }
  // Outside the try on purpose: `redirect` works by throwing, and calling it
  // inside would have the catch treat the navigation as a failure.
  redirect(destination);
}

/** Disconnect: revoke locally. Idempotent, so there is nothing to report. */
export async function disconnectMailbox(): Promise<void> {
  let destination = "/settings";
  try {
    const caller = await serverCaller();
    await caller.connections.disconnectGraph();
  } catch (error) {
    destination = refusalPath(error);
  }
  redirect(destination);
}

/**
 * Lower the cap, and return the one line the field shows: "Saved", or why not.
 *
 * `useActionState`'s state is that line and nothing else, which is the whole
 * contract of a field that saves on blur.
 */
export async function saveDailyCap(_previous: string | null, form: FormData): Promise<string | null> {
  const raw = String(form.get("cap") ?? "").trim();
  const cap = Number(raw);
  // Checked here as well as in the procedure, and not because the procedure is
  // in doubt: there is no error boundary under `(app)`, so an action that
  // rejects replaces the whole page with Next's default error screen. A blank
  // or non-numeric field is the browser's business, so nothing is said.
  if (raw === "" || !Number.isInteger(cap)) return null;
  if (cap < 1 || cap > ORG_DEFAULT_DAILY_CAP) return mailboxCopy.capTooHigh;

  try {
    const caller = await serverCaller();
    const { saved } = await caller.connections.setDailyCap({ cap });
    // The card is a server component reading `connections.get`, so without this
    // the page keeps rendering the old cap until something else re-renders it —
    // and the field's own "has this changed?" guard is then comparing against a
    // stale number.
    revalidatePath("/settings");
    return saved;
  } catch (error) {
    // A session that expired between the page rendering and the field losing
    // focus. `isRefusal` separates that from a fault, whose own message must
    // never be shown to a rep as though it were copy.
    if (isRefusal(error)) return error.message;
    // The mailbox went away between the page rendering and the field losing
    // focus — a disconnect in another tab is the whole of it. The card this
    // field sits on has already stopped existing; saying so is a better answer
    // than Next's error screen, which is what rethrowing gets, because there is
    // no error boundary under `(app)`.
    if (isGone(error)) return error.message;
    throw error;
  }
}
