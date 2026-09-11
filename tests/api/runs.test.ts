import { randomUUID } from "node:crypto";

import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { formatMicroDollars } from "@/lib/agents/pricing";
import { prisma } from "@/lib/db";
import { enqueue } from "@/lib/jobs/queue";
import { appendModelStep, finishRun, startRun } from "@/lib/repo/agentRuns";
import { appRouter } from "@/server/api/root";
import { haltOf } from "@/server/api/routers/runs";
import { type TRPCContext } from "@/server/api/trpc";
import { type Session } from "@/server/auth/session";
import { ensureUser, type Actor } from "@/server/auth/upsertUser";

import { emptyAll, resetDatabase } from "../db/harness";

/**
 * The runs router (Task 9f, master doc §8, §24, §26 item 5).
 *
 * Same seam as `tests/api/connections.test.ts`: the real router over the real
 * database with only the identity provider stubbed. The runs are seeded through
 * the repo's own write path — `startRun`, `appendModelStep`, `finishRun` — so
 * every figure asserted here is one the runtime itself would have written.
 */

/** Same reason as `tests/api/me.test.ts`: the module will not load outside an RSC. */
vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: null }),
  currentUser: async () => null,
}));

beforeAll(async () => {
  await resetDatabase();
}, 120_000);

afterAll(async () => {
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

/** First in from the domain is the admin (§8); the two after are reps. */
const boss = () => sessionOf("user_boss", "boss@example.test");
const rep = () => sessionOf("user_rep", "rep@example.test");
const colleague = () => sessionOf("user_colleague", "colleague@example.test");
/** Another company altogether. */
const stranger = () => sessionOf("user_stranger", "stranger@other.test");

const MODEL = "claude-sonnet-4-5";

type SeedInput = {
  actor: Actor;
  kind?: string;
  /** Step costs, six places, in order. */
  steps?: string[];
  status?: "running" | "done" | "failed";
  error?: string;
};

/**
 * One run for one rep's job, written the way the runtime writes it. The
 * `providerMeta` carries a `rawUsage` block and a request id, so the tests
 * can tell "the admin sees `rawUsage`" from "the admin sees everything".
 */
async function seedRun(input: SeedInput) {
  const kind = input.kind ?? "echo";
  const { job } = await enqueue(prisma, {
    orgId: input.actor.orgId,
    ownerUserId: input.actor.userId,
    kind,
    idempotencyKey: randomUUID(),
    input: {},
  });
  const run = await startRun(prisma, { orgId: input.actor.orgId, jobId: job.id, kind, model: MODEL });

  const costs = input.steps ?? ["0.001500", "0.002500"];
  let total = 0n;
  for (const [index, cost] of costs.entries()) {
    total += BigInt(cost.replace(".", ""));
    await appendModelStep(prisma, {
      orgId: input.actor.orgId,
      runId: run.id,
      index,
      name: MODEL,
      tokensIn: 100 + index,
      tokensOut: 10 + index,
      tokensCached: 0,
      tokensReasoning: 0,
      cost,
      providerMeta: {
        rawUsage: { input_tokens: 100 + index, output_tokens: 10 + index },
        requestId: `req_${index}`,
        prompt: "never on the wire",
      },
    });
  }

  const status = input.status ?? "done";
  if (status !== "running") {
    await finishRun(prisma, {
      orgId: input.actor.orgId,
      runId: run.id,
      status,
      costTotal: formatMicroDollars(total),
      ...(input.error === undefined ? {} : { error: input.error }),
    });
  }
  return { run, job, costTotal: formatMicroDollars(total) };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (error instanceof TRPCError) return error.code;
    throw error;
  }
}

describe("haltOf", () => {
  it("is null for a run that has not halted", () => {
    expect(haltOf("done", null)).toBeNull();
    expect(haltOf("done", "cap: leftover text")).toBeNull();
    expect(haltOf("running", null)).toBeNull();
  });

  it("reads the leading token of the error, lower-cased, for a failed run", () => {
    expect(haltOf("failed", "cap: the step cap was reached (5)")).toBe("cap");
    expect(haltOf("failed", "step-record: a step could not be written")).toBe("step-record");
    expect(haltOf("failed", "Schema the answer did not validate")).toBe("schema");
    expect(haltOf("failed", "aborted")).toBe("aborted");
  });

  it("falls back to error when a failed run has no text", () => {
    expect(haltOf("failed", null)).toBe("error");
    expect(haltOf("failed", "")).toBe("error");
    expect(haltOf("failed", "   ")).toBe("error");
  });
});

describe("runs.list", () => {
  it("refuses a caller with no session", async () => {
    await expect(caller(null).runs.list()).rejects.toThrow();
  });

  it("shows a rep their own runs and nobody else's, newest first", async () => {
    const me = await ensureUser(prisma, rep());
    const them = await ensureUser(prisma, colleague());
    const elsewhere = await ensureUser(prisma, stranger());

    const first = await seedRun({ actor: me });
    const second = await seedRun({ actor: me, kind: "research" });
    await seedRun({ actor: them });
    await seedRun({ actor: elsewhere });

    const { items, nextCursor } = await caller(rep()).runs.list();

    expect(items.map((run) => run.id)).toEqual([second.run.id, first.run.id]);
    expect(nextCursor).toBeNull();
    expect(items[1]).toMatchObject({
      jobId: first.job.id,
      kind: "echo",
      model: MODEL,
      status: "done",
      costTotal: "0.004000",
      stepCount: 2,
      halt: null,
    });
    expect(items[1]?.finishedAt).toBeInstanceOf(Date);
    // Strings on the wire, never a Decimal or a float.
    expect(typeof items[0]?.costTotal).toBe("string");
    expect(items[0]?.costTotal).toMatch(/^\d+\.\d{6}$/);
  });

  it("filters by kind and by job", async () => {
    const me = await ensureUser(prisma, rep());
    const echo = await seedRun({ actor: me, kind: "echo" });
    const research = await seedRun({ actor: me, kind: "research" });

    const byKind = await caller(rep()).runs.list({ kind: "research" });
    expect(byKind.items.map((run) => run.id)).toEqual([research.run.id]);

    const byJob = await caller(rep()).runs.list({ jobId: echo.job.id });
    expect(byJob.items.map((run) => run.id)).toEqual([echo.run.id]);
  });

  it("derives the halt reason from the error a failed run closed with", async () => {
    const me = await ensureUser(prisma, rep());
    await seedRun({ actor: me, status: "failed", error: "cap: the step cap was reached (5)" });
    await seedRun({ actor: me, status: "failed" });
    await seedRun({ actor: me, status: "running" });

    const { items } = await caller(rep()).runs.list();
    const halts = new Map(items.map((run) => [run.status + ":" + (run.halt ?? "null"), run]));

    expect(halts.has("failed:cap")).toBe(true);
    expect(halts.has("failed:error")).toBe(true);
    expect(halts.has("running:null")).toBe(true);
  });

  it("pages by cursor without gaps or repeats, in a stable order", async () => {
    const me = await ensureUser(prisma, rep());
    const seeded: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      seeded.push((await seedRun({ actor: me, steps: ["0.000001"] })).run.id);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const result = await caller(rep()).runs.list({ limit: 5, ...(cursor === undefined ? {} : { cursor }) });
      expect(result.items.length).toBeLessThanOrEqual(5);
      seen.push(...result.items.map((run) => run.id));
      cursor = result.nextCursor ?? undefined;
      pages += 1;
    } while (cursor !== undefined);

    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(12);
    expect(new Set(seen)).toEqual(new Set(seeded));

    // The same order the unpaged read gives, which is the order the sort key
    // defines: a page boundary changes nothing about where a run sits.
    const whole = await caller(rep()).runs.list({ limit: 50 });
    expect(seen).toEqual(whole.items.map((run) => run.id));
    expect(whole.nextCursor).toBeNull();
  });

  it("refuses a cursor it did not mint", async () => {
    await ensureUser(prisma, rep());
    expect(await codeOf(caller(rep()).runs.list({ cursor: "1 OR 1=1" }))).toBe("BAD_REQUEST");
    expect(await codeOf(caller(rep()).runs.list({ limit: 51 }))).toBe("BAD_REQUEST");
  });
});

