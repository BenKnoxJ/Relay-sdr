import { z } from "zod";

import type { Env } from "@/lib/env";

import { decryptToken } from "../crypto";
import {
  SentButUnverifiedError,
  ServiceError,
  type ConnectedAccountRef,
  type GraphMailService,
  type LiveDeps,
  type MailMeta,
  type MailState,
  type MailTokens,
} from "../types";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const LOGIN_BASE = "https://login.microsoftonline.com";
const TIMEOUT_MS = 20_000;
/** Refresh a little before the stated expiry to avoid a guaranteed 401. */
const EXPIRY_SKEW_MS = 60_000;
/** Mailbox poll reads at most this many pages per account per run. */
const MAX_PAGES = 2;
/**
 * How many token chains stay cached for ONE account.
 *
 * The cache is keyed per blob, so a worker that re-reads a rotated row
 * accumulates an entry per rotation and something has to bound it. Bounded per
 * account rather than globally, because a global cap lets one busy account's
 * churn evict another's live entry — and an evicted entry is not free: the next
 * call on that blob re-decrypts the original and POSTs a refresh token AAD has
 * already rotated, which is the reuse-detection trip this cache exists to
 * avoid. Per account, reaching the bound means a blob superseded four times
 * over, which once 10b persists the rotation is a blob no caller still holds.
 */
const MAX_CHAINS_PER_ACCOUNT = 4;
const IMMUTABLE_ID = { Prefer: 'IdType="ImmutableId"' } as const;

type Json = Record<string, unknown>;

/** A row from a `$select` list: anything without a string `id` is not a message. */
const MailMetaRow = z
  .object({
    id: z.string().min(1),
    internetMessageId: z.string().optional(),
    conversationId: z.string().optional(),
    receivedDateTime: z.string().optional(),
    subject: z.string().optional(),
    bodyPreview: z.string().optional(),
  })
  .passthrough();

export type GraphMailDeps = LiveDeps & {
  /** Called with the new token blob after a refresh; the adapter never writes to the DB. */
  onTokenRefresh?: (account: ConnectedAccountRef, tokens: MailTokens) => void | Promise<void>;
  /**
   * Called when the token endpoint refuses the refresh. Microsoft answers 400 or 401
   * for a revoked or expired refresh token, and only the caller knows how to record
   * that — the adapter still throws, exactly as it did before.
   */
  onRefreshFailed?: (account: ConnectedAccountRef, error: ServiceError) => void | Promise<void>;
};

/**
 * `TOKEN_ENC_KEY` is in here rather than left to `crypto.ts`'s own `env()` read
 * so this client is a function of the environment it was handed, all of it. The
 * carried version took its Microsoft keys by injection and then reached for the
 * ambient process environment to decrypt — which meant a caller could hand it a
 * validated environment and still have it decrypt under a different key, and
 * meant the one security-relevant read was the one that could not be tested
 * without mutating `process.env`.
 */
type GraphEnv = Pick<
  Env,
  "RELAY_MS_TENANT_ID" | "RELAY_MS_CLIENT_ID" | "RELAY_MS_CLIENT_SECRET" | "TOKEN_ENC_KEY"
>;

/** Live Microsoft Graph mail client: draft → send → read back the sent item's ids. */
export class LiveGraphMailService implements GraphMailService {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => Date;
  private readonly onTokenRefresh?: GraphMailDeps["onTokenRefresh"];
  private readonly onRefreshFailed?: GraphMailDeps["onRefreshFailed"];
  /**
   * The chain each token blob was exchanged for, keyed as `refreshing` is.
   *
   * One entry per blob rather than one per account: two callers holding
   * different blobs for one account would otherwise evict each other, and the
   * next call on either blob would re-decrypt its original and POST a refresh
   * token AAD has already rotated — reuse detection, and a healthy mailbox
   * reported as needing a re-link. Bounded by `MAX_CACHED_CHAINS`.
   */
  private readonly tokens = new Map<string, MailTokens>();
  /**
   * Per account AND per token blob: a refresh already in flight, so two callers
   * holding the same credentials make one call. Keyed exactly as `tokens` is —
   * see `refresh()` for why the blob has to be part of the key.
   */
  private readonly refreshing = new Map<string, Promise<string>>();

