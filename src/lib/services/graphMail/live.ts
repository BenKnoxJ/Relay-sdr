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
  /** Per account: the tokens, and the `encTokens` blob they were derived from. */
  private readonly tokens = new Map<string, { from: string; tokens: MailTokens }>();
  /** Per account: a refresh already in flight, so two callers make one call. */
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
    // plain failure is the right answer.
    await this.accessToken(account);
    try {
      await this.request(account, "POST", `/me/messages/${encodeURIComponent(draftId)}/send`);
    } catch (cause) {
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
      void res.body?.cancel();
      token = await this.refresh(account);
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
   * The cached tokens for this account, but only if they were derived from the
   * blob the caller is holding now.
   *
   * Keying on `account.id` alone meant a client that had refreshed once ignored
   * its caller's projection for the rest of the process: hand it a freshly read
   * row after another process rotated the token and it would still present the
   * chain it happened to have in memory, eventually presenting a dead refresh
   * token and getting the mailbox marked as needing re-linking with nothing
   * wrong in the database. The blob a cache entry came from is part of its key.
   */
  private cached(account: ConnectedAccountRef): MailTokens | undefined {
    const entry = this.tokens.get(account.id);
    return entry?.from === account.encTokens ? entry.tokens : undefined;
  }

  private store(account: ConnectedAccountRef, tokens: MailTokens): MailTokens {
    this.tokens.set(account.id, { from: account.encTokens, tokens });
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
    const inFlight = this.refreshing.get(account.id);
    if (inFlight) return inFlight;
    const started = this.doRefresh(account).finally(() => {
      // eslint-disable-next-line no-restricted-syntax -- in-memory Map, not Prisma
      this.refreshing.delete(account.id);
    });
    this.refreshing.set(account.id, started);
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

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
