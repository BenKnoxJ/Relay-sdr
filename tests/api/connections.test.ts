import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as graphCallbackRoute } from "@/app/api/oauth/graph/callback/route";
import { mailboxCopy } from "@/lib/copy/settings";
import { prisma } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { ORG_DEFAULT_DAILY_CAP, getMailbox } from "@/lib/repo/connections";
import { STATE_TTL_MS, createState } from "@/lib/repo/oauthState";
import { decryptToken } from "@/lib/services/crypto";
import { BASE_SCOPES, MOCK_EXCHANGE_TOKENS, SEND_SCOPE } from "@/lib/services/graphMail";
import { appRouter } from "@/server/api/root";
import { type TRPCContext } from "@/server/api/trpc";
import { completeGraphConnect } from "@/server/auth/graphCallback";
import { type Session } from "@/server/auth/session";
import { ensureUser, type Actor } from "@/server/auth/upsertUser";

import { emptyAll, resetDatabase } from "../db/harness";

/**
 * The connect flow's request half: the rep-facing router, and the callback
 * (Task 10b, master doc §19, §23.1f).
 *
 * Same seam `tests/api/me.test.ts` uses — the real router over the real
 * database with only the identity provider stubbed — because the questions
 * worth asking here are all about what the procedure does with the session it
 * was given, not about tRPC.
 */

/** Same reason as `tests/api/me.test.ts`: the module will not load outside an RSC. */
vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: null }),
  currentUser: async () => null,
}));

const KEY = randomBytes(32).toString("base64");
const APP_URL = "https://relay.example.test";

beforeAll(async () => {
  process.env.TOKEN_ENC_KEY = KEY;
  process.env.APP_URL = APP_URL;
  resetEnv();
  await resetDatabase();
}, 120_000);

afterAll(async () => {
  delete process.env.TOKEN_ENC_KEY;
  delete process.env.APP_URL;
  resetEnv();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await emptyAll();
});

function contextFor(session: Session | null): TRPCContext {
  let pending: Promise<Actor> | undefined;
  return {
    prisma,
    headers: new Headers(),
    session,
    actor: () => {
      if (session === null) return Promise.reject(new Error("not signed in"));
      return (pending ??= ensureUser(prisma, session));
    },
  };
}

const caller = (session: Session | null) => appRouter.createCaller(contextFor(session));

function sessionOf(clerkId: string, email: string): Session {
  return { clerkId, profile: async () => ({ email, name: null }) };
}

const boss = () => sessionOf("user_boss", "boss@example.test");

/**
 * `connections.get` in its connected shape. The union is the point of the
 * return type — a caller cannot read `cap` off a card that has no mailbox —
 * so a test that wants the cap says so rather than casting.
 */
async function connectedCard(session: Session) {
  const card = await caller(session).connections.get();
  if (!card.connected) throw new Error("expected a connected mailbox");
  return card;
}
const rep = () => sessionOf("user_rep", "rep@example.test");

/** Sign the rep in, and walk the whole connect the way a browser would. */
async function connectFor(session: Session): Promise<Actor> {
  const actor = await ensureUser(prisma, session);
  const { url } = await caller(session).connections.startGraphConnect();
  const params = new URL(url).searchParams;

  const outcome = await completeGraphConnect(prisma, {
    code: params.get("code"),
    state: params.get("state"),
    error: null,
    actorUserId: actor.userId,
  });
  expect(outcome).toEqual({ ok: true });
  return actor;
}

