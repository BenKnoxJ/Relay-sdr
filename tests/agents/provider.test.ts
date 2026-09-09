import { describe, expect, it } from "vitest";

import { credentialKind, headerShape, makeModel, OAUTH_BETA } from "@/lib/agents/provider";
import { parseEnv } from "@/lib/env";

/**
 * One credential leaves the process, and it is the subscription token when there
 * is one.
 *
 * No test here holds a real credential, and none needs to: what is being checked
 * is which header name carries which kind, that the beta rides with the token,
 * and that a process with both configured sends only the token. The live half —
 * whether Anthropic accepts a subscription token for a product worker on the SDK
 * transport — is decision D2 and is `scripts/spike/cost-check.ts`.
 */

const BASE = {
  DATABASE_URL: "postgresql://relay:relay@127.0.0.1:5435/relay_test",
  DIRECT_URL: "postgresql://relay:relay@127.0.0.1:5435/relay_test",
  NODE_ENV: "test",
};

describe("credentialKind", () => {
  it("prefers the subscription token, and withholds the key when both are set", () => {
    const both = parseEnv({ ...BASE, CLAUDE_CODE_OAUTH_TOKEN: "token", ANTHROPIC_API_KEY: "key" });
    expect(credentialKind(both)).toBe("subscription-token");
    // Not "both": the decision of 2026-09-08 is that the subscription is the
    // billing path, so the key is never read rather than being a fallback that
    // might be.
    expect(headerShape(credentialKind(both))).toEqual({ auth: "authorization", beta: [OAUTH_BETA] });
  });

  it("falls back to the key when no token is configured", () => {
    const keyOnly = parseEnv({ ...BASE, ANTHROPIC_API_KEY: "key" });
    expect(credentialKind(keyOnly)).toBe("api-key");
    // An API key goes on `x-api-key` and carries no OAuth beta: sending the beta
    // with a key, or the key on `Authorization`, is rejected by the API.
    expect(headerShape("api-key")).toEqual({ auth: "x-api-key", beta: [] });
  });

  it("reports none when neither is set", () => {
    expect(credentialKind(parseEnv(BASE))).toBe("none");
  });
});

describe("makeModel", () => {
  it("builds a model on the subscription token", () => {
    const model = makeModel("claude-opus-5", parseEnv({ ...BASE, CLAUDE_CODE_OAUTH_TOKEN: "token" }));
    expect(model).toBeTypeOf("object");
    expect((model as { modelId: string }).modelId).toBe("claude-opus-5");
  });

  it("builds a model on an API key", () => {
    const model = makeModel("claude-sonnet-5", parseEnv({ ...BASE, ANTHROPIC_API_KEY: "key" }));
    expect((model as { modelId: string }).modelId).toBe("claude-sonnet-5");
  });

  it("names both variables when neither is configured", () => {
    // Rather than returning a model that fails on first use: a worker with no way
    // to call the API should say so before it opens a run.
    expect(() => makeModel("claude-opus-5", parseEnv(BASE))).toThrow(
      /CLAUDE_CODE_OAUTH_TOKEN.*ANTHROPIC_API_KEY/,
    );
  });

  it("refuses a model the price table does not know", () => {
    expect(() =>
      makeModel("claude-opus-4-8" as "claude-opus-5", parseEnv({ ...BASE, ANTHROPIC_API_KEY: "key" })),
    ).toThrow(/not a pinned Relay model/);
  });

  it("serves the scripted model first, when one is configured", () => {
    const env = parseEnv({
      ...BASE,
      ANTHROPIC_API_KEY: "key",
      RELAY_AGENT_STUB_MODEL: JSON.stringify({ calls: [{ text: "{}", usage: { in: 1, out: 1 } }] }),
    });
    const model = makeModel("claude-opus-5", env);
    expect((model as { provider: string }).provider).toBe("relay-stub");
  });
});