  constructor(
    private readonly env: GraphEnv,
    deps: GraphMailDeps = {},
  ) {
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.now = deps.now ?? (() => new Date());
    this.onTokenRefresh = deps.onTokenRefresh;
    this.onRefreshFailed = deps.onRefreshFailed;
  }

  async createDraft(account: ConnectedAccountRef, msg: { to: string; subject: string; body: string }) {
    const json = await this.request(account, "POST", "/me/messages", {
      subject: msg.subject,
      body: { contentType: "Text", content: msg.body },
      toRecipients: [{ emailAddress: { address: msg.to } }],
    });
    const id = str(json.id);
    if (!id) throw new ServiceError({ service: "graph", status: 200, code: "malformed_response" });
    return { id };
  }

  async send(account: ConnectedAccountRef, draftId: string) {
    // Resolve the token BEFORE the try, so that a failure which happened on the
    // way to the send is not mistaken for one that happened after it.
    //
    // `request()` decrypts the blob and may hit the token endpoint first, and
    // every one of those failures used to land in the catch below and come back
    // as SentButUnverified — which tells the caller to record a send that never
    // reached the wire. A rotated TOKEN_ENC_KEY, a missing client secret or two
    // minutes of 503 from AAD would each have turned into "every send succeeds,
    // no mail leaves", silently and permanently.
    //
    // The 401-refresh inside `request()` stays where it is: by then Microsoft
    // has answered the send POST with a 401, so nothing was delivered and the
    // plain failure is the right answer — see the catch below, which is where
    // that distinction is made rather than in the shared `request()`.
    await this.accessToken(account);
    try {
      await this.request(account, "POST", `/me/messages/${encodeURIComponent(draftId)}/send`);
    } catch (cause) {
      // A refresh that failed inside `request()` only happens AFTER Graph
      // answered the send POST with a 401 — Microsoft refused it, so nothing
      // was delivered and none of the sent-but-unverified reasoning below
      // applies. A refusal from the token endpoint (400/401, the same pair
      // that fires `onRefreshFailed`) is an auth failure and is reported as
      // one; a 429, a 503 or a configuration Error keeps its own status and
      // class, because "AAD had a moment" must not read as "re-link".
      if (isRefreshFailure(cause)) {
        if (cause instanceof ServiceError && (cause.status === 400 || cause.status === 401)) {
          throw new ServiceError({ service: "graph", status: 401, code: cause.code, cause });
        }
        throw cause;
      }
      // A timeout, a dropped connection or a 5xx on the send POST itself is not proof
      // the mail stayed put — Microsoft may have accepted it. Treat it as sent but
      // unverified so the caller records the send and reconciles by id later.
      const failure = cause instanceof ServiceError ? cause : undefined;
      const status = failure?.status ?? 0;
      if (!failure || status === 0 || status >= 500) {
        throw new SentButUnverifiedError({
          draftId,
          status,
          code: failure?.code,
          requestId: failure?.requestId,
          cause,
        });
      }
      throw cause;
    }
    // Past this point the mail is delivered. A failed read-back is NOT a failed send:
    // it raises SentButUnverifiedError so the caller records the send and reconciles later.
    let json: Json;
    try {
      json = await this.request(
        account,
        "GET",
        `/me/messages/${encodeURIComponent(draftId)}?$select=id,internetMessageId,conversationId`,
      );
    } catch (cause) {
      // Total by intent, and it swallows more than the network: a timeout or a
      // dropped connection, a 404 because Graph moved the sent item to a new
      // id, a refused token refresh mid-read-back, and a TypeError out of our
      // own code all land here. None of them is evidence about delivery, and
      // the mail has already gone — so none of them may leave as a plain
      // error, because the caller's retry would send it a second time. What is
      // lost by not rethrowing is a loud signal about a bug in this file; what
      // would be lost by rethrowing is the customer's inbox.
      const failure = cause instanceof ServiceError ? cause : undefined;
      throw new SentButUnverifiedError({
        draftId,
        status: failure?.status ?? 0,
        code: failure?.code,
        requestId: failure?.requestId,
        cause,
      });
    }
    const ids = {
      id: str(json.id),
      internetMessageId: str(json.internetMessageId),
      conversationId: str(json.conversationId),
    };
    if (!ids.id || !ids.internetMessageId || !ids.conversationId) {
      throw new SentButUnverifiedError({ draftId, status: 200, code: "malformed_response" });
    }
    return ids;
  }

