import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import {
  CapOutOfRangeError,
  ConnectStateInvalidError,
  ORG_DEFAULT_DAILY_CAP,
  connectMailboxFromState,
  connectionHooks,
  disconnectMailbox,
  getMailbox,
  markExpiring,
  refFor,
  setDailyCap,
  updateTokens,
} from "@/lib/repo/connections";
import { STATE_TTL_MS, createState, spendState } from "@/lib/repo/oauthState";
import { decryptToken } from "@/lib/services/crypto";
import type { MailTokens } from "@/lib/services/types";

import { emptyAll, resetDatabase } from "../db/harness";

/**
 * The connect flow's write half (Task 10b, master doc §19 and §24).
 *
 * Against the real database, because every property that matters here is one
 * only Postgres can be asked about: whether a state can be spent twice, whether
 * a rolled-back upsert takes the spend with it, and whether a refusal lands as
 * zero rows rather than as a caller's `if`.
 */

const KEY = randomBytes(32).toString("base64");

const TOKENS: MailTokens = {
  accessToken: "access-token-value",
  refreshToken: "refresh-token-value",
  expiresAt: "2026-10-14T08:00:00.000Z",
};
const SCOPES = ["offline_access", "User.Read", "Mail.ReadWrite", "Mail.Send"];

beforeAll(async () => {
  process.env.TOKEN_ENC_KEY = KEY;
  resetEnv();
  await resetDatabase();
}, 120_000);

afterAll(async () => {
  delete process.env.TOKEN_ENC_KEY;
  resetEnv();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await emptyAll();
});

/** An org with one rep in it, written directly: fixtures are not domain events. */
async function seedRep(): Promise<{ orgId: string; userId: string }> {
  const org = await prisma.org.create({ data: { id: "example.test", name: "example.test" } });
  const user = await prisma.user.create({
    data: { orgId: org.id, clerkId: "user_rep", email: "rep@example.test", role: "rep" },
  });
  return { orgId: org.id, userId: user.id };
}

/** Every Event kind written since the last truncate, oldest first. */
async function eventKinds(): Promise<string[]> {
  const rows = await prisma.event.findMany({ orderBy: { createdAt: "asc" }, select: { kind: true } });
  return rows.map((row) => row.kind);
}

describe("createState / spendState", () => {
  it("mints a state, records the start, and reads back once", async () => {
    const { orgId, userId } = await seedRep();
    const now = new Date("2026-10-14T07:00:00.000Z");

    const state = await createState(prisma, { orgId, userId, provider: "graph", now });

    // 32 bytes of base64url is 43 characters with no padding, and nothing in
    // it needs escaping in a query string.
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await eventKinds()).toEqual(["account.connect_started"]);

    const row = await prisma.oAuthState.findUnique({ where: { state } });
    expect(row).toMatchObject({ orgId, userId, provider: "graph" });
    expect(row?.expiresAt.getTime()).toBe(now.getTime() + STATE_TTL_MS);
  });

  it("mints a different state every time", async () => {
    const { orgId, userId } = await seedRep();
    const states = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      states.add(await createState(prisma, { orgId, userId, provider: "graph" }));
    }
    expect(states.size).toBe(5);
  });

  it("spends a state exactly once", async () => {
    const { orgId, userId } = await seedRep();
    const state = await createState(prisma, { orgId, userId, provider: "graph" });

    expect(await spendState(prisma, state)).toMatchObject({ orgId, userId });
    // The second attempt is the forged-callback case, and it gets nothing.
    expect(await spendState(prisma, state)).toBeNull();
  });

  it("refuses a state that has expired", async () => {
    const { orgId, userId } = await seedRep();
    const issued = new Date(Date.now() - STATE_TTL_MS - 1_000);
    const state = await createState(prisma, { orgId, userId, provider: "graph", now: issued });

    expect(await spendState(prisma, state)).toBeNull();
  });

  it("refuses a state nobody minted", async () => {
    await seedRep();
    expect(await spendState(prisma, "not-a-state-anybody-issued")).toBeNull();
  });
});

