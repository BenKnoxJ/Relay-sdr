import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { echoTools } from "../../agents/echo/tools";
import { loadDefinition } from "@/lib/agents/definitions";
import { runAgent } from "@/lib/agents/run";
import { prisma } from "@/lib/db";

import { emptyAll, resetDatabase } from "../db/harness";
import { ORG_ID, scriptedModel, seedJob, seedOrg } from "./harness";

/**
 * A lost lease stops the run, and the run row is closed before it does.
 *
 * The worker hands every handler an `AbortSignal` that fires when the lease is
 * lost or the worker drains (Task 5). A run that ignored it would keep calling a
 * paid API on behalf of a job another worker now owns, and would leave its own
 * row `running` for the reaper to puzzle over. So the run closes itself, charges
 * what it spent, and reports `aborted` — which the handler treats as retryable,
 * because a lost lease is not a broken definition.
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

describe("abortSignal", () => {
  it("ends the run as failed(aborted) with the row closed", async () => {
    const definition = loadDefinition("echo");
    const jobId = await seedJob("echo", { text: "hello" });
    const controller = new AbortController();

    // Aborted from inside the first tool call, so the signal lands mid-run with
    // one model step already recorded — the shape a lost lease actually has.
    const { model, callCount } = scriptedModel([
      { tool: { name: "shout", args: { text: "hello" } }, usage: { in: 700, out: 30 } },
      { text: JSON.stringify({ text: "HELLO" }), usage: { in: 800, out: 40 } },
    ]);

    const failure = await runAgent({
      definition,
      input: { text: "hello" },
      ctx: {
        db: prisma,
        orgId: ORG_ID,
        jobId,
        model,
        modelId: MODEL,
        signal: controller.signal,
        tools: (recorder) =>
          echoTools(recorder, () => controller.abort(new Error("the lease was lost"))),
      },
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({ name: "AgentRunFailedError", reason: "aborted" });
    // The second model call never happened: that is what the abort bought.
    expect(callCount()).toBe(1);

    const run = await prisma.agentRun.findFirstOrThrow({ where: { jobId } });
    expect(run.status).toBe("failed");
    expect(run.finishedAt).not.toBeNull();
    expect(run.error).toMatch(/^aborted: /);
    expect(run.costTotal.greaterThan(0)).toBe(true);

    // Both steps survive. The tool ran and its result is recorded, so a retry
    // replays it rather than paying again.
    const steps = await prisma.agentRunStep.findMany({ orderBy: { index: "asc" } });
    expect(steps.map((step) => step.kind)).toEqual(["model", "tool"]);
    expect(steps[1]?.output).toEqual({ text: "HELLO" });
  });

  it("makes no model call at all when the signal is already aborted", async () => {
    const definition = loadDefinition("echo");
    const jobId = await seedJob("echo", { text: "hello" });
    const controller = new AbortController();
    controller.abort(new Error("the lease was already gone"));
    const { model, callCount } = scriptedModel([
      { text: JSON.stringify({ text: "HELLO" }), usage: { in: 10, out: 10 } },
    ]);

    await expect(
      runAgent({
        definition,
        input: { text: "hello" },
        ctx: {
          db: prisma,
          orgId: ORG_ID,
          jobId,
          model,
          modelId: MODEL,
          signal: controller.signal,
          tools: (recorder) => echoTools(recorder),
        },
      }),
    ).rejects.toMatchObject({ reason: "aborted" });

    expect(callCount()).toBe(0);
    // And no run row at all. A signal that was already aborted means there was
    // never a run to record: `runAgent` refuses before `startRun`, so nothing is
    // left `running` for the reaper to puzzle over and the timeline is not
    // littered with rows for attempts that did nothing.
    expect(await prisma.agentRun.count({ where: { jobId } })).toBe(0);
  });
});