  async getMessage(account: ConnectedAccountRef, id: string): Promise<MailState> {
    let json: Json;
    try {
      json = await this.request(
        account,
        "GET",
        `/me/messages/${encodeURIComponent(id)}` +
          "?$select=id,internetMessageId,conversationId,isDraft,sentDateTime",
      );
    } catch (error) {
      if (error instanceof ServiceError && error.status === 404) return { notFound: true };
      throw error;
    }
    return {
      id: str(json.id) || id,
      internetMessageId: str(json.internetMessageId),
      conversationId: str(json.conversationId),
      isDraft: json.isDraft === true,
      ...(str(json.sentDateTime) ? { sentDateTime: str(json.sentDateTime) } : {}),
    };
  }

  async deleteDraft(account: ConnectedAccountRef, id: string): Promise<void> {
    try {
      await this.request(account, "DELETE", `/me/messages/${encodeURIComponent(id)}`);
    } catch (error) {
      // Already gone is the outcome we wanted.
      if (error instanceof ServiceError && error.status === 404) return;
      throw error;
    }
  }

  async listSince(account: ConnectedAccountRef, since: Date, select: string[]): Promise<MailMeta[]> {
    const filter = `receivedDateTime ge ${since.toISOString()}`;
    let path: string | undefined =
      `/me/mailFolders/inbox/messages?$filter=${encodeURIComponent(filter)}` +
      `&$select=${encodeURIComponent(select.join(","))}&$top=50`;
    const out: MailMeta[] = [];
    for (let page = 0; page < MAX_PAGES && path; page += 1) {
      const json: Json = await this.request(account, "GET", path);
      if (Array.isArray(json.value)) {
        for (const row of json.value) {
          const parsed = MailMetaRow.safeParse(row);
          if (parsed.success) out.push(parsed.data as MailMeta);
        }
      }
      const next = json["@odata.nextLink"];
      path = typeof next === "string" ? next : undefined;
    }
    return out;
  }

  // ------------------------------------------------------------- internals

