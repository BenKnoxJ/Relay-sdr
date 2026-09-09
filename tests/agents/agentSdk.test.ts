import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import type { ToolSet } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { echoTools } from "../../agents/echo/tools";
import { loadDefinition } from "@/lib/agents/definitions";
import type { AgentSdkObserver, AgentSdkResult, AnthropicUsage, RunModel } from "@/lib/agents/model";
import { AgentRunFailedError, canonicalModelId, runAgent, usageFromAnthropic } from "@/lib/agents/run";
import { prisma } from "@/lib/db";

import { emptyAll, resetDatabase } from "../db/harness";
import { ORG_ID, seedJob, seedOrg } from "./harness";

/**
 * The ledger on the Agent SDK transport.
 *
 * On this transport the loop runs inside the SDK's subprocess and the AI SDK
 * sees one call for the whole run, so the rows come from the SDK's message
 * stream. This test stands in for the subprocess: a `RunModel` whose
 * `forRun` returns a mock that plays the turns the SDK would relay — through
 * the observer, exactly as `provider.agentSdkSettings` would — runs the tool the
 * way the MCP server would (its own `execute`, in this process), and then
 * returns the one summed call the AI SDK would see. The numbers are the ones
 * observed live on 2026-09-09 (`scripts/spike/cost-check.ts`, the 6c handoff),
 * including the SDK's own Haiku side call, so the arithmetic under test is the
 * arithmetic that reconciled against the SDK's `costUSD` on the wire.
 */

const MODEL = "claude-opus-5" as const;

/** Turn 1: the model calls the tool. One-hour cache write, as the SDK does. */
const TURN_1: AnthropicUsage = {
  input_tokens: 2,
  cache_creation_input_tokens: 754,
  cache_read_input_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 754 },
  output_tokens: 24,
};
/** Turn 2: the model answers. */
const TURN_2: AnthropicUsage = {
  input_tokens: 2,
  cache_creation_input_tokens: 108,
  cache_read_input_tokens: 754,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 108 },
  output_tokens: 114,
};
/** What the SDK reported for the whole query: the two turns, plus its own Haiku call. */
const RESULT: AgentSdkResult = {
  subtype: "success",
  numTurns: 2,
  totalCostUsd: 0.01346,
  modelUsage: {
    "claude-opus-5": {
      inputTokens: 4,
      outputTokens: 138,
      cacheReadInputTokens: 754,
      cacheCreationInputTokens: 862,
      costUSD: 0.012467,
      canonicalModel: "claude-opus-5",
    },
    "claude-haiku-4-5-20251001": {
      inputTokens: 918,
      outputTokens: 15,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUSD: 0.000993,
      canonicalModel: "claude-haiku-4-5",
    },
  },
};

type Script = {
  turns: AnthropicUsage[];
  result: AgentSdkResult;
  /** What the mock does after the result: answer, or throw as the bridge does at the cap. */
  ending: { text: string } | { throws: string };
};

/** A stand-in for the subprocess. See the module comment. */
function agentSdkStandIn(script: Script): { handle: RunModel; toolRuns: () => number; maxTurns: () => number | undefined } {
  let toolRuns = 0;
  let maxTurns: number | undefined;
  const handle: RunModel = {
    transport: "agent-sdk",
    forRun({ tools, maxTurns: cap, observe }) {
      maxTurns = cap;
      return new MockLanguageModelV4({
        modelId: MODEL,
        provider: "claude-code",
        doGenerate: async (): Promise<LanguageModelV4GenerateResult> => {
          await playTurns(script, tools, observe, () => {
            toolRuns += 1;
          });
          if ("throws" in script.ending) throw new Error(script.ending.throws);
          return {
            content: [{ type: "text", text: script.ending.text }],
            finishReason: { unified: "stop", raw: "end_turn" },
            // The one summed call the AI SDK sees. Deliberately *not* what the
            // rows are built from.
            usage: {
              inputTokens: { total: 1620, noCache: 4, cacheRead: 754, cacheWrite: 862 },
              outputTokens: { total: 138, text: undefined, reasoning: undefined },
            },
            providerMetadata: { "claude-code": { sessionId: "s" } },
            warnings: [],
          };
        },
      });
    },
  };
  return { handle, toolRuns: () => toolRuns, maxTurns: () => maxTurns };
}

