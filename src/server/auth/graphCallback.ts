import { type PrismaClient } from "@prisma/client";

import { ConnectStateInvalidError, connectMailboxFromState } from "@/lib/repo/connections";
import { env } from "@/lib/env";
import { type ExchangeDeps, exchangeGraphCode } from "@/lib/services/graphMail";

/**
 * What happens between Microsoft's redirect and the rep landing back on
 * Settings (master doc §19, §24).
 *
 * Split out from the route so it can be driven without Next: the route is a
 * URL in and a `Response` out, and everything worth asserting — the state being
 * spent, the blob being encrypted, a refusal being one of three plain sentences
 * — is in here.
 *
 * The rule the whole file is written to: nothing Microsoft said reaches the
 * rep, and nothing Relay holds reaches a log. A failure is one of three
 * outcomes below, chosen by us, and the provider's own text (which routinely
 * names the app registration and sometimes echoes the request) is dropped on
 * the floor.
 */

/** The three ways this can end badly, each mapped to one line of copy. */
export type ConnectFailure =
  /** The state was missing, expired, already spent, or not ours. */
  | "link"
  /** Microsoft refused, or the exchange did not come back with a token set. */
  | "provider"
  /**
   * This deployment cannot connect a mailbox at all: no `APP_URL` to have been
   * redirected back to, or no `TOKEN_ENC_KEY` to store the result under.
   */
  | "setup";

export type CallbackOutcome = { ok: true } | { ok: false; reason: ConnectFailure };

export type CallbackInput = {
  /** Exactly as they arrived on the query string; either may be absent. */
  code: string | null;
  state: string | null;
  /** Microsoft's own `error` parameter, present when the rep refused consent. */
  error: string | null;
  /**
   * The signed-in rep, from the session the middleware already insisted on.
   *
   * Checked against the state row's owner below. It does not defend against a
   * stolen state — the thief's victim is signed in, which is the point of the
   * attack — but it does refuse the simpler thing: one rep opening another
   * rep's callback link and attaching their own mailbox to that account.
   */
  actorUserId: string;
};

export async function completeGraphConnect(
  db: PrismaClient,
  input: CallbackInput,
  deps: ExchangeDeps = {},
): Promise<CallbackOutcome> {
  const { code, state, error, actorUserId } = input;

  // Consent refused, or Microsoft gave up. Its `error_description` is not read
  // and not logged: it is written for whoever registered the app.
  if (error !== null) return { ok: false, reason: "provider" };
  if (state === null || state === "") return { ok: false, reason: "link" };
  if (code === null || code === "") return { ok: false, reason: "provider" };

  const e = env();
  if (e.APP_URL === undefined) return { ok: false, reason: "setup" };
  // A token is only ever stored through the envelope, so without the key there
  // is nowhere to put one. `parseEnv` demands the key under `INTEGRATIONS=live`
  // and not under `mock` — which is the mode a laptop runs in — so this is a
  // reachable configuration, and it has to end as a sentence on the card rather
  // than as a 500 from `encryptToken` half way through the flow.
  if (e.TOKEN_ENC_KEY === undefined) return { ok: false, reason: "setup" };

  // Whose connect is this? Read before the exchange, so a link opened by the
  // wrong person costs no round trip to Microsoft — and, more to the point, so
  // the mismatch is refused before an authorisation code is spent.
  const pending = await db.oAuthState.findUnique({
    where: { state },
    select: { userId: true, provider: true },
  });
  if (pending === null || pending.provider !== "graph") return { ok: false, reason: "link" };
  if (pending.userId !== actorUserId) return { ok: false, reason: "link" };

  let tokens;
  try {
    tokens = await exchangeGraphCode(
      e,
      { code, redirectUri: new URL("/api/oauth/graph/callback", e.APP_URL).toString() },
      deps,
    );
  } catch {
    // Deliberately not `catch (cause)` with the cause attached. `exchangeCode`
    // already throws without a response body, and re-wrapping it here is one
    // more object carrying a URL that had the code in it.
    return { ok: false, reason: "provider" };
  }

  try {
    await connectMailboxFromState(db, {
      state,
      tokens: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
      },
      // Exactly what the tenant granted, not what was asked for. Whether this
      // mailbox may send is a question about the grant, and only this answers it.
      scopes: tokens.scopes,
    });
  } catch (failure) {
    // The race the single-use state exists to lose: the row was spent between
    // the read above and the UPDATE inside the transaction.
    if (failure instanceof ConnectStateInvalidError) return { ok: false, reason: "link" };
    throw failure;
  }

  return { ok: true };
}
