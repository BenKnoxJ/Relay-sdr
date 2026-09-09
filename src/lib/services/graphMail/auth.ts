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

/**
 * The token set `INTEGRATIONS=mock` hands back instead of calling Microsoft.
 *
 * Fixed values, so a test can assert the blob in the database decrypts to
 * exactly this, and obviously fake ones, so a mock token that escaped into a
 * live path fails at Microsoft rather than looking plausible in a log.
 */
export const MOCK_EXCHANGE_TOKENS = {
  accessToken: "mock-graph-access",
  refreshToken: "mock-graph-refresh",
  scopes: [...BASE_SCOPES, SEND_SCOPE],
} as const;

/** How long a mock access credential claims to last. */
const MOCK_TTL_MS = 3600 * 1000;

/**
 * Exchange a code, against Microsoft or against the mock, per `INTEGRATIONS`.
 *
 * The selector lives beside the live call rather than in the callback route,
 * for the reason `createGraphMailService` does: which of the two runs is a
 * property of the environment, and a route that branched on it would be a
 * second place the answer is decided.
 */
export async function exchangeGraphCode(
  env: AuthEnv & { INTEGRATIONS: "mock" | "live" },
  input: { code: string; redirectUri: string },
  deps: ExchangeDeps = {},
): Promise<ExchangedTokens> {
  if (env.INTEGRATIONS === "mock") {
    const now = deps.now ?? (() => new Date());
    return {
      accessToken: MOCK_EXCHANGE_TOKENS.accessToken,
      refreshToken: MOCK_EXCHANGE_TOKENS.refreshToken,
      expiresAt: new Date(now().getTime() + MOCK_TTL_MS).toISOString(),
      scopes: [...MOCK_EXCHANGE_TOKENS.scopes],
    };
  }
  return exchangeCode(env, input, deps);
}

/**
 * Where "Connect" sends the rep: Microsoft's consent screen, or — under
 * `INTEGRATIONS=mock` — straight back to Relay's own callback with a code the
 * mock exchange accepts.
 *
 * The mock branch is what makes the whole connect walkable on a laptop with no
 * Microsoft app registration, which is the state Relay is in until D1 lands. It
 * cannot fire in a live deployment: `INTEGRATIONS` is validated at boot and
 * `live` is the only other value.
 */
export function authorizeGraphUrl(
  env: AuthEnv & { INTEGRATIONS: "mock" | "live" },
  input: AuthorizeInput,
): string {
  if (env.INTEGRATIONS === "mock") {
    const url = new URL(input.redirectUri);
    url.searchParams.set("code", "mock-authorization-code");
    url.searchParams.set("state", input.state);
    return url.toString();
  }
  return authorizeUrl(env, input);
}
