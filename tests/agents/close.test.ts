import { Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { echoTools } from "../../agents/echo/tools";
import { loadDefinition } from "@/lib/agents/definitions";
import { runAgent } from "@/lib/agents/run";
import { prisma } from "@/lib/db";

import { emptyAll, resetDatabase } from "../db/harness";
import { ORG_ID, scriptedModel, seedJob, seedOrg } from "./harness";

/**
 * The close is a write, and a write can fail.
 *
 * `src/lib/agents/run.ts` states one invariant about the row: a run is never
 * left `running`. Every failure exit keeps it by closing through `failRun`, and
 * the success path is the one place where a single write stands between a
 * finished run and a row nobody can reason about — the cost was really spent,
 * the reaper has no reason to touch a row it cannot see is over, and the job
 * looks live forever.
 *
 * So the success close is tested the same way as a failure: by making the write
 * fail and looking at the row afterwards.
 */

const MODEL = "claude-opus-5" as const;

beforeAll(async () => {
  await resetDatabase();
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await emptyAll();
  await seedOrg();
});

/**
 * A client whose first `agentRun.update` throws, and whose second does not.
 *
 * The first is the success close; the second is `failRun`'s. Throwing once
 * rather than always is the point — the run has to end `failed` *with its
 * cost*, which needs the second write to land.
 */
function failFirstRunUpdate(db: PrismaClient): PrismaClient {
  let thrown = false;
  const delegate = db.agentRun;
  const agentRun = new Proxy(delegate, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (property !== "update") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (args: unknown): Promise<unknown> => {
        if (!thrown) {
          thrown = true;
          throw new Error("the connection was reset at the commit");
        }
        return (value as (input: unknown) => Promise<unknown>).call(target, args);
      };
    },
  });
  return new Proxy(db, {
    get(target, property) {
      if (property === "agentRun") return agentRun;
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as PrismaClient;
}

describe("closing the run", () => {
  it("ends a run failed with its cost when the success close throws, never running", async () => {
    const definition = loadDefinition("echo");
    const jobId = await seedJob("echo", { text: "hello" });
    const { model } = scriptedModel([
      { tool: { name: "shout", args: { text: "hello" } }, usage: { in: 900, out: 20 } },
      { text: JSON.stringify({ text: "HELLO" }), usage: { in: 1_100, out: 30 } },
    ]);

    const failure = await runAgent({
      definition,
      input: { text: "hello" },
      ctx: {
        db: failFirstRunUpdate(prisma),
        orgId: ORG_ID,
        jobId,
        model,
        modelId: MODEL,
        tools: (recorder) => echoTools(recorder),
      },
    }).then(
      () => null,
      (error: unknown) => error,
    );

    // The answer validated; only the closing write failed. That is its own
    // reason, because a handler reading `error` would retry a run that had
    // already produced an answer and re-spend every step of it.
    expect(failure).toMatchObject({ name: "AgentRunFailedError", reason: "close" });

    const run = await prisma.agentRun.findFirstOrThrow({ where: { jobId } });
    expect(run.status).toBe("failed");
    expect(run.finishedAt).not.toBeNull();
    expect(run.error).toMatch(/^close: the run could not be closed/);

    // The cost is the invariant this is really about: two model calls happened
    // and were paid for, and the closed row carries their sum rather than zero.
    const steps = await prisma.agentRunStep.findMany({ where: { runId: run.id }, orderBy: { index: "asc" } });
    const spent = steps.reduce((total, step) => total.plus(step.cost), new Prisma.Decimal(0));
    expect(run.costTotal.greaterThan(0)).toBe(true);
    expect(run.costTotal.equals(spent)).toBe(true);
  });

  it("closes a healthy run as done, with the same cost", async () => {
    // The control. Without it, the test above would pass just as well against a
    // runtime that failed every run.
    const definition = loadDefinition("echo");
    const jobId = await seedJob("echo", { text: "hello" });
    const { model } = scriptedModel([
      { text: JSON.stringify({ text: "HELLO" }), usage: { in: 1_100, out: 30 } },
    ]);

    const result = await runAgent({
      definition,
      input: { text: "hello" },
      ctx: {
        db: prisma,
        orgId: ORG_ID,
        jobId,
        model,
        modelId: MODEL,
        tools: (recorder) => echoTools(recorder),
      },
    });

    expect(result.run.status).toBe("done");
    expect(result.run.costTotal.greaterThan(0)).toBe(true);
    expect(result.steps.map((step) => step.kind)).toEqual(["model"]);
  });
});