describe("connectMailboxFromState", () => {
  async function connect(now = new Date()) {
    const seeded = await seedRep();
    const state = await createState(prisma, { ...seeded, provider: "graph" });
    const account = await connectMailboxFromState(prisma, { state, tokens: TOKENS, scopes: SCOPES, now });
    return { ...seeded, state, account };
  }

  it("stores an encrypted blob that decrypts to the tokens", async () => {
    const { account } = await connect();

    expect(account.encTokens).not.toContain(TOKENS.refreshToken);
    expect(JSON.parse(decryptToken(account.encTokens))).toEqual(TOKENS);
    expect(account.status).toBe("healthy");
    expect(account.scopes).toEqual(SCOPES);
    expect(account.expiresAt?.toISOString()).toBe(TOKENS.expiresAt);
  });

  it("takes the signed §23.1f defaults from the column defaults", async () => {
    const { account } = await connect();

    expect(account.dailyCap).toBe(ORG_DEFAULT_DAILY_CAP);
    expect(account.windowStart).toBe("09:00");
    expect(account.windowEnd).toBe("16:30");
    expect(account.days).toEqual(["mon", "tue", "wed", "thu"]);
    expect(account.rampStart).toBe(5);
  });

  it("writes one account.connected Event, carrying no token", async () => {
    await connect();

    expect(await eventKinds()).toEqual(["account.connect_started", "account.connected"]);
    const [event] = await prisma.event.findMany({ where: { kind: "account.connected" } });
    expect(JSON.stringify(event?.after)).not.toContain(TOKENS.refreshToken);
    expect(JSON.stringify(event?.after)).not.toContain(TOKENS.accessToken);
  });

  it("spends the state, so the same callback cannot be replayed", async () => {
    const { state } = await connect();

    await expect(
      connectMailboxFromState(prisma, { state, tokens: TOKENS, scopes: SCOPES }),
    ).rejects.toThrow(ConnectStateInvalidError);
  });

  it("refuses a state that expired before the callback arrived", async () => {
    const seeded = await seedRep();
    const issued = new Date(Date.now() - STATE_TTL_MS - 1_000);
    const state = await createState(prisma, { ...seeded, provider: "graph", now: issued });

    await expect(
      connectMailboxFromState(prisma, { state, tokens: TOKENS, scopes: SCOPES }),
    ).rejects.toThrow(ConnectStateInvalidError);
    expect(await getMailbox(prisma, seeded)).toBeNull();
  });

  it("refuses a state minted for another provider", async () => {
    const seeded = await seedRep();
    const state = await createState(prisma, { ...seeded, provider: "linkedin" });

    await expect(
      connectMailboxFromState(prisma, { state, tokens: TOKENS, scopes: SCOPES }),
    ).rejects.toThrow(ConnectStateInvalidError);
  });

  it("keeps the rep's own cap and clears the cursor when they re-link", async () => {
    const first = await connect();
    await setDailyCap(prisma, { orgId: first.orgId, userId: first.userId, cap: 3 });
    await prisma.connectedAccount.update({
      where: { id: first.account.id },
      data: { pollCursor: "delta-from-before", status: "expiring" },
    });

    const state = await createState(prisma, {
      orgId: first.orgId,
      userId: first.userId,
      provider: "graph",
    });
    const relinked = await connectMailboxFromState(prisma, { state, tokens: TOKENS, scopes: SCOPES });

    expect(relinked.id).toBe(first.account.id);
    expect(relinked.dailyCap).toBe(3);
    expect(relinked.pollCursor).toBeNull();
    expect(relinked.status).toBe("healthy");
  });
});

