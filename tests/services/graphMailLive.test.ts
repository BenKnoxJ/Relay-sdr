/**
 * The live Graph client, against a fake `fetch`. No network: every test here
 * asserts the request Relay would put on the wire and the meaning it takes from
 * the reply.
 *
 * The send path carries the rule the rest of Phase 1 depends on (§24): once
 * Microsoft has accepted the message, no failure downstream of that may look
 * like an unsent mail, because the retry would send it twice.
 */
import { describe, expect, it, vi } from "vitest";

import { encryptToken } from "@/lib/services/crypto";
import { LiveGraphMailService } from "@/lib/services/graphMail/live";
import {
  SentButUnverifiedError,
  ServiceError,
  type ConnectedAccountRef,
  type MailTokens,
} from "@/lib/services/types";

import { TEST_ENC_KEY, account, empty, json, stubFetch, testEnv } from "./helpers";

const NOW = new Date("2026-09-02T09:00:00.000Z");
const now = () => NOW;

const fresh = () => account("2026-09-02T10:00:00.000Z");
const expired = () => account("2026-09-02T08:00:00.000Z");

const draft = { to: "priya@example.com", subject: "Quick question", body: "Hello" };

function client(responders: Parameters<typeof stubFetch>[0], deps = {}) {
  const fetchStub = stubFetch(responders);
  const graph = new LiveGraphMailService(testEnv(), { fetchImpl: fetchStub.impl, now, ...deps });
  return { graph, calls: fetchStub.calls };
}

describe("LiveGraphMailService — request shaping", () => {
  it("creates a draft with the ImmutableId preference and the verified body", async () => {
    const { graph, calls } = client([() => json({ id: "AAMk-live-1" })]);

    expect(await graph.createDraft(fresh(), draft)).toEqual({ id: "AAMk-live-1" });

    const call = calls[0];
    expect(call?.url).toBe("https://graph.microsoft.com/v1.0/me/messages");
    expect(call?.method).toBe("POST");
    // Without this preference Graph hands back ids that change when a message
    // moves folder, and the read-back after a send stops finding it.
    expect(call?.headers.Prefer).toBe('IdType="ImmutableId"');
    expect(call?.headers.Authorization).toBe("Bearer access-1");
    expect(JSON.parse(call?.body ?? "{}")).toEqual({
      subject: "Quick question",
      body: { contentType: "Text", content: "Hello" },
      toRecipients: [{ emailAddress: { address: "priya@example.com" } }],
    });
  });

  it("rejects a 2xx that carries no draft id rather than returning an empty one", async () => {
    const { graph } = client([() => json({})]);
    await expect(graph.createDraft(fresh(), draft)).rejects.toMatchObject({ code: "malformed_response" });
  });

  it("percent-encodes the message id into every path it builds", async () => {
    // Graph ids are base64url and routinely contain characters that change the
    // path if they go in raw.
    const { graph, calls } = client([() => empty(204)]);
    await graph.deleteDraft(fresh(), "AAMk/id+with=chars");
    expect(calls[0]?.url).toBe(
      "https://graph.microsoft.com/v1.0/me/messages/AAMk%2Fid%2Bwith%3Dchars",
    );
  });

  it("asks for the inbox since the cursor, and stops after two pages", async () => {
    const page = (next?: string) =>
      json({
        value: [{ id: "m1", receivedDateTime: "2026-09-01T09:00:00Z" }],
        ...(next ? { "@odata.nextLink": next } : {}),
      });
    const { graph, calls } = client([
      () => page("https://graph.microsoft.com/v1.0/next-2"),
      () => page("https://graph.microsoft.com/v1.0/next-3"),
      () => page("https://graph.microsoft.com/v1.0/next-4"),
    ]);

    const messages = await graph.listSince(fresh(), new Date("2026-09-01T00:00:00Z"), [
      "id",
      "conversationId",
    ]);

    expect(messages).toHaveLength(2);
    // Two pages, not three: an account with a runaway mailbox must not be able
    // to hold one poll run open indefinitely.
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain(
      `$filter=${encodeURIComponent("receivedDateTime ge 2026-09-01T00:00:00.000Z")}`,
    );
    expect(calls[0]?.url).toContain(`$select=${encodeURIComponent("id,conversationId")}`);
    expect(calls[1]?.url).toBe("https://graph.microsoft.com/v1.0/next-2");
  });

  it("drops a list row that is not a message rather than passing it on", async () => {
    const { graph } = client([
      () => json({ value: [{ id: "m1" }, { noId: true }, { id: 42 }, "nonsense"] }),
    ]);
    const messages = await graph.listSince(fresh(), new Date("2026-09-01T00:00:00Z"), ["id"]);
    expect(messages.map((m) => m.id)).toEqual(["m1"]);
  });
});