  private async request(
    account: ConnectedAccountRef,
    method: "GET" | "POST" | "DELETE",
    pathOrUrl: string,
    body?: Json,
  ): Promise<Json> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${GRAPH_BASE}${pathOrUrl}`;
    let token = await this.accessToken(account);
    let res = await this.call(url, method, token, body);
    if (res.status === 401) {
      // One refresh-and-retry: the cached token may have been revoked early.
      // Drain the unread 401 body so the connection is released.
      // Caught, not floated: an unhandled rejection is fatal to the bare-Node
      // worker, and failing to release a connection is not worth a process.
      void res.body?.cancel().catch(() => undefined);
      try {
        token = await this.refresh(account);
      } catch (cause) {
        // Rethrown AS IT IS: a 429 stays a 429, a 503 stays a 503, a missing
        // RELAY_MS_* stays a plain Error. An earlier version reported all three
        // as ServiceError(401) so that `send()` could tell a refused send from
        // an unverifiable one — but `request()` is shared, and that turned
        // every transient AAD wobble on getMessage/deleteDraft/listSince/
        // createDraft into an auth failure. A caller reading 401 as "this
        // mailbox needs re-linking" would have said so about a healthy one.
        //
        // Only that `send()` still needs to know these errors came from the
        // REFRESH and not from the call itself, which the tag carries without
        // touching the error's own status or class.
        throw markRefreshFailure(cause);
      }
      res = await this.call(url, method, token, body);
    }
    const json = await readJson(res);
    if (!res.ok) {
      const error = (json.error ?? {}) as Json;
      const inner = (error.innerError ?? {}) as Json;
      throw new ServiceError({
        service: "graph",
        status: res.status,
        code: str(error.code) || undefined,
        requestId: str(inner["request-id"]) || undefined,
      });
    }
    return json;
  }

  private call(url: string, method: "GET" | "POST" | "DELETE", token: string, body?: Json): Promise<Response> {
    return this.fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...IMMUTABLE_ID,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  private async accessToken(account: ConnectedAccountRef): Promise<string> {
    const cached = this.cached(account) ?? this.store(account, this.decrypt(account));
    const expiresAt = Date.parse(cached.expiresAt);
    if (Number.isNaN(expiresAt) || expiresAt - EXPIRY_SKEW_MS <= this.now().getTime()) {
      return this.refresh(account);
    }
    return cached.accessToken;
  }

  /**
   * The cached tokens for the blob the caller is holding now, if any.
   *
   * Keying on `account.id` alone meant a client that had refreshed once ignored
   * its caller's projection for the rest of the process: hand it a freshly read
   * row after another process rotated the token and it would still present the
   * chain it happened to have in memory, eventually presenting a dead refresh
   * token and getting the mailbox marked as needing re-linking with nothing
   * wrong in the database. The blob a cache entry came from is its key.
   */
  private cached(account: ConnectedAccountRef): MailTokens | undefined {
    return this.tokens.get(cacheKey(account));
  }

  private store(account: ConnectedAccountRef, tokens: MailTokens): MailTokens {
    const key = cacheKey(account);
    // Re-insert so the map's iteration order is least-recently-stored first,
    // which is what makes the eviction below drop the right entry.
    // eslint-disable-next-line no-restricted-syntax -- in-memory Map, not Prisma
    this.tokens.delete(key);
    this.tokens.set(key, tokens);
    const mine = [...this.tokens.keys()].filter((k) => k.startsWith(`${account.id}:`));
    for (const stale of mine.slice(0, Math.max(0, mine.length - MAX_CHAINS_PER_ACCOUNT))) {
      // eslint-disable-next-line no-restricted-syntax -- in-memory Map, not Prisma
      this.tokens.delete(stale);
    }
    return tokens;
  }

  private decrypt(account: ConnectedAccountRef): MailTokens {
    // `decryptToken(blob, undefined)` falls back to reading TOKEN_ENC_KEY off
    // `process.env`, which would undo the point of taking the key by injection.
    // The type allows `undefined` because the key is optional in `env.ts`; a
    // client built without one cannot read a token and should say so.
    if (this.env.TOKEN_ENC_KEY === undefined) {
      throw new Error("TOKEN_ENC_KEY is not configured, so no mail token can be read");
    }
    const plain = decryptToken(account.encTokens, this.env.TOKEN_ENC_KEY);
    let parsed: unknown;
    try {
      parsed = JSON.parse(plain);
    } catch {
      // Not rethrown: Node quotes the first several characters of its input in
      // a JSON SyntaxError, and the input here is a decrypted token.
      throw new Error("malformed mail token blob");
    }
    if (!parsed || typeof parsed !== "object") throw new Error("malformed mail token blob");
    return parsed as MailTokens;
  }

  private async refresh(account: ConnectedAccountRef): Promise<MailTokens["accessToken"]> {
    // One refresh at a time per account. Without this, a poller and a send
    // worker arriving together just after expiry each POST the SAME refresh
    // token: AAD rotates it twice, the second `onTokenRefresh` write wins, and
    // refresh-token reuse detection can invalidate the whole family — the rep's
    // mailbox needs re-linking for no reason a log would explain.
    //
    // Keyed on the blob as well as the id, because two callers holding
    // DIFFERENT blobs for one account are not that case: they hold different
    // credentials. Merging them spends the winner's chain twice over and
    // discards the loser's silently — and if the winner's refresh token is the
    // spent one, the healthy caller inherits the refusal and its rep is asked
    // to re-link a mailbox with nothing wrong with it. Same key as `tokens`,
    // for the same reason: a token chain is identified by its blob, not by the
    // row it was read from.
    const key = cacheKey(account);
    const inFlight = this.refreshing.get(key);
    if (inFlight) return inFlight;
    const started = this.doRefresh(account).finally(() => {
      // eslint-disable-next-line no-restricted-syntax -- in-memory Map, not Prisma
      this.refreshing.delete(key);
    });
    this.refreshing.set(key, started);
    return started;
  }

  private async doRefresh(account: ConnectedAccountRef): Promise<MailTokens["accessToken"]> {
    const current = this.cached(account) ?? this.decrypt(account);
    const tenant = this.env.RELAY_MS_TENANT_ID;
    const clientId = this.env.RELAY_MS_CLIENT_ID;
    const clientSecret = this.env.RELAY_MS_CLIENT_SECRET;
    if (!tenant || !clientId || !clientSecret) {
      throw new Error("RELAY_MS_* env is required for the live Graph client");
    }
    const res = await this.fetchImpl(`${LOGIN_BASE}/${tenant}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      // No `scope`. The refresh_token grant defaults to what was originally
      // consented to, and AAD requires any scope sent here to be a SUBSET of
      // that. Naming `Mail.Send` — which `BASE_SCOPES` deliberately does not
      // ask for, because sending is a separate incremental consent — would make
      // the FIRST refresh of every read-only account fail `invalid_grant`, and
      // (before the filter below) report it as a revoked token.
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: current.refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = await readJson(res);
    if (!res.ok) {
      const failure = new ServiceError({ service: "graph", status: res.status, code: str(json.error) || undefined });
      // Only 400 and 401 mean the refresh token is spent or revoked. A 429 or a
      // 503 is AAD having a moment, and telling the caller about it would have
      // every rep asked to re-link a mailbox that is perfectly healthy.
      if (res.status === 400 || res.status === 401) await this.onRefreshFailed?.(account, failure);
      throw failure;
    }
    const accessToken = str(json.access_token);
    // A 200 with no access token is a contract violation, not a token. Cached,
    // it sends `Authorization: Bearer ` for an hour and — through
    // `onTokenRefresh` — writes an empty token into the account row.
    if (!accessToken) {
      throw new ServiceError({ service: "graph", status: res.status, code: "malformed_response" });
    }
    const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
    const tokens: MailTokens = {
      accessToken,
      refreshToken: str(json.refresh_token) || current.refreshToken,
      expiresAt: new Date(this.now().getTime() + expiresIn * 1000).toISOString(),
    };
    this.store(account, tokens);
    await this.onTokenRefresh?.(account, tokens);
    return tokens.accessToken;
  }
}

async function readJson(res: Response): Promise<Json> {
  const text = await res.text();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Json) : {};
  } catch {
    return {};
  }
}

/**
 * Errors thrown by a token refresh, tagged so `send()` can tell one from a
 * failure of the call it was retrying.
 *
 * A tag rather than a wrapper class because the whole point is that the error
 * reaches every other caller with its own status and class untouched: only
 * `send()`, which has to decide whether a mail may have been delivered, asks
 * the question at all. Weak, so a tagged error is not kept alive by being one.
 */
const refreshFailures = new WeakSet<object>();

function markRefreshFailure(cause: unknown): unknown {
  if (typeof cause === "object" && cause !== null) refreshFailures.add(cause);
  return cause;
}

function isRefreshFailure(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && refreshFailures.has(cause);
}

/** A token chain is identified by the blob it came from, not by its account row. */
function cacheKey(account: ConnectedAccountRef): string {
  return `${account.id}:${account.encTokens}`;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