describe("disconnectMailbox", () => {
  it("revokes and destroys the only copy of the tokens", async () => {
    const seeded = await seedRep();
    const state = await createState(prisma, { ...seeded, provider: "graph" });
    await connectMailboxFromState(prisma, { state, tokens: TOKENS, scopes: SCOPES });

    const revoked = await disconnectMailbox(prisma, seeded);

    expect(revoked).toMatchObject({ status: "revoked", encTokens: "", pollCursor: null });
    expect(revoked?.scopes).toEqual([]);
    expect(await eventKinds()).toContain("account.disconnected");
  });

  it("leaves the row behind, because nothing is deleted", async () => {
    const seeded = await seedRep();
    const state = await createState(prisma, { ...seeded, provider: "graph" });
    await connectMailboxFromState(prisma, { state, tokens: TOKENS, scopes: SCOPES });
    await disconnectMailbox(prisma, seeded);

    expect(await getMailbox(prisma, seeded)).not.toBeNull();
  });

  it("is quiet when there is nothing connected, and when it is already revoked", async () => {
    const seeded = await seedRep();
    expect(await disconnectMailbox(prisma, seeded)).toBeNull();

    const state = await createState(prisma, { ...seeded, provider: "graph" });
    await connectMailboxFromState(prisma, { state, tokens: TOKENS, scopes: SCOPES });
    await disconnectMailbox(prisma, seeded);
    const before = await eventKinds();
    await disconnectMailbox(prisma, seeded);

    // No second Event: a disconnect that changed nothing is not something that
    // happened.
    expect(await eventKinds()).toEqual(before);
  });
});

describe("setDailyCap", () => {
  async function connected() {
    const seeded = await seedRep();
    const state = await createState(prisma, { ...seeded, provider: "graph" });
    await connectMailboxFromState(prisma, { state, tokens: TOKENS, scopes: SCOPES });
    return seeded;
  }

  it("accepts a cap below the ceiling and records the change", async () => {
    const seeded = await connected();

    expect((await setDailyCap(prisma, { ...seeded, cap: 4 }))?.dailyCap).toBe(4);
    expect(await eventKinds()).toContain("account.cap_changed");
  });

  it("accepts the ceiling itself", async () => {
    const seeded = await connected();
    await setDailyCap(prisma, { ...seeded, cap: 2 });
    expect((await setDailyCap(prisma, { ...seeded, cap: ORG_DEFAULT_DAILY_CAP }))?.dailyCap).toBe(
      ORG_DEFAULT_DAILY_CAP,
    );
  });

  it("refuses a cap above the ceiling, and refuses to raise past it", async () => {
    const seeded = await connected();

    await expect(setDailyCap(prisma, { ...seeded, cap: ORG_DEFAULT_DAILY_CAP + 1 })).rejects.toThrow(
      CapOutOfRangeError,
    );
    expect((await getMailbox(prisma, seeded))?.dailyCap).toBe(ORG_DEFAULT_DAILY_CAP);
  });

  it("refuses zero, a negative and a fraction", async () => {
    const seeded = await connected();
    for (const cap of [0, -1, 2.5]) {
      await expect(setDailyCap(prisma, { ...seeded, cap })).rejects.toThrow(CapOutOfRangeError);
    }
  });

  // A revoked row is not a mailbox with a setting on it, it is the record that
  // one was disconnected. Answering `null` is the same answer the rep gets for
  // never having connected at all, which is what the card shows either way.
  it("refuses a mailbox the rep disconnected, and records nothing", async () => {
    const seeded = await connected();
    await disconnectMailbox(prisma, seeded);
    const before = await eventKinds();

    expect(await setDailyCap(prisma, { ...seeded, cap: 3 })).toBeNull();

    expect(await eventKinds()).toEqual(before);
    expect((await getMailbox(prisma, seeded))?.dailyCap).toBe(ORG_DEFAULT_DAILY_CAP);
  });
});