describe("runs.get", () => {
  it("returns the run with its steps as a meter, and never what a step said", async () => {
    const me = await ensureUser(prisma, rep());
    const { run } = await seedRun({ actor: me, steps: ["0.001000", "0.000250", "0.000005"] });

    const got = await caller(rep()).runs.get({ id: run.id });

    expect(got).toMatchObject({ id: run.id, costTotal: "0.001255", stepCount: 3, halt: null });
    expect(got.steps).toHaveLength(3);
    expect(got.steps.map((step) => step.index)).toEqual([0, 1, 2]);
    expect(got.steps[0]).toMatchObject({
      kind: "model",
      name: MODEL,
      tokensIn: 100,
      tokensOut: 10,
      tokensCached: 0,
      tokensReasoning: 0,
      cost: "0.001000",
    });
    expect(got.steps[0]?.startedAt).toBeInstanceOf(Date);
    expect(got.steps[0]?.finishedAt).toBeInstanceOf(Date);

    for (const step of got.steps) {
      expect(step).not.toHaveProperty("input");
      expect(step).not.toHaveProperty("output");
      expect(step).not.toHaveProperty("providerMeta");
      expect(step).not.toHaveProperty("rawUsage");
    }
    expect(JSON.stringify(got)).not.toContain("never on the wire");
  });

  it("answers NOT_FOUND, not FORBIDDEN, for a colleague's run and for another org's", async () => {
    const me = await ensureUser(prisma, rep());
    const them = await ensureUser(prisma, colleague());
    const elsewhere = await ensureUser(prisma, stranger());
    const mine = await seedRun({ actor: me });
    const theirs = await seedRun({ actor: them });
    const foreign = await seedRun({ actor: elsewhere });

    expect(await codeOf(caller(rep()).runs.get({ id: mine.run.id }))).toBe("ok");
    expect(await codeOf(caller(rep()).runs.get({ id: theirs.run.id }))).toBe("NOT_FOUND");
    expect(await codeOf(caller(rep()).runs.get({ id: foreign.run.id }))).toBe("NOT_FOUND");
    expect(await codeOf(caller(rep()).runs.get({ id: "run_nobody" }))).toBe("NOT_FOUND");
  });
});

