import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { echoTools } from "../../agents/echo/tools";
import { agentsDir, loadDefinition, type AgentDefinition } from "@/lib/agents/definitions";
import { runAgent } from "@/lib/agents/run";
import { prisma } from "@/lib/db";

import { emptyAll, resetDatabase } from "../db/harness";
import { ORG_ID, scriptedModel, seedJob, seedOrg } from "./harness";

/**
 * The step cap stops the run, and a capped run has no answer.
 *
 * The second half is the one that matters. A loop that hit its cap and then
 * returned whatever the model had last said would be a run that spent its whole
 * budget and produced something nobody validated — and for research, that is a
 * pack with no unknowns and invented firms, which is exactly what §5's stop rule
 * exists to prevent. So `cap` is a failure, and a partial answer is not accepted.
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

describe("the model-step cap", () => {
  it("fails the run with reason cap and accepts no partial answer", async () => {
    const base = loadDefinition("echo");
    // One step, against a model that keeps asking for the tool. A new object
    // rather than an edit: `SPECS` is the signed budget and a test that mutated
    // it would leak into every later test in the file.
    const capped: AgentDefinition<{ text: string }, { text: string }> = {
      ...base,
      budget: { ...base.budget, maxModelSteps: 1 },
    };
    const jobId = await seedJob("echo", { text: "hello" });
    const { model, callCount } = scriptedModel(
      [{ tool: { name: "shout", args: { text: "hello" } }, usage: { in: 500, out: 20 } }],
      { repeatLast: true },
    );

    const failure = await runAgent({
      definition: capped,
      input: { text: "hello" },
      ctx: {
        db: prisma,
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

    expect(failure).toMatchObject({ name: "AgentRunFailedError", reason: "cap" });
    // One model call, because one was the cap — not "about one".
    expect(callCount()).toBe(1);

    const run = await prisma.agentRun.findFirstOrThrow({ where: { jobId } });
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/^cap: stopped at the 1-step cap with no answer/);
    expect(run.finishedAt).not.toBeNull();
    // The one call it made is charged. A cap is not a refund.
    expect(run.costTotal.greaterThan(0)).toBe(true);

    const steps = await prisma.agentRunStep.findMany({ orderBy: { index: "asc" } });
    expect(steps.map((step) => step.kind)).toEqual(["model", "tool"]);
    expect(run.costTotal.equals(steps[0]?.cost ?? 0)).toBe(true);
  });

  it("refuses to run a definition that makes no model calls", async () => {
    // Lead gen is code (`agents/leadgen/definition.md` §0). Pointing the loop at
    // it would send an empty system prompt to a paid API, so it is a throw before
    // a run row exists rather than a failed run.
    const leadgen = loadDefinition("leadgen");
    expect(leadgen.prompt).toBeNull();
    const jobId = await seedJob("lead_gen", {});
    const { model } = scriptedModel([{ text: "{}", usage: { in: 1, out: 1 } }]);

    // A real input, even though the refusal happens before it is looked at: a
    // test that passed an empty object would still pass if the guard moved after
    // the parse, and would then be proving the parse.
    const input = leadgen.input.parse(
      JSON.parse(readFileSync(path.join(agentsDir(), "leadgen", "fixtures", "input.good.json"), "utf8")),
    );
    await expect(
      runAgent({
        definition: leadgen,
        input,
        ctx: { db: prisma, orgId: ORG_ID, jobId, model, modelId: MODEL },
      }),
    ).rejects.toThrow(/makes no model calls/);
    expect(await prisma.agentRun.count()).toBe(0);
  });
});
