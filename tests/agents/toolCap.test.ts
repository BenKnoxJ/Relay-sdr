import { tool } from "ai";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { echoTools } from "../../agents/echo/tools";
import { loadDefinition, type AgentDefinition } from "@/lib/agents/definitions";
import { agentSdkSettings } from "@/lib/agents/provider";
import { AgentRunFailedError, runAgent } from "@/lib/agents/run";
import { withReplay, type ToolRecorder } from "@/lib/agents/tools";
import { prisma } from "@/lib/db";

import { emptyAll, resetDatabase } from "../db/harness";
import { ORG_ID, scriptedModel, seedJob, seedOrg } from "./harness";

/**
 * The seams Task 12 added to the runtime for research's budget, proved on the
 * echo definition with the scripted model so nothing here depends on research:
 *
 *   * a tool failure the tool marks **unspent** keeps its row and frees its
 *     key, so a retry runs the call instead of replaying a refusal;
 *   * a tool can end the run with `cap`, naming the field, and a run ended
 *     that way has no answer;
 *   * the wall-clock cap is a timer that ends the run the same way;
 *   * the definition's effort reaches the SDK settings.
 */

const MODEL = "claude-opus-5" as const;

class Refused extends Error {
  readonly unspent = true as const;
}

/** An echo tool set whose `shout` refuses the first N calls before spending. */
function refusingTools(refusals: { remaining: number }, onRun: () => void) {
  return (recorder: ToolRecorder) => ({
    shout: tool({
      description: "Return the given text in upper case.",
      inputSchema: z.object({ text: z.string() }),
      execute: withReplay(recorder, {
        name: "shout",
        toolKey: (args: { text: string }) => args.text,
        unspent: (error) => error instanceof Refused,
        execute: async (args: { text: string }) => {
          if (refusals.remaining > 0) {
            refusals.remaining -= 1;
            throw new Refused("refused before spending");
          }
          onRun();
          return { text: args.text.toUpperCase() };
        },
      }),
    }),
  });
}

/** An echo tool set whose `shout` ends the run as a cap. */
function cappingTools(recorder: ToolRecorder) {
  return {
    shout: tool({
      description: "Return the given text in upper case.",
      inputSchema: z.object({ text: z.string() }),
      execute: withReplay<{ text: string }, { text: string }>(recorder, {
        name: "shout",
        toolKey: (args) => args.text,
        unspent: () => true,
        execute: async () => {
          recorder.abortRun("cap", "cap:searches: the searches cap (40) was reached with no answer");
          throw new Refused("cap:searches");
        },
      }),
    }),
  };
}

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

describe("an unspent tool failure", () => {
  it("keeps the step row, frees the key, and lets the retry run the call", async () => {
    const definition = loadDefinition("echo");
    const jobId = await seedJob("echo", { text: "hello" });
    const refusals = { remaining: 1 };
    let ran = 0;
    const script = [
      { tool: { name: "shout", args: { text: "hello" } }, usage: { in: 10, out: 5 } },
      { text: JSON.stringify({ text: "HELLO" }), usage: { in: 10, out: 5 } },
    ];
    // Attempt 1: the tool refuses before spending. The model, handed the
    // error, still answers (the script does), so the run itself succeeds —
    // what matters is the row and the key it leaves behind.
    await runAgent({
      definition,
      input: { text: "hello" },
      ctx: { db: prisma, orgId: ORG_ID, jobId, model: scriptedModel([...script]).model, modelId: MODEL, tools: refusingTools(refusals, () => (ran += 1)) },
    });
    const released = await prisma.agentRunStep.findFirst({ where: { kind: "tool" } });
    expect(released?.toolKey).toBeNull();
    expect(released?.output).toMatchObject({ $toolError: expect.stringMatching(/^released: /) });
    expect(ran).toBe(0);

    // Attempt 2, same job: the key is free, the call runs, the tool's own
    // row is written with the key.
    await runAgent({
      definition,
      input: { text: "hello" },
      ctx: { db: prisma, orgId: ORG_ID, jobId, model: scriptedModel([...script]).model, modelId: MODEL, tools: refusingTools(refusals, () => (ran += 1)) },
    });
    expect(ran).toBe(1);
    const keyed = await prisma.agentRunStep.findMany({ where: { kind: "tool", toolKey: { not: null } } });
    expect(keyed).toHaveLength(1);
    expect(keyed[0]?.output).toEqual({ text: "HELLO" });
    // Both rows survive: the refusal is part of the record.
    expect(await prisma.agentRunStep.count({ where: { kind: "tool" } })).toBe(2);
  });
});

