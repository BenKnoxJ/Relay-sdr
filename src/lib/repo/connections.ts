import { type ConnectedAccount, type PrismaClient } from "@prisma/client";

import { encryptToken } from "@/lib/services/crypto";
import type { ServicesDeps } from "@/lib/services";
import type { ConnectedAccountRef, MailTokens } from "@/lib/services/types";

import { mutate } from "./mutate";
import { spendState } from "./oauthState";

/**
 * The rep's connected mailbox: the row, and every write that touches it
 * (master doc §19, §23.1f).
 *
 * Tokens are the most dangerous thing Relay holds — a refresh token is a
 * standing key to somebody's mailbox — so they arrive here in the clear and
 * leave encrypted, and no function in this file returns a decrypted one. The
 * card the rep sees is assembled from everything else on the row.
 *
 * Zoho is deliberately absent. It is org-level and the admin owns it (slice 3),
 * and a repository that cannot express "this rep connected the org's CRM" is
 * one nobody can accidentally start expressing it through.
 */

/**
 * The ceiling on a rep's daily cap until slice 3 gives an admin a way to set
 * one (§23.1f: "the rep may lower the cap within the admin's ceiling, never
 * raise it").
 *
 * The same number as the column's own default on purpose: a rep who has never
 * touched the field is already at the ceiling, so the only move available is
 * down, which is the rule stated as a starting position rather than as a
 * check. When Admin lands, this becomes a read of the org's setting and every
 * caller below is already asking the right question.
 */
export const ORG_DEFAULT_DAILY_CAP = 10;

/** The state was missing, expired, already spent, or for another provider. */
export class ConnectStateInvalidError extends Error {
  constructor() {
    super("the connect link is no longer valid");
    this.name = "ConnectStateInvalidError";
  }
}

/**
 * Thrown out of an `apply` to roll the whole transaction back — including the
 * Event `mutate` would otherwise have written — when the row the write was for
 * is not there, or is in a state the write must not touch.
 *
 * `mutate` writes exactly one Event per transaction and has no way to be told
 * "not this time", so the only way to decline one after looking at the row is
 * to fail the transaction. Caught by the two callers below and turned into
 * silence, which is the right answer: nothing happened, so nothing is recorded.
 */
class NothingToUpdateError extends Error {}

/**
 * A row a mutator may still write to. Narrows, so the caller keeps the row.
 *
 * `revoked` is the one status that is not a phase a mailbox passes through: the
 * rep destroyed the tokens on purpose and the row survives only as the record
 * that they did. Three mutators below need that sentence and each used to spell
 * it out, which is three chances to write the fourth one without it — so it is
 * asked here instead. `markExpiring` is deliberately not a caller: its rule is
 * stricter (`healthy` only), and widening it to this one would let a refusal
 * from the token endpoint overwrite a status somebody chose.
 */
function isLive<T extends { status: string }>(row: T | null): row is T {
  return row !== null && row.status !== "revoked";
}

/** A cap outside `1 … ORG_DEFAULT_DAILY_CAP`. */
export class CapOutOfRangeError extends Error {
  readonly ceiling: number;
  constructor(ceiling: number) {
    super(`the daily cap must be between 1 and ${ceiling}`);
    this.name = "CapOutOfRangeError";
    this.ceiling = ceiling;
  }
}

/** The mailbox row, or null. A read: it decrypts nothing. */
export function getMailbox(
  db: PrismaClient,
  input: { orgId: string; userId: string },
): Promise<ConnectedAccount | null> {
  return db.connectedAccount.findFirst({
    // `orgId` as well as `userId`, though `@@unique([userId, provider])` makes
    // it redundant today: a query that names the tenant stays correct if a user
    // is ever moved between orgs, and costs an index column.
    where: { orgId: input.orgId, userId: input.userId, provider: "graph" },
  });
}

/**
 * Finish a connect: spend the state and store the mailbox, in one transaction.
 *
 * The two are one act. Spending the state in its own transaction and then
 * writing the account in another means a failure between them burns the rep's
 * one-shot state and leaves nothing connected — they would have to go round the
 * consent screen again to fix a failure that was ours. Here an upsert that
 * throws rolls the spend back with it.
 *
 * The tenant comes from the state row and never from the request: the callback
 * is reached with whatever query string somebody put in a link, so `orgId` and
 * `userId` have to come from a row Relay itself wrote when the connect started.
 */