describe("the headers a request actually carries", () => {
  /**
   * Through a recording `fetch`, not through `headerShape`.
   *
   * `headerShape` is a description; these are the headers. A test that only
   * checked the description would keep passing if `makeModel` started putting
   * the subscription token on `x-api-key` — which the API rejects, and which is
   * the exact mistake the provider's `authToken` option exists to prevent.
   */
  async function headersFor(source: Parameters<typeof makeModel>[1]): Promise<Headers> {
    let seen: Headers | undefined;
    const model = makeModel("claude-opus-5", source, {
      fetch: async (input, init) => {
        seen = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        // Enough of a Messages response for the provider to parse; the call's
        // content is irrelevant, only the request headers are under test.
        return new Response(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-opus-5",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    // Through `unknown`: `LanguageModel` is a union that includes the V2 and V3
    // specifications, whose `doGenerate` returns a `PromiseLike` rather than a
    // `Promise`, so the direct cast is not an overlap TypeScript will accept.
    await (model as unknown as { doGenerate: (options: unknown) => Promise<unknown> }).doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 16,
    });
    if (seen === undefined) throw new Error("the provider made no request");
    return seen;
  }

  it("sends the subscription token as a bearer token, with the beta, and no x-api-key", async () => {
    const headers = await headersFor(
      parseEnv({ ...BASE, CLAUDE_CODE_OAUTH_TOKEN: "tok_live_example", ANTHROPIC_API_KEY: "key_example" }),
    );
    expect(headers.get("authorization")).toBe("Bearer tok_live_example");
    expect(headers.get("anthropic-beta")).toBe(OAUTH_BETA);
    // The whole rule, on the wire: one credential, and the key is not it.
    expect(headers.get("x-api-key")).toBeNull();
    expect([...headers.values()].join(" ")).not.toContain("key_example");
  });

  it("sends an API key as x-api-key, with no bearer token and no OAuth beta", async () => {
    const headers = await headersFor(parseEnv({ ...BASE, ANTHROPIC_API_KEY: "key_example" }));
    expect(headers.get("x-api-key")).toBe("key_example");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("anthropic-beta")).toBeNull();
  });
});

describe("the stub model's guard", () => {
  it("refuses to boot a production environment that has one set", () => {
    // The same allowlist `DEV_USER_EMAIL` rides, and for a worse failure: a stub
    // model makes every agent in the org answer from a fixture and every run look
    // healthy.
    expect(() =>
      parseEnv({
        ...BASE,
        NODE_ENV: "production",
        RELAY_AGENT_STUB_MODEL: JSON.stringify({ calls: [{ text: "{}", usage: { in: 1, out: 1 } }] }),
      }),
    ).toThrow(/RELAY_AGENT_STUB_MODEL is a local-only scripted model/);
  });

  it("refuses it during a build too, unlike the sign-in bypass", () => {
    // `next build` is carved out of the `DEV_USER_EMAIL` guard because a build
    // loads a developer's env file and serves no request. A build makes no model
    // call at all, so there is nothing to carve out here.
    expect(() =>
      parseEnv({
        ...BASE,
        NODE_ENV: "production",
        NEXT_PHASE: "phase-production-build",
        RELAY_AGENT_STUB_MODEL: JSON.stringify({ calls: [{ text: "{}", usage: { in: 1, out: 1 } }] }),
      }),
    ).toThrow(/RELAY_AGENT_STUB_MODEL/);
  });

  it("names what is wrong with a malformed script", () => {
    const env = parseEnv({ ...BASE, RELAY_AGENT_STUB_MODEL: "not json" });
    expect(() => makeModel("claude-opus-5", env)).toThrow(/not valid JSON/);
    const empty = parseEnv({ ...BASE, RELAY_AGENT_STUB_MODEL: JSON.stringify({ calls: [] }) });
    expect(() => makeModel("claude-opus-5", empty)).toThrow(/not a valid script/);
  });
});
