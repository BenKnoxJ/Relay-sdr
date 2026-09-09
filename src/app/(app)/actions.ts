"use server";

import { SENTENCE_MAX } from "@/lib/shell";
import { isRefusal, serverCaller } from "@/server/api/caller";

/**
 * What Home's brief box submits to.
 *
 * A server action rather than a client calling tRPC over HTTP: Relay has no
 * client transport yet and does not need one for a form. The action is a
 * public endpoint like any other, so it goes through the same router and the
 * same `repProcedure` a browser would hit — the guard is the procedure's, not
 * this file's.
 *
 * Returns the line to show under the box, which is `useActionState`'s state.
 */
export async function startBrief(_previous: string | null, form: FormData): Promise<string | null> {
  // Checked here as well as in the procedure, and not because the procedure is
  // in doubt. There is no error boundary under `(app)`, so an action that
  // rejects replaces the whole page with Next's default error screen — and the
  // browser's own `required` lets a single space through, which the input
  // schema then refuses. Nothing to say about a blank sentence, so nothing is
  // said: the box stays as it was.
  const sentence = String(form.get("sentence") ?? "").trim();
  if (sentence === "" || sentence.length > SENTENCE_MAX) return null;

  try {
    const caller = await serverCaller();
    const { line } = await caller.campaigns.stub({ sentence });
    return line;
  } catch (error) {
    // A session that expired between the page rendering and Start being
    // pressed. `isRefusal` is what separates that from a fault: tRPC wraps
    // everything in a `TRPCError`, and a database outage's own message must
    // not be shown to a rep as though it were copy.
    if (isRefusal(error)) return error.message;
    throw error;
  }
}