export async function connectMailboxFromState(
  db: PrismaClient,
  input: { state: string; tokens: MailTokens; scopes: string[]; now?: Date },
): Promise<ConnectedAccount> {
  const now = input.now ?? new Date();

  // Read first, only to learn the tenant `mutate` has to be told. It proves
  // nothing on its own — the row could be spent between this and the UPDATE
  // below — which is why the real check is `spendState` inside the transaction.
  const pending = await db.oAuthState.findUnique({ where: { state: input.state } });
  if (pending === null || pending.provider !== "graph") throw new ConnectStateInvalidError();

  const encTokens = encryptToken(JSON.stringify(input.tokens));

  return mutate(db, {
    orgId: pending.orgId,
    actor: { kind: "user", userId: pending.userId },
    kind: "account.connected",
    // No token, encrypted or otherwise. An Event is a record anybody with
    // database access reads; the whole point of the envelope is that the blob
    // lives in exactly one column.
    after: { provider: "graph", scopes: input.scopes, status: "healthy" },
    apply: async (tx) => {
      const spent = await spendState(tx, input.state, now);
      if (spent === null) throw new ConnectStateInvalidError();

      return tx.connectedAccount.upsert({
        where: { userId_provider: { userId: pending.userId, provider: "graph" } },
        // The cap, window, days and ramp are left to the column defaults so
        // that the schema is the one place they are written down (§23.1f's
        // numbers live there, not here).
        create: {
          orgId: pending.orgId,
          userId: pending.userId,
          provider: "graph",
          encTokens,
          scopes: input.scopes,
          status: "healthy",
          connectedAt: now,
          expiresAt: new Date(input.tokens.expiresAt),
        },
        // A re-link keeps the rep's own settings. Their cap and window are a
        // decision they made about how they send; re-connecting a mailbox that
        // expired is not a decision to undo it.
        update: {
          encTokens,
          scopes: input.scopes,
          status: "healthy",
          pausedReason: null,
          connectedAt: now,
          expiresAt: new Date(input.tokens.expiresAt),
          // A cursor from before the disconnect points into a mailbox the poll
          // has not been watching. Cleared, so the first poll after a re-link
          // starts from the reconnect rather than silently skipping whatever
          // arrived while Relay was not looking.
          pollCursor: null,
        },
      });
    },
  });
}

/**
 * Disconnect: revoke locally and drop the tokens.
 *
 * Locally, and the word is load-bearing. Relay does not call Microsoft's revoke
 * endpoint, because there is not one for a delegated grant that a client can
 * rely on; what it can do is destroy the only copy of the tokens it holds,
 * which is what actually ends Relay's access. The rep withdraws the rest from
 * their Microsoft account page, and the copy says so.
 *
 * The row stays. Nothing is deleted (§25 rule 1), and the row is the record
 * that this mailbox was once connected.
 */
export async function disconnectMailbox(
  db: PrismaClient,
  input: { orgId: string; userId: string },
): Promise<ConnectedAccount | null> {
  const existing = await getMailbox(db, input);
  if (!isLive(existing)) return existing;

  return mutate(db, {
    orgId: input.orgId,
    actor: { kind: "user", userId: input.userId },
    kind: "account.disconnected",
    before: { status: existing.status },
    after: { status: "revoked" },
    apply: (tx) =>
      tx.connectedAccount.update({
        where: { id: existing.id },
        data: {
          status: "revoked",
          // The empty string, not a null: the column is NOT NULL, and a blob
          // that fails to decrypt is a better resting state than one that
          // decrypts to something. Every reader checks `status` first.
          encTokens: "",
          scopes: [],
          expiresAt: null,
          pollCursor: null,
          pausedReason: null,
        },
      }),
  });
}

/**
 * Lower the daily cap, within the ceiling.
 *
 * The ceiling is checked here rather than only in the router, because this is
 * the layer that can enforce it: a second caller — a future Admin screen, a
 * script — gets the same refusal without re-deriving the rule.
 */
export async function setDailyCap(
  db: PrismaClient,
  input: { orgId: string; userId: string; cap: number },
): Promise<ConnectedAccount | null> {
  const ceiling = ORG_DEFAULT_DAILY_CAP;
  if (!Number.isInteger(input.cap) || input.cap < 1 || input.cap > ceiling) {
    throw new CapOutOfRangeError(ceiling);
  }

  const existing = await getMailbox(db, input);
  // Null for a revoked row as well as a missing one, and the same null on
  // purpose: `getMailbox` has no status filter, so without this the cap and an
  // `account.cap_changed` Event both land on a mailbox that no longer exists.
  // The caller turns null into "no mailbox connected", which is what the card
  // says after a disconnect either way.
  if (!isLive(existing)) return null;
  if (existing.dailyCap === input.cap) return existing;

  return mutate(db, {
    orgId: input.orgId,
    actor: { kind: "user", userId: input.userId },
    kind: "account.cap_changed",
    before: { dailyCap: existing.dailyCap },
    after: { dailyCap: input.cap },
    apply: (tx) => tx.connectedAccount.update({ where: { id: existing.id }, data: { dailyCap: input.cap } }),
  });
}

/**
 * Persist a rotated token blob. The `onTokenRefresh` half of the pair
 * `services()` takes.
 *
 * Scoped by `orgId` as well as `id`: the ref comes from whatever the adapter
 * was handed, and a write keyed on an id alone trusts that completely.
 *
 * The blob is written for every state but `revoked`, including `paused`. That
 * is not indulgence towards a paused mailbox — it is the only safe thing to do.
 * A refresh has already happened at Microsoft by the time this is called, so
 * the old refresh token is spent; dropping the new one leaves the row holding a
 * credential that AAD will answer with reuse detection the next time anybody
 * tries it, which breaks a mailbox that was merely paused. `revoked` is the
 * exception because there the rep destroyed the tokens on purpose, and a late
 * refresh from an adapter still holding an old blob must not reconnect them.
 *
 * The STATUS, separately, only ever improves from `expiring`. `paused` is an
 * instruction from a person — an admin, or a bounce rule — and a token that
 * happens to refresh is not a reason to start sending again.
 */
