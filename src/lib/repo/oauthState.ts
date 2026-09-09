import { randomBytes } from "node:crypto";

import { Prisma, type OAuthState, type PrismaClient, type Provider } from "@prisma/client";

import { mutate } from "./mutate";

/**
 * The OAuth `state` parameter, held in the database (master doc §24).
 *
 * `state` is the only thing standing between the callback route and a
 * cross-site request forgery: without it, anybody can walk a signed-in rep's
 * browser onto `/api/oauth/graph/callback?code=…` and have Relay attach an
 * attacker's mailbox to that rep's account. So it is a row, not a cookie and
 * not a signed blob — a row can be spent exactly once, by the database, and a
 * cookie cannot.
 *
 * It lives in `src/lib/repo/**` rather than in `src/server/auth/` (where the
 * brief drew it) for the reason the write ban exists: this module writes, and
 * `mutate` is the only place a transaction is opened, so a Prisma write outside
 * this directory trips the lint. Nothing here knows about Clerk, Next or tRPC.
 */

/** How long a rep has to finish the provider's consent screen. */
export const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * 32 bytes from the CSPRNG, base64url.
 *
 * `base64url` rather than `base64`, because the value is put in a query string:
 * base64's `+` and `/` survive a round trip only if every caller remembers to
 * encode them, and the one that forgets produces a state that never matches.
 */
function newState(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Start a connect: mint a state and record that the rep began one.
 *
 * Through `mutate`, so the row and its Event commit together. A rep who starts
 * a connect and never finishes it is a thing worth being able to see — it is
 * the shape "consent screen refused" leaves behind, and without the Event the
 * only trace is a row that expires and says nothing.
 */
export async function createState(
  db: PrismaClient,
  input: { orgId: string; userId: string; provider: Provider; now?: Date },
): Promise<string> {
  const { orgId, userId, provider } = input;
  const now = input.now ?? new Date();
  const state = newState();

  await mutate(db, {
    orgId,
    actor: { kind: "user", userId },
    kind: "account.connect_started",
    after: { provider },
    apply: (tx) =>
      tx.oAuthState.create({
        data: { orgId, userId, provider, state, expiresAt: new Date(now.getTime() + STATE_TTL_MS) },
      }),
  });

  // Returned, never logged. The state is a one-shot credential for the length
  // of its window: anything that prints it hands over the CSRF defence.
  return state;
}

/**
 * Spend a state, returning the row it belonged to, or `null`.
 *
 * Single use is in the statement, not in the caller. The obvious spelling —
 * read the row, check it, then write — has a window between the read and the
 * write in which a second request reads the same row and passes the same
 * check, and two callbacks racing on one state is precisely the case this
 * exists to refuse. Here the condition (`expiresAt` still in the future) is
 * part of the UPDATE, so the loser matches no rows and gets `null`.
 *
 * A spent state is expressed by expiring it rather than by a `used_at` column,
 * which keeps this task's promise of no data-model change. The two are the same
 * answer to the only question anyone asks of the row — "may this callback
 * proceed?" — and to the rep they are one sentence either way: the link is no
 * longer good, start again. It also means a reaper over `expiresAt` would clear
 * spent states along with timed-out ones and need no extra rule. There is no
 * such reaper yet — `src/lib/jobs/retention.ts` has no rule for `oauth_states`,
 * so these rows accumulate. Its own small task, not this one.
 *
 * Takes a transaction client on purpose. The account it authorises has to be
 * written in the same transaction that spends it, or a failed upsert leaves the
 * state burnt and the rep unable to retry without going round the consent
 * screen a second time.
 */
export async function spendState(
  tx: Prisma.TransactionClient,
  state: string,
  now: Date = new Date(),
): Promise<OAuthState | null> {
  try {
    return await tx.oAuthState.update({
      // `state` is `@unique`, so it is the selector; `AND` is how "and it has
      // not expired or been spent" is expressed alongside it — the same shape
      // `linkClerkId` uses for "and it is still null".
      where: { state, AND: { expiresAt: { gt: now } } },
      data: { expiresAt: now },
    });
  } catch (error) {
    // P2025 is "no row matched", which here means one of three things the
    // caller must not be able to tell apart: no such state, already spent, or
    // expired. Anything else is a real database failure and is rethrown.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") return null;
    throw error;
  }
}