describe("the refresh hooks", () => {
  async function connectedRef() {
    const seeded = await seedRep();
    const state = await createState(prisma, { ...seeded, provider: "graph" });
    const account = await connectMailboxFromState(prisma, { state, tokens: TOKENS, scopes: SCOPES });
    return { seeded, account, ref: refFor(account) };
  }

  const ROTATED: MailTokens = {
    accessToken: "rotated-access",
    refreshToken: "rotated-refresh",
    expiresAt: "2026-10-14T09:00:00.000Z",
  };

  it("persists a rotated blob and clears expiring", async () => {
    const { seeded, account, ref } = await connectedRef();
    await markExpiring(prisma, ref);
    expect((await getMailbox(prisma, seeded))?.status).toBe("expiring");

    await updateTokens(prisma, ref, ROTATED);

    const after = await getMailbox(prisma, seeded);
    expect(JSON.parse(decryptToken(after?.encTokens ?? ""))).toEqual(ROTATED);
    expect(after?.status).toBe("healthy");
    expect(after?.expiresAt?.toISOString()).toBe(ROTATED.expiresAt);
    expect(after?.encTokens).not.toBe(account.encTokens);
    expect(await eventKinds()).toContain("account.token_refreshed");
  });

  it("never reconnects a mailbox the rep disconnected", async () => {
    const { seeded, ref } = await connectedRef();
    await disconnectMailbox(prisma, seeded);

    await updateTokens(prisma, ref, ROTATED);

    const after = await getMailbox(prisma, seeded);
    expect(after?.status).toBe("revoked");
    expect(after?.encTokens).toBe("");
  });

  it("never overwrites a paused mailbox with expiring", async () => {
    const { seeded, account, ref } = await connectedRef();
    await prisma.connectedAccount.update({
      where: { id: account.id },
      data: { status: "paused", pausedReason: "too many bounces" },
    });

    await markExpiring(prisma, ref);

    expect((await getMailbox(prisma, seeded))?.status).toBe("paused");
  });

  it("refuses a write for one tenant keyed on another tenant's id", async () => {
    const { seeded, ref } = await connectedRef();
    // A real second tenant, so the only thing standing between it and the
    // first org's row is the `orgId` in the WHERE clause.
    const other = await prisma.org.create({ data: { id: "other.test", name: "other.test" } });

    await updateTokens(prisma, { ...ref, orgId: other.id }, ROTATED);

    const after = await getMailbox(prisma, seeded);
    expect(JSON.parse(decryptToken(after?.encTokens ?? ""))).toEqual(TOKENS);
  });

  it("keeps a paused mailbox's tokens fresh without unpausing it", async () => {
    const { seeded, account, ref } = await connectedRef();
    await prisma.connectedAccount.update({
      where: { id: account.id },
      data: { status: "paused", pausedReason: "too many bounces" },
    });

    await updateTokens(prisma, ref, ROTATED);

    const after = await getMailbox(prisma, seeded);
    // The old refresh token is already spent at Microsoft by the time the hook
    // runs, so dropping the new one would leave the row holding a credential
    // that trips reuse detection the next time anybody uses it.
    expect(JSON.parse(decryptToken(after?.encTokens ?? ""))).toEqual(ROTATED);
    expect(after?.status).toBe("paused");
  });

  it("records nothing when there was nothing to record", async () => {
    const { seeded, ref } = await connectedRef();
    await disconnectMailbox(prisma, seeded);
    const before = await eventKinds();

    await updateTokens(prisma, ref, ROTATED);
    await markExpiring(prisma, ref);

    // An Event for a row that did not change is a record of nothing, and
    // `mutate` writes one per transaction unless the transaction is rolled back.
    expect(await eventKinds()).toEqual(before);
  });

  it("refuses to hand a mail adapter a row that is not a mailbox", async () => {
    const { account } = await connectedRef();

    expect(() => refFor({ ...account, provider: "zoho" })).toThrow(/not a provider/);
    expect(refFor({ ...account, provider: "linkedin" }).provider).toBe("linkedin");
  });

  it("hands services() the same deps object every time, so the adapter set is not rebuilt", () => {
    expect(connectionHooks(prisma)).toBe(connectionHooks(prisma));
  });
});