describe("LiveGraphMailService — the send path", () => {
  it("sends, then reads the sent item's ids back", async () => {
    const { graph, calls } = client([
      () => empty(202),
      () =>
        json({
          id: "AAMk-live-1",
          internetMessageId: "<live-1@relay.example>",
          conversationId: "AAQk-live-conv-1",
        }),
    ]);

    expect(await graph.send(fresh(), "AAMk-live-1")).toEqual({
      id: "AAMk-live-1",
      internetMessageId: "<live-1@relay.example>",
      conversationId: "AAQk-live-conv-1",
    });
    expect(calls[0]?.url).toBe("https://graph.microsoft.com/v1.0/me/messages/AAMk-live-1/send");
    expect(calls[1]?.url).toContain("$select=id,internetMessageId,conversationId");
  });

  it("treats a 5xx on the send itself as sent but unverified", async () => {
    // The mail may well have gone: never let a retry create a second copy.
    const { graph } = client([() => json({ error: { code: "serviceUnavailable" } }, 503)]);
    await expect(graph.send(fresh(), "AAMk-live-1")).rejects.toBeInstanceOf(SentButUnverifiedError);
  });

  it("treats a dropped connection on the send as sent but unverified", async () => {
    // A timeout is not proof the mail stayed put, and it is not a ServiceError
    // either — it arrives as a raw TypeError from fetch.
    const { graph } = client([
      () => {
        throw new TypeError("network error");
      },
    ]);
    const error = await graph.send(fresh(), "AAMk-live-1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SentButUnverifiedError);
    expect(error).toMatchObject({ status: 0, draftId: "AAMk-live-1" });
  });

  it("does not call a failure on the way to the send 'sent'", async () => {
    // Nothing was put on the wire, so reporting sent-but-unverified would have
    // the caller record a send that never happened — and the mail never goes.
    for (const [name, responder] of [
      ["AAD is down", () => json({ error: "temporarily_unavailable" }, 503)],
      ["AAD refuses the refresh", () => json({ error: "invalid_grant" }, 400)],
    ] as const) {
      const fetchStub = stubFetch([responder]);
      const graph = new LiveGraphMailService(testEnv(), { fetchImpl: fetchStub.impl, now });
      const error = await graph.send(expired(), "AAMk-live-1").catch((e: unknown) => e);
      expect(error, name).not.toBeInstanceOf(SentButUnverifiedError);
      // The send endpoint was never reached.
      expect(fetchStub.calls.filter((c) => c.url.includes("graph.microsoft.com")), name).toHaveLength(0);
    }
  });

  it("does not call an unreadable token blob 'sent'", async () => {
    const fetchStub = stubFetch([() => json({})]);
    const graph = new LiveGraphMailService(
      { ...testEnv(), TOKEN_ENC_KEY: Buffer.alloc(32, 9).toString("base64") },
      { fetchImpl: fetchStub.impl, now },
    );
    const error = await graph.send(fresh(), "AAMk-live-1").catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(SentButUnverifiedError);
    expect(fetchStub.calls).toHaveLength(0);
  });

  it("still fails outright when the send is refused", async () => {
    // A 404 means Microsoft never had the draft, so nothing was delivered and
    // the caller must NOT record a send.
    const { graph } = client([() => json({ error: { code: "ErrorItemNotFound" } }, 404)]);
    const error = await graph.send(fresh(), "AAMk-live-1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceError);
    expect(error).not.toBeInstanceOf(SentButUnverifiedError);
  });

  it("raises sent-but-unverified when the send succeeds and the read-back fails", async () => {
    const { graph } = client([() => empty(202), () => json({ error: { code: "throttled" } }, 429)]);
    const error = await graph.send(fresh(), "AAMk-live-1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SentButUnverifiedError);
    expect(error).toMatchObject({ draftId: "AAMk-live-1", status: 429 });
  });

  it("raises sent-but-unverified when the read-back comes back missing an id", async () => {
    const { graph } = client([() => empty(202), () => json({ id: "AAMk-live-1" })]);
    await expect(graph.send(fresh(), "AAMk-live-1")).rejects.toBeInstanceOf(SentButUnverifiedError);
  });

  it("names the error without quoting Microsoft's response body", async () => {
    const { graph } = client([
      () => json({ error: { code: "ErrorAccessDenied", message: "secret internal detail" } }, 403),
    ]);
    const error = await graph.createDraft(fresh(), draft).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).message).not.toContain("secret internal detail");
    expect((error as ServiceError).code).toBe("ErrorAccessDenied");
  });
});

describe("LiveGraphMailService — read-back and cleanup", () => {
  it("reads one message back to tell a draft from a sent item", async () => {
    const { graph } = client([
      () =>
        json({
          id: "AAMk-live-1",
          internetMessageId: "<live-1@relay.example>",
          conversationId: "AAQk-live-conv-1",
          isDraft: false,
          sentDateTime: "2026-09-02T09:00:00Z",
        }),
    ]);
    await expect(graph.getMessage(fresh(), "AAMk-live-1")).resolves.toEqual({
      id: "AAMk-live-1",
      internetMessageId: "<live-1@relay.example>",
      conversationId: "AAQk-live-conv-1",
      isDraft: false,
      sentDateTime: "2026-09-02T09:00:00Z",
    });
  });

  it("reports a message Microsoft does not have as not found, not as an error", async () => {
    const { graph } = client([() => json({ error: { code: "ErrorItemNotFound" } }, 404)]);
    await expect(graph.getMessage(fresh(), "AAMk-live-1")).resolves.toEqual({ notFound: true });
  });

  it("still raises anything other than a 404 from a read-back", async () => {
    const { graph } = client([() => json({ error: { code: "throttled" } }, 429)]);
    await expect(graph.getMessage(fresh(), "AAMk-live-1")).rejects.toBeInstanceOf(ServiceError);
  });

  it("treats a draft that is already gone as deleted", async () => {
    const { graph } = client([() => json({ error: { code: "ErrorItemNotFound" } }, 404)]);
    await expect(graph.deleteDraft(fresh(), "AAMk-live-1")).resolves.toBeUndefined();
  });

  it("still raises anything other than a 404 from a delete", async () => {
    const { graph } = client([() => json({ error: { code: "ErrorAccessDenied" } }, 403)]);
    await expect(graph.deleteDraft(fresh(), "AAMk-live-1")).rejects.toBeInstanceOf(ServiceError);
  });
});

describe("LiveGraphMailService — tokens", () => {
  it("refreshes an expired access token before the call, and reports the new one", async () => {
    const onTokenRefresh = vi.fn();
    const { graph, calls } = client(
      [
        () => json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 }),
        () => json({ id: "AAMk-live-1" }),
      ],
      { onTokenRefresh },
    );

    await graph.createDraft(expired(), draft);

    expect(calls[0]?.url).toBe("https://login.microsoftonline.com/tenant-123/oauth2/v2.0/token");
    const form = new URLSearchParams(calls[0]?.body ?? "");
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("refresh-1");
    expect(form.get("client_id")).toBe("ms-client");
    expect(calls[1]?.headers.Authorization).toBe("Bearer access-2");

    // The adapter does not write to the database. The rotated token reaches the
    // caller through this hook or it is lost at the end of the process.
    const tokens = onTokenRefresh.mock.calls[0]?.[1] as MailTokens;
    expect(tokens).toEqual({
      accessToken: "access-2",
      refreshToken: "refresh-2",
      expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
    });
    const ref = onTokenRefresh.mock.calls[0]?.[0] as ConnectedAccountRef;
    expect(ref).toMatchObject({ id: "acc_1", orgId: "org_1", userId: "user_1" });
  });

  it("keeps the old refresh token when Microsoft rotates only the access token", async () => {
    const onTokenRefresh = vi.fn();
    const { graph } = client(
      [() => json({ access_token: "access-2", expires_in: 3600 }), () => json({ id: "AAMk-live-1" })],
      { onTokenRefresh },
    );
    await graph.createDraft(expired(), draft);
    expect((onTokenRefresh.mock.calls[0]?.[1] as MailTokens).refreshToken).toBe("refresh-1");
  });

  it("refreshes once and retries when a call comes back 401", async () => {
    const { graph, calls } = client([
      () => json({ error: { code: "InvalidAuthenticationToken" } }, 401),
      () => json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 }),
      () => json({ id: "AAMk-live-1" }),
    ]);

    expect(await graph.createDraft(fresh(), draft)).toEqual({ id: "AAMk-live-1" });
    expect(calls).toHaveLength(3);
    expect(calls[2]?.headers.Authorization).toBe("Bearer access-2");
  });

  it("does not retry a second time when the retried call is refused again", async () => {
    const { graph, calls } = client([
      () => json({ error: { code: "InvalidAuthenticationToken" } }, 401),
      () => json({ access_token: "access-2", expires_in: 3600 }),
      () => json({ error: { code: "InvalidAuthenticationToken" } }, 401),
    ]);
    await expect(graph.createDraft(fresh(), draft)).rejects.toBeInstanceOf(ServiceError);
    expect(calls).toHaveLength(3);
  });

  it("tells the caller when the refresh is refused, and still throws", async () => {
    const onRefreshFailed = vi.fn();
    const { graph } = client([() => json({ error: "invalid_grant" }, 400)], { onRefreshFailed });

    const error = await graph.createDraft(expired(), draft).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceError);
    expect(error).toMatchObject({ status: 400, code: "invalid_grant" });
    // 400/401 is what says the refresh token is spent, which is what Settings
    // reads to tell the rep their mailbox needs re-linking (Task 10b).
    expect(onRefreshFailed).toHaveBeenCalledTimes(1);
    expect(onRefreshFailed.mock.calls[0]?.[0]).toMatchObject({ id: "acc_1", orgId: "org_1" });
  });

  it("refreshes once for two calls on one account, not twice", async () => {
    // The earlier version of this asserted zero token calls for two requests on
    // an UNEXPIRED account, which holds whether or not the cache exists. It has
    // to start expired for the cache to be what is under test.
    const { graph, calls } = client([
      () => json({ access_token: "access-2", expires_in: 3600 }),
      () => json({ id: "AAMk-live-1" }),
    ]);
    const expiredAccount = expired();
    await graph.createDraft(expiredAccount, draft);
    await graph.createDraft(expiredAccount, draft);
    expect(calls.filter((c) => c.url.includes("login.microsoftonline.com"))).toHaveLength(1);
    expect(calls.at(-1)?.headers.Authorization).toBe("Bearer access-2");
  });

  it("makes one token call when two requests race an expired token", async () => {
    // A poller and a send worker arriving together must not each POST the same
    // refresh token: AAD rotates it twice and its reuse detection can kill the
    // whole family, disconnecting a mailbox for no reason.
    const { graph, calls } = client([
      () => json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 }),
      () => json({ id: "AAMk-live-1" }),
    ]);
    const expiredAccount = expired();
    await Promise.all([
      graph.createDraft(expiredAccount, draft),
      graph.createDraft(expiredAccount, draft),
    ]);
    const tokenCalls = calls.filter((c) => c.url.includes("login.microsoftonline.com"));
    expect(tokenCalls).toHaveLength(1);
    expect(new URLSearchParams(tokenCalls[0]?.body ?? "").get("refresh_token")).toBe("refresh-1");
  });

  it("stops trusting cached tokens once the caller's blob has changed", async () => {
    // Another process rotated and persisted; this caller re-read the row. The
    // cache is keyed on the blob it came from, so the fresh chain wins.
    const { graph, calls } = client([
      () => json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 }),
      () => json({ id: "AAMk-live-1" }),
      () => json({ access_token: "access-3", refresh_token: "refresh-3", expires_in: 3600 }),
      () => json({ id: "AAMk-live-2" }),
    ]);
    await graph.createDraft(expired(), draft);

    const rotated: ConnectedAccountRef = {
      ...expired(),
      encTokens: encryptToken(
        JSON.stringify({
          accessToken: "access-77",
          refreshToken: "refresh-77",
          expiresAt: "2026-09-02T08:00:00.000Z",
        }),
        TEST_ENC_KEY,
      ),
    };
    await graph.createDraft(rotated, draft);

    const tokenCalls = calls.filter((c) => c.url.includes("login.microsoftonline.com"));
    expect(tokenCalls).toHaveLength(2);
    expect(new URLSearchParams(tokenCalls[1]?.body ?? "").get("refresh_token")).toBe("refresh-77");
  });

  it("does not ask for a scope the connect flow never consented to", async () => {
    // The refresh_token grant defaults to the original consent, and AAD requires
    // any scope sent to be a subset of it. Naming Mail.Send — which BASE_SCOPES
    // deliberately omits — fails the first refresh of every read-only account.
    const { graph, calls } = client([
      () => json({ access_token: "access-2", expires_in: 3600 }),
      () => json({ id: "AAMk-live-1" }),
    ]);
    await graph.createDraft(expired(), draft);
    expect(new URLSearchParams(calls[0]?.body ?? "").get("scope")).toBeNull();
  });

  it("refuses a 200 refresh that carries no access token", async () => {
    // Cached, an empty token sends `Bearer ` for an hour and — through
    // onTokenRefresh — writes an empty token into the account row.
    const onTokenRefresh = vi.fn();
    const { graph, calls } = client(
      [() => json({ refresh_token: "refresh-2", expires_in: 3600 })],
      { onTokenRefresh },
    );
    await expect(graph.createDraft(expired(), draft)).rejects.toMatchObject({
      code: "malformed_response",
    });
    expect(onTokenRefresh).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it("does not report a transient token-endpoint failure as a spent token", async () => {
    // 400/401 means the refresh token is gone. A 503 means AAD is having a
    // moment, and telling the caller would ask every rep to re-link a healthy
    // mailbox.
    const onRefreshFailed = vi.fn();
    const { graph } = client([() => json({ error: "temporarily_unavailable" }, 503)], {
      onRefreshFailed,
    });
    await expect(graph.createDraft(expired(), draft)).rejects.toMatchObject({ status: 503 });
    expect(onRefreshFailed).not.toHaveBeenCalled();
  });

  it("refreshes rather than trusting a token blob with an unreadable expiry", async () => {
    const { graph, calls } = client([
      () => json({ access_token: "access-2", expires_in: 3600 }),
      () => json({ id: "AAMk-live-1" }),
    ]);
    await graph.createDraft(account("not a date"), draft);
    expect(calls[0]?.url).toContain("login.microsoftonline.com");
  });

  it("refuses to build a request when the Microsoft credentials are absent", async () => {
    const fetchStub = stubFetch([() => json({})]);
    const graph = new LiveGraphMailService(
      { ...testEnv(), RELAY_MS_CLIENT_SECRET: undefined },
      { fetchImpl: fetchStub.impl, now },
    );
    await expect(graph.createDraft(expired(), draft)).rejects.toThrow(/RELAY_MS_\*/);
    expect(fetchStub.calls).toHaveLength(0);
  });

  it("refuses to read a token when it was handed no key, rather than finding one", async () => {
    // `decryptToken(blob, undefined)` falls back to reading TOKEN_ENC_KEY off
    // `process.env`. The key is optional in `env.ts`, so the type permits
    // `undefined` here — and a client built directly (the connect flow, a smoke
    // probe) could then decrypt under an ambient key it was never given.
    const previous = process.env.TOKEN_ENC_KEY;
    process.env.TOKEN_ENC_KEY = TEST_ENC_KEY;
    try {
      const fetchStub = stubFetch([() => json({ id: "AAMk-live-1" })]);
      const graph = new LiveGraphMailService(
        { ...testEnv(), TOKEN_ENC_KEY: undefined },
        { fetchImpl: fetchStub.impl, now },
      );
      // The ambient key WOULD decrypt this blob. The client must still refuse.
      await expect(graph.createDraft(fresh(), draft)).rejects.toThrow(/TOKEN_ENC_KEY is not configured/);
      expect(fetchStub.calls).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.TOKEN_ENC_KEY;
      else process.env.TOKEN_ENC_KEY = previous;
    }
  });

  it("decrypts under the key it was handed, not one off the process environment", async () => {
    // The whole client is a function of the env it was given. Reading
    // TOKEN_ENC_KEY off `process.env` instead would make this pass by accident
    // in a process that happened to have the same key set.
    const wrongKey = Buffer.alloc(32, 9).toString("base64");
    const fetchStub = stubFetch([() => json({ id: "AAMk-live-1" })]);
    const graph = new LiveGraphMailService(
      { ...testEnv(), TOKEN_ENC_KEY: wrongKey },
      { fetchImpl: fetchStub.impl, now },
    );
    await expect(graph.createDraft(fresh(), draft)).rejects.toThrow();
    expect(fetchStub.calls).toHaveLength(0);
  });
});