async function playTurns(
  script: Script,
  tools: ToolSet,
  observe: AgentSdkObserver,
  onToolRun: () => void,
): Promise<void> {
  for (const [i, usage] of script.turns.entries()) {
    const isToolTurn = i < script.turns.length - 1 || "throws" in script.ending;
    await observe.onTurn({
      messageId: `msg_${i + 1}`,
      model: MODEL,
      stopReason: isToolTurn ? "tool_use" : "end_turn",
      blocks: isToolTurn ? ["tool_use:mcp__relay__shout"] : ["text"],
      usage,
    });
    if (isToolTurn) {
      // The MCP server: the tool's own `execute`, in this process.
      const execute = tools.shout?.execute as
        | ((input: { text: string }, options: { toolCallId: string; messages: never[] }) => Promise<unknown>)
        | undefined;
      if (execute === undefined) throw new Error("no shout tool");
      onToolRun();
      await execute({ text: "the quick brown fox" }, { toolCallId: `call-${i + 1}`, messages: [] });
    }
  }
  await observe.onResult(script.result);
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

describe("the Agent SDK ledger", () => {

  it("records one model step per assistant turn, the tool between them, and the SDK's own side call", async () => {
    const jobId = await seedJob("echo", { text: "the quick brown fox" });
    const definition = loadDefinition("echo");
    const standIn = agentSdkStandIn({ turns: [TURN_1, TURN_2], result: RESULT, ending: { text: JSON.stringify({ text: "THE QUICK BROWN FOX" }) } });

    const result = await runAgent({
      definition,
      input: { text: "the quick brown fox" },
      ctx: { db: prisma, orgId: ORG_ID, jobId, model: standIn.handle, modelId: MODEL, tools: (recorder) => echoTools(recorder) },
    });

    expect(result.transport).toBe("agent-sdk");
    expect(result.object).toEqual({ text: "THE QUICK BROWN FOX" });
    expect(standIn.toolRuns()).toBe(1);
    // The definition's step budget became the SDK's turn cap.
    expect(standIn.maxTurns()).toBe(definition.budget.maxModelSteps);

    // In the order they happened: turn, tool, turn, then the reconciliation row.
    expect(result.steps.map((step) => [step.index, step.kind, step.name])).toEqual([
      [0, "model", MODEL],
      [1, "tool", "shout"],
      [2, "model", MODEL],
      [3, "model", "claude-haiku-4-5"],
    ]);

    // Turn 1: 2 uncached at $5, 754 one-hour cache writes at $10, 24 out at $25.
    expect(result.steps[0]?.tokensIn).toBe(756);
    expect(result.steps[0]?.cost.toString()).toBe("0.00815");
    // Turn 2: 2 uncached, 754 cache reads at $0.50, 108 one-hour writes, 114 out.
    expect(result.steps[2]?.tokensIn).toBe(864);
    expect(result.steps[2]?.tokensCached).toBe(754);
    expect(result.steps[2]?.cost.toString()).toBe("0.004317");
    // The Haiku call the SDK made and the stream did not show: 918 in at $1, 15 out at $5.
    expect(result.steps[3]?.tokensIn).toBe(918);
    expect(result.steps[3]?.cost.toString()).toBe("0.000993");
    expect(result.steps[3]?.providerMeta).toMatchObject({ provider: "claude-code", responseModelId: "claude-haiku-4-5-20251001" });

    // The run total is the whole run — and equals what the SDK itself said it
    // cost, to the micro-dollar. Two arithmetics, one number.
    expect(result.run.costTotal.toString()).toBe("0.01346");
    expect(result.sdk?.totalCostUsd).toBe(0.01346);
    // Per model, too: the pinned model's rows sum to the SDK's figure for it.
    expect(result.steps[0]!.cost.add(result.steps[2]!.cost).toString()).toBe("0.012467");
    // The turn rows carry the wire usage they were priced from.
    expect(result.steps[0]?.providerMeta).toMatchObject({ rawUsage: TURN_1, responseId: "msg_1", blocks: ["tool_use:mcp__relay__shout"] });
  });

  it("keeps a tool step after the turn that asked for it, even if the tool call arrives first", async () => {
    // The inversion the gate exists for: the MCP control request is processed
    // before the assistant message that carries the tool_use block has been
    // delivered. The tool must wait for the turn, not write ahead of it.
    const jobId = await seedJob("echo", { text: "the quick brown fox" });
    const handle: RunModel = {
      transport: "agent-sdk",
      forRun({ tools, observe }) {
        return new MockLanguageModelV4({
          modelId: MODEL,
          provider: "claude-code",
          doGenerate: async (): Promise<LanguageModelV4GenerateResult> => {
            const execute = tools.shout?.execute as
              | ((input: { text: string }, options: { toolCallId: string; messages: never[] }) => Promise<unknown>)
              | undefined;
            if (execute === undefined) throw new Error("no shout tool");
            // Start the tool first; it must not take an index yet.
            let toolDone = false;
            const toolRun = execute({ text: "the quick brown fox" }, { toolCallId: "call-1", messages: [] }).then(() => {
              toolDone = true;
            });
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(toolDone).toBe(false);
            // Now the turn arrives; the tool is released behind it.
            await observe.onTurn({ messageId: "msg_1", model: MODEL, stopReason: "tool_use", blocks: ["tool_use:mcp__relay__shout"], usage: TURN_1 });
            await toolRun;
            await observe.onTurn({ messageId: "msg_2", model: MODEL, stopReason: "end_turn", blocks: ["text"], usage: TURN_2 });
            await observe.onResult({ ...RESULT, modelUsage: { "claude-opus-5": RESULT.modelUsage["claude-opus-5"]! } });
            return {
              content: [{ type: "text", text: JSON.stringify({ text: "THE QUICK BROWN FOX" }) }],
              finishReason: { unified: "stop", raw: "end_turn" },
              usage: { inputTokens: { total: 1620, noCache: 4, cacheRead: 754, cacheWrite: 862 }, outputTokens: { total: 138, text: undefined, reasoning: undefined } },
              providerMetadata: { "claude-code": { sessionId: "s" } },
              warnings: [],
            };
          },
        });
      },
    };
    const result = await runAgent({
      definition: loadDefinition("echo"),
      input: { text: "the quick brown fox" },
      ctx: { db: prisma, orgId: ORG_ID, jobId, model: handle, modelId: MODEL, tools: (recorder) => echoTools(recorder) },
    });
    expect(result.steps.map((step) => [step.index, step.kind])).toEqual([
      [0, "model"],
      [1, "tool"],
      [2, "model"],
    ]);
  });

  it("reports the SDK's turn cap as `cap`, with the turns it spent recorded", async () => {
    const jobId = await seedJob("echo", { text: "the quick brown fox" });
    const standIn = agentSdkStandIn({
      turns: [TURN_1],
      result: { subtype: "error_max_turns", numTurns: 1, totalCostUsd: 0.00815, modelUsage: {}, errors: ["Reached maximum number of turns (1)"] },
      // What the bridge throws: an API error whose message is prose.
      ending: { throws: "Reached maximum number of turns (1)" },
    });
    const failure = await runAgent({
      definition: loadDefinition("echo"),
      input: { text: "the quick brown fox" },
      ctx: { db: prisma, orgId: ORG_ID, jobId, model: standIn.handle, modelId: MODEL, tools: (recorder) => echoTools(recorder) },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AgentRunFailedError);
    expect((failure as AgentRunFailedError).reason).toBe("cap");
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: (failure as AgentRunFailedError).runId } });
    expect(run.status).toBe("failed");
    expect(run.costTotal.toString()).toBe("0.00815");
  });

  it("fails the run rather than record a model the price table does not know", async () => {
    const jobId = await seedJob("echo", { text: "the quick brown fox" });
    const standIn = agentSdkStandIn({
      turns: [TURN_1, TURN_2],
      result: {
        ...RESULT,
        modelUsage: {
          ...RESULT.modelUsage,
          "claude-opus-4-8": { inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.000075 },
        },
      },
      ending: { text: JSON.stringify({ text: "THE QUICK BROWN FOX" }) },
    });
    const failure = await runAgent({
      definition: loadDefinition("echo"),
      input: { text: "the quick brown fox" },
      ctx: { db: prisma, orgId: ORG_ID, jobId, model: standIn.handle, modelId: MODEL, tools: (recorder) => echoTools(recorder) },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AgentRunFailedError);
    // A cost that cannot be computed is a step that cannot be recorded.
    expect((failure as AgentRunFailedError).reason).toBe("step-record");
    // The stored line is scrubbed to the error's name; the cause names the model.
    expect(String((failure as AgentRunFailedError).cause)).toMatch(/claude-opus-4-8/);
  });
});

describe("usage from the SDK's wire block", () => {
  it("builds the total from the three parts and reads the one-hour share", () => {
    expect(usageFromAnthropic(TURN_2)).toEqual({
      tokensIn: 864,
      tokensInUncached: 2,
      tokensCacheRead: 754,
      tokensCacheWrite: 108,
      tokensCacheWrite1h: 108,
      tokensOut: 114,
      tokensReasoning: 0,
    });
    expect(usageFromAnthropic({})).toMatchObject({ tokensIn: 0, tokensCacheWrite1h: 0 });
  });

  it("strips the SDK's dated alias to the price table's id", () => {
    expect(canonicalModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(canonicalModelId("claude-opus-5")).toBe("claude-opus-5");
  });
});