describe("connections.startGraphConnect", () => {
  it("refuses a caller with no session", async () => {
    await expect(caller(null).connections.startGraphConnect()).rejects.toThrow();
  });

  it("mints a state row for the signed-in rep and puts it in the url", async () => {
    const actor = await ensureUser(prisma, boss());

    const { url } = await caller(boss()).connections.startGraphConnect();
    const state = new URL(url).searchParams.get("state");

    const row = await prisma.oAuthState.findUnique({ where: { state: state ?? "" } });
    expect(row).toMatchObject({ orgId: actor.orgId, userId: actor.userId, provider: "graph" });
  });

  it("sends the rep back to Relay's own callback under INTEGRATIONS=mock", async () => {
    await ensureUser(prisma, boss());
    const { url } = await caller(boss()).connections.startGraphConnect();

    expect(url.startsWith(`${APP_URL}/api/oauth/graph/callback?`)).toBe(true);
  });

  it("asks Microsoft for read and send together when it is live", async () => {
    await ensureUser(prisma, boss());
    process.env.INTEGRATIONS = "live";
    process.env.RELAY_MS_CLIENT_ID = "client-id";
    process.env.RELAY_MS_TENANT_ID = "tenant-id";
    resetEnv();

    try {
      const { url } = await caller(boss()).connections.startGraphConnect();
      const params = new URL(url).searchParams;

      expect(url.startsWith("https://login.microsoftonline.com/tenant-id/oauth2/v2.0/authorize")).toBe(
        true,
      );
      expect(params.get("scope")).toBe([...BASE_SCOPES, SEND_SCOPE].join(" "));
      expect(params.get("redirect_uri")).toBe(`${APP_URL}/api/oauth/graph/callback`);
      expect(params.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    } finally {
      process.env.INTEGRATIONS = "mock";
      delete process.env.RELAY_MS_CLIENT_ID;
      delete process.env.RELAY_MS_TENANT_ID;
      resetEnv();
    }
  });

  it("refuses before the consent screen when there is nowhere to store the result", async () => {
    await ensureUser(prisma, boss());
    delete process.env.TOKEN_ENC_KEY;
    resetEnv();

    try {
      await expect(caller(boss()).connections.startGraphConnect()).rejects.toThrow(
        mailboxCopy.failedSetup,
      );
    } finally {
      process.env.TOKEN_ENC_KEY = KEY;
      resetEnv();
    }
  });

  it("says so plainly when this copy of Relay cannot connect a mailbox", async () => {
    await ensureUser(prisma, boss());
    process.env.INTEGRATIONS = "live";
    resetEnv();

    try {
      await expect(caller(boss()).connections.startGraphConnect()).rejects.toThrow(
        mailboxCopy.failedSetup,
      );
    } finally {
      process.env.INTEGRATIONS = "mock";
      resetEnv();
    }
  });
});

describe("the Graph callback", () => {
  it("stores an encrypted blob that decrypts to the mock token set", async () => {
    const actor = await connectFor(boss());

    const account = await getMailbox(prisma, actor);
    expect(account?.status).toBe("healthy");
    expect(account?.encTokens).not.toContain(MOCK_EXCHANGE_TOKENS.refreshToken);

    const stored = JSON.parse(decryptToken(account?.encTokens ?? ""));
    expect(stored).toMatchObject({
      accessToken: MOCK_EXCHANGE_TOKENS.accessToken,
      refreshToken: MOCK_EXCHANGE_TOKENS.refreshToken,
    });
    expect(account?.scopes).toEqual([...MOCK_EXCHANGE_TOKENS.scopes]);
  });

  it("refuses the same callback twice", async () => {
    const actor = await ensureUser(prisma, boss());
    const { url } = await caller(boss()).connections.startGraphConnect();
    const params = new URL(url).searchParams;
    const args = {
      code: params.get("code"),
      state: params.get("state"),
      error: null,
      actorUserId: actor.userId,
    };

    expect(await completeGraphConnect(prisma, args)).toEqual({ ok: true });
    expect(await completeGraphConnect(prisma, args)).toEqual({ ok: false, reason: "link" });
  });

  it("refuses a state one rep minted and another rep opened", async () => {
    await ensureUser(prisma, boss());
    const other = await ensureUser(prisma, rep());
    const { url } = await caller(boss()).connections.startGraphConnect();
    const params = new URL(url).searchParams;

    const outcome = await completeGraphConnect(prisma, {
      code: params.get("code"),
      state: params.get("state"),
      error: null,
      actorUserId: other.userId,
    });

    expect(outcome).toEqual({ ok: false, reason: "link" });
    expect(await getMailbox(prisma, other)).toBeNull();
  });

  it("refuses a state that has run out", async () => {
    const actor = await ensureUser(prisma, boss());
    const state = await createState(prisma, {
      orgId: actor.orgId,
      userId: actor.userId,
      provider: "graph",
      now: new Date(Date.now() - STATE_TTL_MS - 1_000),
    });

    expect(
      await completeGraphConnect(prisma, { code: "any", state, error: null, actorUserId: actor.userId }),
    ).toEqual({ ok: false, reason: "link" });
    expect(await getMailbox(prisma, actor)).toBeNull();
  });

  it("comes back with a sentence, not a 500, when there is nowhere to store a token", async () => {
    const actor = await ensureUser(prisma, boss());
    const { url } = await caller(boss()).connections.startGraphConnect();
    const params = new URL(url).searchParams;
    delete process.env.TOKEN_ENC_KEY;
    resetEnv();

    try {
      expect(
        await completeGraphConnect(prisma, {
          code: params.get("code"),
          state: params.get("state"),
          error: null,
          actorUserId: actor.userId,
        }),
      ).toEqual({ ok: false, reason: "setup" });
    } finally {
      process.env.TOKEN_ENC_KEY = KEY;
      resetEnv();
    }
  });

  it("refuses a state nobody minted, and a callback with no state at all", async () => {
    const actor = await ensureUser(prisma, boss());
    const args = { code: "any", error: null, actorUserId: actor.userId };

    expect(await completeGraphConnect(prisma, { ...args, state: "invented" })).toEqual({
      ok: false,
      reason: "link",
    });
    expect(await completeGraphConnect(prisma, { ...args, state: null })).toEqual({
      ok: false,
      reason: "link",
    });
  });

  it("treats a refusal at Microsoft as the provider's failure, and says nothing it said", async () => {
    const actor = await ensureUser(prisma, boss());
    const { url } = await caller(boss()).connections.startGraphConnect();
    const state = new URL(url).searchParams.get("state");

    const outcome = await completeGraphConnect(prisma, {
      code: null,
      state,
      error: "access_denied",
      actorUserId: actor.userId,
    });

    expect(outcome).toEqual({ ok: false, reason: "provider" });
    // The state survives a refusal at the consent screen: the rep pressing
    // Connect again should not be blocked by a link they never used.
    expect(await prisma.oAuthState.findUnique({ where: { state: state ?? "" } })).not.toBeNull();
    expect(await getMailbox(prisma, actor)).toBeNull();
  });
});

describe("connections.get", () => {
  it("says nothing is connected before the rep connects", async () => {
    await ensureUser(prisma, boss());

    const card = await caller(boss()).connections.get();

    expect(card).toMatchObject({ connected: false, adminCap: ORG_DEFAULT_DAILY_CAP });
  });

  it("renders the signed card once the mailbox is connected", async () => {
    await connectFor(boss());

    const card = await caller(boss()).connections.get();

    expect(card).toMatchObject({
      connected: true,
      address: "boss@example.test",
      provider: mailboxCopy.provider,
      health: mailboxCopy.healthy,
      healthTone: "ok",
      cap: ORG_DEFAULT_DAILY_CAP,
      adminCap: ORG_DEFAULT_DAILY_CAP,
      capNote: `of ${ORG_DEFAULT_DAILY_CAP} set by your admin`,
      window: "09:00 to 16:30",
      days: "Monday, Tuesday, Wednesday, Thursday",
      ramp: "Starts at 5 a day and builds up.",
    });
  });

  it("shows the re-link chip when the provider stopped accepting the connection", async () => {
    const actor = await connectFor(boss());
    const account = await getMailbox(prisma, actor);
    await prisma.connectedAccount.update({
      where: { id: account?.id ?? "" },
      data: { status: "expiring" },
    });

    const card = await caller(boss()).connections.get();

    expect(card).toMatchObject({
      connected: true,
      health: mailboxCopy.needsRelink,
      healthTone: "warn",
      healthNote: mailboxCopy.needsRelinkWhy,
    });
  });

  it("reads a disconnected mailbox as no mailbox", async () => {
    await connectFor(boss());
    await caller(boss()).connections.disconnectGraph();

    expect(await caller(boss()).connections.get()).toMatchObject({ connected: false });
  });

  it("shows one rep nothing of another rep's mailbox", async () => {
    await connectFor(boss());
    await ensureUser(prisma, rep());

    expect(await caller(rep()).connections.get()).toMatchObject({ connected: false });
  });
});

describe("connections.setDailyCap", () => {
  it("lets the rep lower their cap and confirms it quietly", async () => {
    await connectFor(boss());

    expect(await caller(boss()).connections.setDailyCap({ cap: 4 })).toEqual({
      cap: 4,
      saved: mailboxCopy.saved,
    });
    expect((await connectedCard(boss())).cap).toBe(4);
  });

  it("refuses to raise the cap past the admin's ceiling", async () => {
    await connectFor(boss());
    await caller(boss()).connections.setDailyCap({ cap: 2 });

    await expect(
      caller(boss()).connections.setDailyCap({ cap: ORG_DEFAULT_DAILY_CAP + 1 }),
    ).rejects.toThrow(mailboxCopy.capTooHigh);
    expect((await connectedCard(boss())).cap).toBe(2);
  });

  it("refuses a cap for a mailbox that is not connected", async () => {
    await ensureUser(prisma, boss());

    await expect(caller(boss()).connections.setDailyCap({ cap: 3 })).rejects.toThrow(
      mailboxCopy.none,
    );
  });

  // Same sentence as never having connected one, and the same refusal: the
  // card the rep is looking at after a disconnect has no cap field on it, so a
  // request that sets one came from a stale page.
  it("refuses a cap for a mailbox the rep just disconnected", async () => {
    await connectFor(boss());
    await caller(boss()).connections.disconnectGraph();

    await expect(caller(boss()).connections.setDailyCap({ cap: 3 })).rejects.toThrow(
      mailboxCopy.none,
    );
  });
});

describe("me.get", () => {
  it("stops asking Home to connect a mailbox once one is connected", async () => {
    await ensureUser(prisma, boss());
    expect((await caller(boss()).me.get()).connections.mailbox).toBe(false);

    await connectFor(boss());
    expect((await caller(boss()).me.get()).connections.mailbox).toBe(true);

    await caller(boss()).connections.disconnectGraph();
    expect((await caller(boss()).me.get()).connections.mailbox).toBe(false);
  });
});

describe("the callback route's redirect", () => {
  /** The route with nobody signed in: the cheapest path that still redirects. */
  const hit = (url: string) => graphCallbackRoute(new Request(url));

  // The rep lands here from Microsoft, so the Host on the request is only ever
  // as trustworthy as whatever proxy sat in front of it. The origin they are
  // sent on to is Relay's own, decided by configuration.
  it("sends the rep to APP_URL's origin, whatever host the request claimed", async () => {
    const response = await hit("https://attacker.example/api/oauth/graph/callback?state=x");

    expect(response.headers.get("location")).toBe(`${APP_URL}/settings?connect=link`);
  });

  // The one case with no configured origin to use. `APP_URL` is optional, and
  // a laptop running `next dev` has not set it.
  it("falls back to the request's own origin only when APP_URL is unset", async () => {
    delete process.env.APP_URL;
    resetEnv();

    try {
      const response = await hit("http://localhost:3000/api/oauth/graph/callback");
      expect(response.headers.get("location")).toBe("http://localhost:3000/settings?connect=link");
    } finally {
      process.env.APP_URL = APP_URL;
      resetEnv();
    }
  });
});
