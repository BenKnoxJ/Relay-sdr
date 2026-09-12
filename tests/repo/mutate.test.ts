import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db";
import { mutate } from "@/lib/repo/mutate";

import { emptyAll, resetDatabase } from "../db/harness";

// Rule 4 of master doc §25: a state change and its Event commit in one
// transaction. `mutate` is the only place that can honour it, so these tests
// are the rule — not a description of one function's behaviour.

const ORG_ID = "org_mutate_test";
const USER_ID = "user_mutate_test";

// Rebuild rather than only migrate. `migrate deploy` onto whatever the last
// run left behind fails the moment a migration is regenerated or a branch is
// switched, and it makes this file's result depend on which file ran before
// it. `fileParallelism` is off, so each DB file starting from empty is both
// safe and the cheapest way to have no ordering to reason about.
beforeAll(async () => {
  await resetDatabase();
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await emptyAll();
  await mutate(prisma, {
    orgId: ORG_ID,
    actor: { kind: "system" },
    kind: "org.created",
    apply: (tx) => tx.org.create({ data: { id: ORG_ID, name: "Test Org" } }),
  });
  await mutate(prisma, {
    orgId: ORG_ID,
    actor: { kind: "system" },
    kind: "user.upserted",
    apply: (tx) =>
      tx.user.create({
        data: { id: USER_ID, orgId: ORG_ID, email: "rep@example.test", name: "Rep", role: "rep" },
      }),
  });
});

