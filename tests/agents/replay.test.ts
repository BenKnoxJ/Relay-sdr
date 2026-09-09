import { createHash } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { echoTools, type ShoutArgs } from "../../agents/echo/tools";
import { loadDefinition } from "@/lib/agents/definitions";
import { runAgent } from "@/lib/agents/run";
import { createToolRecorder, FAILURE_KEY, toolKey, withReplay } from "@/lib/agents/tools";
import { prisma } from "@/lib/db";

import { emptyAll, resetDatabase } from "../db/harness";
import { ORG_ID, scriptedModel, seedJob, seedOrg } from "./harness";

/**
 * A retried job never re-spends on a tool call it has already made.
 *
 * The brief asked for this by deleting the first run's `AgentRun` row and keeping
 * its steps. That is not possible and does not need to be: every relation in the
 * schema states `onDelete: Restrict` because nothing is deleted (§25 rule 1), so
 * a run row with steps attached cannot be removed. It is also not what a retry
 * looks like — a retry is a *second run* of the same job, which is what this
 * does. The key deliberately excludes the run id for exactly this reason, so the
 * second run finds the first run's steps and reuses them.
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

describe("withReplay", () => {
  it("@proof runs the tool body zero times on a retry and creates no new tool step", async () => {
    const definition = loadDefinition("echo");
    const jobId = await seedJob("echo", { text: "hello" });
    const script = [
      { tool: { name: "shout", args: { text: "hello" } }, usage: { in: 100, out: 10 } },
      { text: JSON.stringify({ text: "HELLO" }), usage: { in: 120, out: 12 } },
    ];

    const firstRuns: ShoutArgs[] = [];
    const first = await runAgent({
      definition,
      input: { text: "hello" },
      ctx: {
        db: prisma,
        orgId: ORG_ID,
        jobId,
        model: scriptedModel([...script]).model,
        modelId: MODEL,
        tools: (recorder) => echoTools(recorder, (args) => firstRuns.push(args)),
      },
    });
    expect(firstRuns).toHaveLength(1);
    expect(first.replayedToolCalls).toBe(0);

    const toolStepsAfterFirst = await prisma.agentRunStep.findMany({ where: { kind: "tool" } });
    expect(toolStepsAfterFirst).toHaveLength(1);
    const firstToolStep = toolStepsAfterFirst[0];
    if (firstToolStep === undefined) throw new Error("no tool step");

    // The same job, attempted again: a new run, the same inputs, the same script.
    const secondRuns: ShoutArgs[] = [];
    const second = await runAgent({
      definition,
      input: { text: "hello" },
      ctx: {
        db: prisma,
        orgId: ORG_ID,
        jobId,
        model: scriptedModel([...script]).model,
        modelId: MODEL,
        tools: (recorder) => echoTools(recorder, (args) => secondRuns.push(args)),
      },
    });

    expect(secondRuns).toHaveLength(0);
    expect(second.replayedToolCalls).toBe(1);
    expect(second.object).toEqual({ text: "HELLO" });
    expect(second.run.id).not.toBe(first.run.id);

    // Still one tool step in the whole org, and it is the first run's, untouched.
    const toolStepsAfterSecond = await prisma.agentRunStep.findMany({ where: { kind: "tool" } });
    expect(toolStepsAfterSecond).toHaveLength(1);
    expect(toolStepsAfterSecond[0]?.id).toBe(firstToolStep.id);
    expect(toolStepsAfterSecond[0]?.runId).toBe(first.run.id);

    // The second run records its own model calls — those are not replayable, and
    // the tokens they used were really used.
    const secondSteps = second.steps;
    expect(secondSteps.filter((step) => step.kind === "model")).toHaveLength(2);
    expect(secondSteps.filter((step) => step.kind === "tool")).toHaveLength(0);
    expect(second.run.costTotal.greaterThan(0)).toBe(true);
  });

  it("rethrows a replayed failure instead of handing the model an error object", async () => {
    const jobId = await seedJob("echo", { text: "hello" });
    const run = await prisma.agentRun.create({
      data: { orgId: ORG_ID, jobId, kind: "echo", model: MODEL, status: "failed" },
    });
    const recorder = createToolRecorder({
      db: prisma,
      orgId: ORG_ID,
      jobId,
      runId: run.id,
      runKind: "echo",
      takeIndex: (() => {
        let next = 10;
        return () => next++;
      })(),
    });
    // The step the first attempt left behind: a stored failure, under the
    // reserved key.
    await prisma.agentRunStep.create({
      data: {
        orgId: ORG_ID,
        runId: run.id,
        index: 1,
        kind: "tool",
        name: "search",
        toolKey: recorder.key("search", "claims ops"),
        input: { query: "claims ops" },
        output: { [FAILURE_KEY]: "TypeError" },
      },
    });

    let bodyRuns = 0;
    const search = withReplay(recorder, {
      name: "search",
      toolKey: () => "claims ops",
      execute: async () => {
        bodyRuns += 1;
        return { hits: [] };
      },
    });

    // Not `{ $toolError: "TypeError" }` returned as a search result — a model
    // given that reasons over it as data and writes a pack citing nothing.
    await expect(search({})).rejects.toMatchObject({ name: "ReplayedToolFailure" });
    expect(bodyRuns).toBe(0);
  });

  it("collapses two identical calls made at the same time into one", async () => {
    const jobId = await seedJob("echo", { text: "hello" });
    const run = await prisma.agentRun.create({
      data: { orgId: ORG_ID, jobId, kind: "echo", model: MODEL, status: "running" },
    });
    let nextIndex = 0;
    const recorder = createToolRecorder({
      db: prisma,
      orgId: ORG_ID,
      jobId,
      runId: run.id,
      runKind: "echo",
      takeIndex: () => nextIndex++,
    });

    let bodyRuns = 0;
    const slow = withReplay(recorder, {
      name: "search",
      toolKey: () => "same",
      execute: async () => {
        bodyRuns += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { hits: ["one"] };
      },
    });

    // A model may ask for the same tool twice in one step, and the SDK runs a
    // step's tool calls concurrently. Without in-flight collapsing, the second
    // loses the race on `(org_id, tool_key)`, is handed the winner's row before
    // it has an output, and returns nothing.
    const [a, b] = await Promise.all([slow({}), slow({})]);
    expect(a).toEqual({ hits: ["one"] });
    expect(b).toEqual(a);
    expect(bodyRuns).toBe(1);
    expect(await prisma.agentRunStep.count({ where: { runId: run.id } })).toBe(1);
  });

  it("keys a call by what it is, not by which run made it", () => {
    // The property the test above rests on: the same call in two runs of one job
    // has one key, and every other part of the tuple changes it.
    const a = toolKey(ORG_ID, "job-1", "echo", "shout", "hello");
    expect(toolKey(ORG_ID, "job-1", "echo", "shout", "hello")).toBe(a);
    expect(toolKey("org_other", "job-1", "echo", "shout", "hello")).not.toBe(a);
    expect(toolKey(ORG_ID, "job-1", "research", "shout", "hello")).not.toBe(a);
    expect(toolKey(ORG_ID, "job-1", "echo", "fetch", "hello")).not.toBe(a);
    expect(toolKey(ORG_ID, "job-1", "echo", "shout", "goodbye")).not.toBe(a);
    // A different job does NOT replay: the key is a retry guard, not a permanent
    // org-wide cache of every search Relay has ever run. See the module note in
    // `src/lib/agents/tools.ts`.
    expect(toolKey(ORG_ID, "job-2", "echo", "shout", "hello")).not.toBe(a);
    // The five parts are hashed as a JSON array, so no shifting of a separator
    // between them collides.
    expect(toolKey("a", "b", "c:d", "e", "f")).not.toBe(toolKey("a", "b", "c", "d:e", "f"));
  });

  it("does not re-run a tool whose first attempt was killed before it answered", async () => {
    const definition = loadDefinition("echo");
    const jobId = await seedJob("echo", { text: "hello" });
    // A claimed step with no output: a worker killed between the claim and the
    // answer. The charge may already have been made, so the call must not repeat.
    const run = await prisma.agentRun.create({
      data: { orgId: ORG_ID, jobId, kind: "echo", model: MODEL, status: "failed" },
    });
    await prisma.agentRunStep.create({
      data: {
        orgId: ORG_ID,
        runId: run.id,
        index: 1,
        kind: "tool",
        name: "shout",
        toolKey: toolKey(ORG_ID, jobId, "echo", "shout", sha("hello")),
        input: { text: "hello" },
      },
    });

    const runs: ShoutArgs[] = [];
    const result = await runAgent({
      definition,
      input: { text: "hello" },
      ctx: {
        db: prisma,
        orgId: ORG_ID,
        jobId,
        model: scriptedModel([
          { tool: { name: "shout", args: { text: "hello" } }, usage: { in: 100, out: 10 } },
          { text: JSON.stringify({ text: "HELLO" }), usage: { in: 120, out: 12 } },
        ]).model,
        modelId: MODEL,
        tools: (recorder) => echoTools(recorder, (args) => runs.push(args)),
      },
    });

    expect(runs).toHaveLength(0);
    expect(result.replayedToolCalls).toBe(1);
    // The model was handed the null the step carries, and the evidence of the
    // interrupted call is still the step with no output.
    const steps = await prisma.agentRunStep.findMany({ where: { kind: "tool" } });
    expect(steps).toHaveLength(1);
    expect(steps[0]?.output).toBeNull();
  });
});

function sha(text: string): string {
  // The same discriminator `agents/echo/tools.ts` derives, so the seeded step's
  // key is the one the run will look for.
  return createHash("sha256").update(text).digest("hex");
}