export async function updateTokens(
  db: PrismaClient,
  account: ConnectedAccountRef,
  tokens: MailTokens,
): Promise<void> {
  const encTokens = encryptToken(JSON.stringify(tokens));

  try {
    await mutate(db, {
      orgId: account.orgId,
      // The worker refreshing a token on its own schedule, not the rep pressing
      // anything: `system` is what `Event.actorUserId` being nullable is for.
      actor: { kind: "system" },
      kind: "account.token_refreshed",
      after: { accountId: account.id, expiresAt: tokens.expiresAt },
      apply: async (tx) => {
        // Read and write in one transaction, so the status the update is
        // decided from is the status it is applied to.
        const row = await tx.connectedAccount.findFirst({
          where: { id: account.id, orgId: account.orgId },
          select: { status: true },
        });
        if (!isLive(row)) throw new NothingToUpdateError();

        return tx.connectedAccount.update({
          where: { id: account.id },
          data: {
            encTokens,
            expiresAt: new Date(tokens.expiresAt),
            ...(row.status === "expiring" ? { status: "healthy" as const } : {}),
          },
        });
      },
    });
  } catch (error) {
    // Nothing to update is not a failure, and it must not be reported as one:
    // this runs as a hook inside a request that has already succeeded.
    if (!(error instanceof NothingToUpdateError)) throw error;
  }
}

/**
 * Flag a mailbox as needing a re-link. The `onRefreshFailed` half of the pair.
 *
 * Only from `healthy`. A mailbox already `revoked` or `paused` has a state
 * somebody chose, and a refusal from the token endpoint — which is exactly what
 * a revoked account produces — must not overwrite it with a weaker one that
 * puts "Needs re-link" on the card of a mailbox the rep deliberately
 * disconnected.
 */
export async function markExpiring(db: PrismaClient, account: ConnectedAccountRef): Promise<void> {
  try {
    await mutate(db, {
      orgId: account.orgId,
      actor: { kind: "system" },
      kind: "account.expiring",
      before: { status: "healthy" },
      after: { status: "expiring", accountId: account.id },
      apply: async (tx) => {
        const { count } = await tx.connectedAccount.updateMany({
          where: { id: account.id, orgId: account.orgId, status: "healthy" },
          data: { status: "expiring" },
        });
        // Zero rows means the mailbox was already revoked, paused or expiring.
        // Rolling back takes the Event with it: an `account.expiring` for a
        // status that did not change is a record of nothing.
        if (count === 0) throw new NothingToUpdateError();
        return count;
      },
    });
  } catch (error) {
    if (!(error instanceof NothingToUpdateError)) throw error;
  }
}

/**
 * The pair of hooks `services()` takes, bound to a database handle.
 *
 * Memoised per handle, and that is not tidiness: `services()` caches its
 * adapter set on the deps object's *identity*, so a fresh literal per call
 * would rebuild the live Graph client — and with it the token cache that stops
 * two callers racing a refresh — on every single call.
 *
 * Neither hook throws, twice over: `services()` wraps whatever it is given, and
 * the two functions above swallow nothing themselves, so a failure to record a
 * rotation surfaces in the logs of whoever wrapped them rather than turning a
 * delivered mail into an error.
 */
const hooksByDb = new WeakMap<PrismaClient, ServicesDeps>();

export function connectionHooks(db: PrismaClient): ServicesDeps {
  const existing = hooksByDb.get(db);
  if (existing !== undefined) return existing;

  const deps: ServicesDeps = {
    onTokenRefresh: (account, tokens) => updateTokens(db, account, tokens),
    onRefreshFailed: (account) => markExpiring(db, account),
  };
  hooksByDb.set(db, deps);
  return deps;
}

/**
 * Narrow a row to the projection an adapter is allowed to see.
 *
 * The column is the four-value `Provider` enum and the adapter contract is the
 * two an adapter can be handed, so this refuses the other two rather than
 * relabelling them. A `zoho` row quietly arriving at a mail adapter as `graph`
 * would be a mailbox call made with a CRM's credentials, and the failure would
 * surface as an unreadable error from Microsoft rather than at the line that
 * chose the wrong row.
 */
export function refFor(account: ConnectedAccount): ConnectedAccountRef {
  if (account.provider !== "graph" && account.provider !== "linkedin") {
    throw new Error(`${account.provider} is not a provider a mail adapter can be handed`);
  }
  return {
    id: account.id,
    orgId: account.orgId,
    userId: account.userId,
    provider: account.provider,
    encTokens: account.encTokens,
  };
}

/** Read the stored blob back. Exported for the send path (slice 1), not for a screen. */
export function isConnected(account: ConnectedAccount | null): account is ConnectedAccount {
  return account !== null && account.status !== "revoked";
}