describe("mutate", () => {
  it("@proof writes exactly one Event per mutation", async () => {
    const before = await prisma.event.count();

    for (let index = 0; index < 5; index += 1) {
      await mutate(prisma, {
        orgId: ORG_ID,
        actor: { kind: "user", userId: USER_ID },
        kind: "account.connected",
        apply: (tx) =>
          tx.oAuthState.create({
            data: {
              orgId: ORG_ID,
              userId: USER_ID,
              provider: "graph",
              state: `state-${index}`,
              expiresAt: new Date(Date.now() + 60_000),
            },
          }),
      });
    }

    expect(await prisma.event.count()).toBe(before + 5);
    expect(await prisma.oAuthState.count()).toBe(5);
  });

  it("records the kind, actor and the before/after pair", async () => {
    await mutate(prisma, {
      orgId: ORG_ID,
      actor: { kind: "user", userId: USER_ID },
      kind: "account.disconnected",
      campaignId: "campaign-1",
      personId: "person-1",
      before: { status: "healthy" },
      after: { status: "revoked" },
      apply: async () => undefined,
    });

    const event = await prisma.event.findFirstOrThrow({
      where: { kind: "account.disconnected" },
    });

    expect(event.orgId).toBe(ORG_ID);
    expect(event.actorKind).toBe("user");
    expect(event.actorUserId).toBe(USER_ID);
    expect(event.campaignId).toBe("campaign-1");
    expect(event.personId).toBe("person-1");
    expect(event.before).toEqual({ status: "healthy" });
    expect(event.after).toEqual({ status: "revoked" });
  });

  it("allows a system actor, with no user attached", async () => {
    const event = await prisma.event.findFirstOrThrow({ where: { kind: "org.created" } });

    expect(event.actorKind).toBe("system");
    expect(event.actorUserId).toBeNull();
  });

  it("leaves before and after null when they are not supplied", async () => {
    const event = await prisma.event.findFirstOrThrow({ where: { kind: "org.created" } });

    expect(event.before).toBeNull();
    expect(event.after).toBeNull();
  });

  it("stamps the Event now, or at the time the caller gives it", async () => {
    const backdated = new Date("2026-01-02T03:04:05.000Z");
    await mutate(prisma, {
      orgId: ORG_ID,
      actor: { kind: "system" },
      kind: "account.connected",
      at: backdated,
      apply: async () => undefined,
    });

    const supplied = await prisma.event.findFirstOrThrow({ where: { kind: "account.connected" } });
    expect(supplied.at).toEqual(backdated);
    // `createdAt` still records the insert, so a backdated Event and one that
    // really happened then are told apart.
    expect(supplied.createdAt.getTime()).toBeGreaterThan(backdated.getTime());

    const stampedNow = await prisma.event.findFirstOrThrow({ where: { kind: "org.created" } });
    expect(stampedNow.at.getTime()).toBeGreaterThan(backdated.getTime());
  });

  it("returns whatever apply returned", async () => {
    const created = await mutate(prisma, {
      orgId: ORG_ID,
      actor: { kind: "system" },
      kind: "account.connected",
      apply: (tx) =>
        tx.oAuthState.create({
          data: {
            orgId: ORG_ID,
            userId: USER_ID,
            provider: "zoho",
            state: "returned",
            expiresAt: new Date(Date.now() + 60_000),
          },
        }),
    });

    expect(created.state).toBe("returned");
  });

  it("can take the Event's campaign from what apply wrote, for the change that makes the row", async () => {
    const created = await mutate(prisma, {
      orgId: ORG_ID,
      actor: { kind: "system" },
      kind: "account.connected",
      campaignId: (row: { state: string }) => `campaign-for-${row.state}`,
      apply: (tx) =>
        tx.oAuthState.create({
          data: { orgId: ORG_ID, userId: USER_ID, provider: "zoho", state: "derived", expiresAt: new Date(Date.now() + 60_000) },
        }),
    });

    const event = await prisma.event.findFirstOrThrow({ where: { kind: "account.connected" } });
    expect(event.campaignId).toBe(`campaign-for-${created.state}`);
  });

  it("@proof rolls the Event back when apply throws", async () => {
    const eventsBefore = await prisma.event.count();

    await expect(
      mutate(prisma, {
        orgId: ORG_ID,
        actor: { kind: "system" },
        kind: "account.connected",
        apply: async (tx) => {
          await tx.oAuthState.create({
            data: {
              orgId: ORG_ID,
              userId: USER_ID,
              provider: "linkedin",
              state: "doomed",
              expiresAt: new Date(Date.now() + 60_000),
            },
          });
          throw new Error("apply failed");
        },
      }),
    ).rejects.toThrow("apply failed");

    // Both halves must be gone: the Event, and the row the apply had already
    // written before it threw. One without the other is the failure this rule
    // exists to make impossible.
    expect(await prisma.event.count()).toBe(eventsBefore);
    expect(await prisma.oAuthState.findUnique({ where: { state: "doomed" } })).toBeNull();
  });

  it("@proof rolls the state change back when the Event insert fails", async () => {
    // The other direction of rule 4. An org that does not exist fails the
    // Event's foreign key and nothing else, so the apply succeeds and only the
    // Event insert fails.
    const eventsBefore = await prisma.event.count();

    await expect(
      mutate(prisma, {
        orgId: "org-does-not-exist",
        actor: { kind: "system" },
        kind: "org.created",
        apply: (tx) =>
          tx.oAuthState.create({
            data: {
              orgId: ORG_ID,
              userId: USER_ID,
              provider: "lusha",
              state: "orphan",
              expiresAt: new Date(Date.now() + 60_000),
            },
          }),
      }),
    ).rejects.toThrow();

    expect(await prisma.event.count()).toBe(eventsBefore);
    expect(await prisma.oAuthState.findUnique({ where: { state: "orphan" } })).toBeNull();
  });

  it("refuses an empty kind or org", async () => {
    await expect(
      mutate(prisma, {
        orgId: ORG_ID,
        actor: { kind: "system" },
        // A caller reaching this through an `as` cast or from JavaScript is the
        // case the type system cannot cover.
        kind: "  " as never,
        apply: async () => undefined,
      }),
    ).rejects.toThrow(/kind/i);

    await expect(
      mutate(prisma, {
        orgId: "",
        actor: { kind: "system" },
        kind: "org.created",
        apply: async () => undefined,
      }),
    ).rejects.toThrow(/orgId/i);

    expect(await prisma.event.count()).toBe(2);
  });
});
