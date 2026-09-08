/**
 * The Microsoft 365 connect flow's two halves (§19).
 *
 * Both live here rather than on `GraphMailService` because neither belongs to a
 * connected account: they are what turns an authorisation code into one. `fetch` is
 * injected so the callback route can be tested without reaching Microsoft.
 *
 * Task 10b owns the OAuth state, the callback route and the ConnectedAccount row.
 * This module is the half that talks to Microsoft, and it holds no state at all.
 */
import type { Env } from "@/lib/env";

const LOGIN_BASE = "https://login.microsoftonline.com";

/** Read and organise mail, plus the refresh token. Sending is a separate grant. */
export const BASE_SCOPES = ["offline_access", "User.Read", "Mail.ReadWrite"] as const;
/** Added by the incremental "allow sending" consent, never requested up front. */
export const SEND_SCOPE = "Mail.Send";

export type AuthEnv = Pick<Env, "RELAY_MS_TENANT_ID" | "RELAY_MS_CLIENT_ID" | "RELAY_MS_CLIENT_SECRET">;

export type AuthorizeInput = {
  state: string;
  redirectUri: string;
  /** Space-separated scopes; defaults to the base set. */
  scope?: string;
};

/** The tenant the app is registered against; `common` when none is configured. */
function tenant(env: AuthEnv): string {
  return env.RELAY_MS_TENANT_ID ?? "common";
}

export function authorizeUrl(env: AuthEnv, input: AuthorizeInput): string {
  const url = new URL(`${LOGIN_BASE}/${tenant(env)}/oauth2/v2.0/authorize`);
  url.searchParams.set("client_id", env.RELAY_MS_CLIENT_ID ?? "");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", input.scope ?? BASE_SCOPES.join(" "));
  url.searchParams.set("state", input.state);
  return url.toString();
}

export type ExchangedTokens = {
  accessToken: string;
  refreshToken: string;
  /** ISO-8601 instant at which `accessToken` expires. */
  expiresAt: string;
  /** Exactly what the tenant granted — which is what decides `sendGranted`. */
  scopes: string[];
};

export type ExchangeDeps = {
  fetchImpl?: typeof globalThis.fetch;
  now?: () => Date;
};

/**
 * Swap the authorisation code for tokens. Throws a plain `Error` with no response
 * body attached: the callback shows the rep one sentence, never Microsoft's own text.
 */
export async function exchangeCode(
  env: AuthEnv,
  input: { code: string; redirectUri: string },
  deps: ExchangeDeps = {},
): Promise<ExchangedTokens> {
  const doFetch = deps.fetchImpl ?? globalThis.fetch;
  const now = deps.now ?? (() => new Date());

  const body = new URLSearchParams({
    client_id: env.RELAY_MS_CLIENT_ID ?? "",
    client_secret: env.RELAY_MS_CLIENT_SECRET ?? "",
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
  });

  const response = await doFetch(`${LOGIN_BASE}/${tenant(env)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!response.ok) throw new Error(`token exchange failed with ${response.status}`);

  const json = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!json.access_token || !json.refresh_token) throw new Error("token exchange returned no tokens");

  const expiresInMs = (json.expires_in ?? 3600) * 1000;
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: new Date(now().getTime() + expiresInMs).toISOString(),
    scopes: (json.scope ?? "").split(/\s+/).filter((s) => s.length > 0),
  };
}