describe("a cap raised from inside the run", () => {
  it("ends the run as `cap` naming the field, with no answer and the spend recorded", async () => {
    const definition = loadDefinition("echo");
    const jobId = await seedJob("echo", { text: "hello" });
    const { model, callCount } = scriptedModel(
      [
        { tool: { name: "shout", args: { text: "hello" } }, usage: { in: 500, out: 20 } },
        { text: JSON.stringify({ text: "HELLO" }), usage: { in: 10, out: 5 } },
      ],
      { repeatLast: true },
    );
    const failure = await runAgent({
      definition,
      input: { text: "hello" },
      ctx: { db: prisma, orgId: ORG_ID, jobId, model, modelId: MODEL, tools: cappingTools },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AgentRunFailedError);
    expect((failure as AgentRunFailedError).reason).toBe("cap");
    expect((failure as AgentRunFailedError).message).toMatch(/cap:searches: the searches cap \(40\)/);
    // The loop was stopped: the second scripted call never happened.
    expect(callCount()).toBe(1);
    const run = await prisma.agentRun.findFirstOrThrow({ where: { jobId } });
    expect(run.status).toBe("failed");
    expect(run.costTotal.greaterThan(0)).toBe(true);
  });

  it("the wall-clock cap is a timer that ends the run the same way", async () => {
    const base = loadDefinition("echo");
    const slow: AgentDefinition<{ text: string }, { text: string }> = { ...base, budget: { ...base.budget, maxSeconds: 0.05 } };
    const jobId = await seedJob("echo", { text: "hello" });
    const { model } = scriptedModel([{ text: JSON.stringify({ text: "HELLO" }), usage: { in: 10, out: 5 } }], { repeatLast: true });
    // A model that takes longer than the cap to answer.
    const original = model.doGenerate.bind(model);
    model.doGenerate = async (options) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (options.abortSignal?.aborted) throw new Error("aborted by the transport");
      return original(options);
    };
    const failure = await runAgent({
      definition: slow,
      input: { text: "hello" },
      ctx: { db: prisma, orgId: ORG_ID, jobId, model, modelId: MODEL, tools: (recorder) => echoTools(recorder) },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AgentRunFailedError);
    expect((failure as AgentRunFailedError).reason).toBe("cap");
    expect((failure as AgentRunFailedError).message).toMatch(/0\.05-second cap/);
  });

  it("a lost lease is still `aborted`, not `cap`", async () => {
    const definition = loadDefinition("echo");
    const jobId = await seedJob("echo", { text: "hello" });
    const lease = new AbortController();
    const { model } = scriptedModel([{ text: JSON.stringify({ text: "HELLO" }), usage: { in: 10, out: 5 } }]);
    const original = model.doGenerate.bind(model);
    model.doGenerate = async (options) => {
      lease.abort(new Error("lease lost"));
      if (options.abortSignal?.aborted) throw new Error("aborted by the transport");
      return original(options);
    };
    const failure = await runAgent({
      definition,
      input: { text: "hello" },
      ctx: { db: prisma, orgId: ORG_ID, jobId, model, modelId: MODEL, signal: lease.signal, tools: (recorder) => echoTools(recorder) },
    }).catch((error: unknown) => error);
    expect((failure as AgentRunFailedError).reason).toBe("aborted");
  });
});

describe("model and effort on the definition", () => {
  it("every definition names a model the price table knows, or none for a codeless agent", () => {
    expect(loadDefinition("research")).toMatchObject({ model: "claude-opus-5", effort: "high" });
    expect(loadDefinition("orchestrator")).toMatchObject({ model: "claude-sonnet-5", effort: "medium" });
    expect(loadDefinition("outreach")).toMatchObject({ model: "claude-sonnet-5", effort: "high" });
    expect(loadDefinition("leadgen")).toMatchObject({ model: null, effort: null });
  });

  it("reaches the SDK settings as `effort`", () => {
    const settings = agentSdkSettings({
      configDir: "/tmp/relay-home",
      token: "token",
      run: { tools: {}, maxTurns: 3, effort: "high", observe: { onTurn: async () => {}, onResult: async () => {} } },
    });
    expect(settings.effort).toBe("high");
    const without = agentSdkSettings({
      configDir: "/tmp/relay-home",
      token: "token",
      run: { tools: {}, maxTurns: 3, observe: { onTurn: async () => {}, onResult: async () => {} } },
    });
    expect("effort" in without).toBe(false);
  });
});