describe("runs.cost", () => {
  it("adds up to the sum of the caller's steps, by kind and in total", async () => {
    const me = await ensureUser(prisma, rep());
    const them = await ensureUser(prisma, colleague());
    await seedRun({ actor: me, kind: "echo", steps: ["0.001000", "0.000500"] });
    await seedRun({ actor: me, kind: "echo", steps: ["0.000005"] });
    await seedRun({ actor: me, kind: "research", steps: ["0.100000", "0.020000"], status: "failed", error: "cap: x" });
    await seedRun({ actor: me, kind: "research", steps: ["0.999999"], status: "running" });
    await seedRun({ actor: them, kind: "echo", steps: ["5.000000"] });

    const cost = await caller(rep()).runs.cost();

    // The running run's total is still zero: `finishRun` is what writes it.
    expect(cost).toEqual({
      total: "0.121505",
      byKind: [
        { kind: "echo", total: "0.001505", runs: 2 },
        { kind: "research", total: "0.120000", runs: 2 },
      ],
    });
  });

  it("is empty for a rep with no runs, and honours since", async () => {
    await ensureUser(prisma, rep());
    expect(await caller(rep()).runs.cost()).toEqual({ total: "0.000000", byKind: [] });

    const me = await ensureUser(prisma, rep());
    await seedRun({ actor: me, steps: ["0.000100"] });
    const later = new Date(Date.now() + 60_000);
    expect(await caller(rep()).runs.cost({ since: later })).toEqual({ total: "0.000000", byKind: [] });
    expect((await caller(rep()).runs.cost({ since: new Date(0) })).total).toBe("0.000100");
  });
});

