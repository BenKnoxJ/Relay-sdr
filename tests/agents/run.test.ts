import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { echoTools } from "../../agents/echo/tools";
import { loadDefinition } from "@/lib/agents/definitions";
import { cost, formatMicroDollars, PRICES } from "@/lib/agents/pricing";
import { runAgent } from "@/lib/agents/run";
import { prisma } from "@/lib/db";

import { emptyAll, resetDatabase } from "../db/harness";
import { ORG_ID, scriptedModel, seedJob, seedOrg } from "./harness";

/**
 * Proof 1 of the runtime spike rubric (§24), offline.
 *
 * The pass condition is that the row equals the response: "every `AgentRunStep`
 * row's `tokensIn`, `tokensOut`, `tokensCached`, `tokensReasoning` equal the
 * corresponding fields of the response `usage`; `cost` equals tokens times the
 * pinned price table", with the final structured-output call counted as a step
 * and raw `providerMetadata` stored on every one.
 *
 * Offline, against the SDK's own mock, because the live half cannot assert on
 * exact numbers — a real model chooses how many tokens to use. The live script
 * (`scripts/spike/cost-check.ts`) proves the same identity against whatever the
 * API actually returns; this proves it against numbers a test can state.
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

describe("runAgent", () => {
  it("@proof records one step per model call and one per tool call, in the order they happened", async () => {
    const definition = loadDefinition("echo");
    const jobId = await seedJob("echo", { text: "hello" });
    const script = [
      { tool: { name: "shout", args: { text: "hello" } }, usage: { in: 1_000, out: 20 } },
      { tool: { name: "shout", args: { text: "again" } }, usage: { in: 1_200, out: 24, cacheRead: 500 } },
      { text: JSON.stringify({ text: "HELLO" }), usage: { in: 1_400, out: 30, reasoning: 8 } },
    ] as const;
    const { model, callCount } = scriptedModel([...script]);

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

    expect(result.object).toEqual({ text: "HELLO" });
    expect(callCount()).toBe(3);
    expect(result.replayedToolCalls).toBe(0);

    // Three model calls and two tool calls: the final structured-output call is
    // a step and is counted, which is the rubric's own wording.
    expect(result.steps.map((step) => `${step.index}:${step.kind}:${step.name}`)).toEqual([
      "0:model:claude-opus-5",
      "1:tool:shout",
      "2:model:claude-opus-5",
      "3:tool:shout",
      "4:model:claude-opus-5",
    ]);

    const modelSteps = result.steps.filter((step) => step.kind === "model");
    expect(modelSteps).toHaveLength(3);
    modelSteps.forEach((step, i) => {
      const scripted = script[i];
      if (scripted === undefined) throw new Error("the script and the steps disagree");
      const cacheRead = "cacheRead" in scripted.usage ? scripted.usage.cacheRead : 0;
      const reasoning = "reasoning" in scripted.usage ? scripted.usage.reasoning : 0;

      // `tokensIn` is the provider's *total*, which includes the cache read —
      // the identity `@ai-sdk/anthropic` builds and the one the pricing module
      // prices around.
      expect(step.tokensIn).toBe(scripted.usage.in + cacheRead);
      expect(step.tokensOut).toBe(scripted.usage.out);
      expect(step.tokensCached).toBe(cacheRead);
      expect(step.tokensReasoning).toBe(reasoning);

      // `.equals`, not `.toString()`: Prisma's Decimal trims trailing zeros, so
      // the column's `0.005500` prints as `0.0055` and a string comparison would
      // be testing the printer.
      expect(
        step.cost.equals(
          new Prisma.Decimal(
            cost(
              {
                tokensIn: scripted.usage.in + cacheRead,
                tokensInUncached: scripted.usage.in,
                tokensCacheRead: cacheRead,
                tokensCacheWrite: 0,
                tokensOut: scripted.usage.out,
              },
              MODEL,
            ),
          ),
        ),
      ).toBe(true);

      // Raw provider metadata, kept, plus the usage the cost was computed from:
      // the column exists so a cost figure can be argued with.
      const meta = step.providerMeta as Record<string, unknown>;
      expect(meta.providerMetadata).toEqual({ "mock-anthropic": { requestId: `req-${i + 1}` } });
      expect(meta.responseModelId).toBe("claude-opus-5");
      expect(meta.usage).toMatchObject({ tokensCacheWrite: 0, tokensCacheRead: cacheRead });
    });

    // The tool steps carry their input, their output and their key, and no cost:
    // a tool spends credits, not tokens, and slice 1 fills that in.
    const toolSteps = result.steps.filter((step) => step.kind === "tool");
    expect(toolSteps.map((step) => step.input)).toEqual([{ text: "hello" }, { text: "again" }]);
    expect(toolSteps.map((step) => step.output)).toEqual([{ text: "HELLO" }, { text: "AGAIN" }]);
    expect(toolSteps.every((step) => step.toolKey !== null)).toBe(true);
    expect(new Set(toolSteps.map((step) => step.toolKey)).size).toBe(2);
    expect(toolSteps.every((step) => step.cost.equals(new Prisma.Decimal(0)))).toBe(true);

    // `costTotal` is the sum of the steps, to the last of the column's six
    // decimal places.
    const summed = result.steps.reduce(
      (total, step) => total.add(step.cost),
      new Prisma.Decimal(0),
    );
    expect(result.run.costTotal.equals(summed)).toBe(true);
    expect(result.run.costTotal.greaterThan(0)).toBe(true);
    expect(result.run.status).toBe("done");
    expect(result.run.finishedAt).not.toBeNull();
    expect(result.run.model).toBe(MODEL);
    expect(result.run.kind).toBe("echo");
    expect(result.run.orgId).toBe(ORG_ID);
    expect(result.steps.every((step) => step.orgId === ORG_ID)).toBe(true);
  });

  it("prices a cached read at a tenth of the input rate and a reasoning token at the output rate", async () => {
    // Not a property of the loop, a property of the table, asserted here because
    // the loop is what feeds it: a cache read priced as a fresh input token is a
    // tenfold overcharge that no test of the loop's shape would notice.
    const opus = PRICES[MODEL];
    if (opus === undefined) throw new Error("claude-opus-5 is not priced");
    expect(opus.cacheRead * 10n).toBe(opus.input);
    expect(opus.cacheWrite * 4n).toBe(opus.input * 5n);

    // A million cached reads cost the same as a hundred thousand fresh ones.
    expect(
      cost({ tokensIn: 1_000_000, tokensInUncached: 0, tokensCacheRead: 1_000_000, tokensCacheWrite: 0, tokensOut: 0 }, MODEL),
    ).toBe(formatMicroDollars(500_000n));
    // Reasoning is inside the output total and is not billed a second time.
    expect(
      cost({ tokensIn: 0, tokensInUncached: 0, tokensCacheRead: 0, tokensCacheWrite: 0, tokensOut: 1_000 }, MODEL),
    ).toBe(formatMicroDollars(25_000n));
  });

  it("refuses a tool set that does not match the definition's declared list", async () => {
    const definition = loadDefinition("echo");
    const jobId = await seedJob("echo", { text: "hello" });
    const { model } = scriptedModel([{ text: JSON.stringify({ text: "HI" }), usage: { in: 1, out: 1 } }]);

    await expect(
      runAgent({
        definition,
        input: { text: "hello" },
        // No tools at all, against a definition that declares `shout`.
        ctx: { db: prisma, orgId: ORG_ID, jobId, model, modelId: MODEL },
      }),
    ).rejects.toThrow(/declares tools \[shout\] but was given \[\]/);
  });

  it("fails the run rather than returning an answer the definition's schema rejects", async () => {
    const definition = loadDefinition("echo");
    const jobId = await seedJob("echo", { text: "hello" });
    // A shape `Output.object` accepts as JSON and the definition does not: the
    // text is the wrong type.
    const { model } = scriptedModel([
      { text: JSON.stringify({ text: 42 }), usage: { in: 100, out: 10 } },
    ]);

    await expect(
      runAgent({
        definition,
        input: { text: "hello" },
        ctx: { db: prisma, orgId: ORG_ID, jobId, model, modelId: MODEL, tools: (r) => echoTools(r) },
      }),
    ).rejects.toMatchObject({ name: "AgentRunFailedError", reason: "schema" });

    const run = await prisma.agentRun.findFirstOrThrow({ where: { jobId } });
    expect(run.status).toBe("failed");
    expect(run.finishedAt).not.toBeNull();
    // The tokens were spent before the answer was read, so they are charged.
    expect(run.costTotal.greaterThan(0)).toBe(true);
  });
});
