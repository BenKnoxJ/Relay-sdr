import { parseEnv, type Env } from "@/lib/env";
import { encryptToken } from "@/lib/services/crypto";
import type { ConnectedAccountRef, MailTokens } from "@/lib/services/types";

export type StubCall = { url: string; method: string; headers: Record<string, string>; body?: string };

export type Responder = (call: StubCall) => Response | Promise<Response>;

/**
 * A `fetch` stub that records every call and answers from a queue of responders.
 *
 * The last responder answers every call past the end of the queue, so a test
 * that cares about one request does not have to enumerate the ones after it.
 */
export function stubFetch(responders: Responder[]) {
  const calls: StubCall[] = [];
  let i = 0;
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    const raw = init?.headers as Record<string, string> | undefined;
    if (raw) for (const [k, v] of Object.entries(raw)) headers[k] = String(v);
    const call: StubCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    const responder = responders[Math.min(i, responders.length - 1)];
    i += 1;
    if (!responder) throw new Error(`no responder for call ${i}: ${call.url}`);
    return responder(call);
  };
  return { impl: impl as unknown as typeof globalThis.fetch, calls };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export function empty(status = 202): Response {
  // 204/205/304 may not carry a body at all — the Response constructor enforces it.
  const nullBody = status === 204 || status === 205 || status === 304;
  return new Response(nullBody ? null : "", { status });
}

/**
 * A validated environment with every integration key filled in and
 * `INTEGRATIONS=live`, so the live clients can be built.
 *
 * `tests/setup.ts` forces `INTEGRATIONS=mock` on `process.env` for the suite as
 * a whole; this builds a separate object and hands it straight to the client
 * under test, so the two never disagree.
 */
export function testEnv(overrides: Record<string, string> = {}): Env {
  return parseEnv({
    DATABASE_URL: "postgresql://relay:relay@127.0.0.1:5435/relay_test",
    DIRECT_URL: "postgresql://relay:relay@127.0.0.1:5435/relay_test",
    TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString("base64"),
    INTEGRATIONS: "live",
    RELAY_ZOHO_CLIENT_ID: "zoho-client",
    RELAY_ZOHO_CLIENT_SECRET: "zoho-secret",
    RELAY_ZOHO_REFRESH_TOKEN: "zoho-refresh",
    RELAY_MS_TENANT_ID: "tenant-123",
    RELAY_MS_CLIENT_ID: "ms-client",
    RELAY_MS_CLIENT_SECRET: "ms-secret",
    ...overrides,
  });
}

/** The key `testEnv()` uses, passed explicitly so crypto never reads `process.env`. */
export const TEST_ENC_KEY = Buffer.alloc(32, 7).toString("base64");

/** A connected account whose access token expires at `expiresAt`. */
export function account(expiresAt: string): ConnectedAccountRef {
  const tokens: MailTokens = { accessToken: "access-1", refreshToken: "refresh-1", expiresAt };
  return {
    id: "acc_1",
    orgId: "org_1",
    userId: "user_1",
    provider: "graph",
    encTokens: encryptToken(JSON.stringify(tokens), TEST_ENC_KEY),
  };
}