describe("runs.adminList", () => {
  it("is for the admin only", async () => {
    await ensureUser(prisma, boss());
    await ensureUser(prisma, rep());
    expect(await codeOf(caller(rep()).runs.adminList())).toBe("FORBIDDEN");
    expect(await codeOf(caller(rep()).runs.adminRates())).toBe("FORBIDDEN");
  });

  it("sees every rep's runs in the org, with the owner, and nothing from another org", async () => {
    const admin = await ensureUser(prisma, boss());
    const me = await ensureUser(prisma, rep());
    const them = await ensureUser(prisma, colleague());
    const elsewhere = await ensureUser(prisma, stranger());
    const mine = await seedRun({ actor: me });
    const theirs = await seedRun({ actor: them, status: "failed", error: "schema: did not validate" });
    await seedRun({ actor: elsewhere });

    const { items } = await caller(boss()).runs.adminList();

    expect(items.map((run) => run.id).sort()).toEqual([mine.run.id, theirs.run.id].sort());
    const owners = new Map(items.map((run) => [run.id, run]));
    expect(owners.get(mine.run.id)).toMatchObject({
      ownerUserId: me.userId,
      ownerEmail: "rep@example.test",
      halt: null,
    });
    expect(owners.get(theirs.run.id)).toMatchObject({
      ownerUserId: them.userId,
      ownerEmail: "colleague@example.test",
      halt: "schema",
    });
    expect(admin.role).toBe("admin");

    const byOwner = await caller(boss()).runs.adminList({ ownerUserId: them.userId });
    expect(byOwner.items.map((run) => run.id)).toEqual([theirs.run.id]);

    const byStatus = await caller(boss()).runs.adminList({ status: "done" });
    expect(byStatus.items.map((run) => run.id)).toEqual([mine.run.id]);
  });
});

describe("runs.adminGet", () => {
  it("adds the provider's raw usage to each step, and nothing else off providerMeta", async () => {
    await ensureUser(prisma, boss());
    const me = await ensureUser(prisma, rep());
    const { run } = await seedRun({ actor: me, steps: ["0.000100"] });

    const got = await caller(boss()).runs.adminGet({ id: run.id });

    expect(got.ownerEmail).toBe("rep@example.test");
    expect(got.steps[0]?.rawUsage).toEqual({ input_tokens: 100, output_tokens: 10 });
    expect(got.steps[0]).not.toHaveProperty("providerMeta");
    expect(got.steps[0]).not.toHaveProperty("input");
    expect(got.steps[0]).not.toHaveProperty("output");
    expect(JSON.stringify(got)).not.toContain("never on the wire");
    expect(JSON.stringify(got)).not.toContain("req_0");
  });

  it("does not reach into another org", async () => {
    await ensureUser(prisma, boss());
    const elsewhere = await ensureUser(prisma, stranger());
    const foreign = await seedRun({ actor: elsewhere });
    expect(await codeOf(caller(boss()).runs.adminGet({ id: foreign.run.id }))).toBe("NOT_FOUND");
  });
});

describe("runs.adminRates", () => {
  it("counts done, failed and the halts per kind", async () => {
    await ensureUser(prisma, boss());
    const me = await ensureUser(prisma, rep());
    const them = await ensureUser(prisma, colleague());
    const elsewhere = await ensureUser(prisma, stranger());

    await seedRun({ actor: me, kind: "research" });
    await seedRun({ actor: them, kind: "research", status: "failed", error: "cap: the step cap was reached" });
    await seedRun({ actor: me, kind: "research", status: "failed", error: "cap: again" });
    await seedRun({ actor: me, kind: "research", status: "failed", error: "schema: did not validate" });
    await seedRun({ actor: me, kind: "research", status: "running" });
    await seedRun({ actor: them, kind: "echo" });
    await seedRun({ actor: them, kind: "echo", status: "failed" });
    await seedRun({ actor: elsewhere, kind: "echo", status: "failed", error: "cap: not ours" });

    const rates = await caller(boss()).runs.adminRates();

    expect(rates).toEqual([
      { kind: "echo", runs: 2, done: 1, failed: 1, haltRates: [{ reason: "error", count: 1 }] },
      {
        kind: "research",
        runs: 5,
        done: 1,
        failed: 3,
        haltRates: [
          { reason: "cap", count: 2 },
          { reason: "schema", count: 1 },
        ],
      },
    ]);

    expect(await caller(boss()).runs.adminRates({ since: new Date(Date.now() + 60_000) })).toEqual([]);
  });
});
