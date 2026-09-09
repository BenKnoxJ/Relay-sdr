import type { LanguageModelV4, LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";

import { prisma } from "@/lib/db";
import { enqueue } from "@/lib/jobs/queue";
import { mutate } from "@/lib/repo/mutate";

/**
 * Fixtures for the agent-runtime suite.
 *
 * A run needs an org and a job, because `agent_runs` has a foreign key to each:
 * §25 rule 3 is that every row is org-scoped, and a run with no job is a run
 * nothing asked for.
 */

export const ORG_ID = "org_agents";

export async function seedOrg(orgId: string = ORG_ID): Promise<void> {
  await mutate(prisma, {
    orgId,
    actor: { kind: "system" },
    kind: "org.created",
    apply: (tx) => tx.org.create({ data: { id: orgId, name: orgId } }),
  });
}

export async function seedJob(
  kind: string,
  input: unknown,
  idempotencyKey = `${kind}-${Math.random().toString(36).slice(2)}`,
): Promise<string> {
  const { job } = await enqueue(prisma, {
    orgId: ORG_ID,
    kind,
    idempotencyKey,
    input: input as never,
  });
  return job.id;
}

/** What a scripted model call reports it used. */
export type ScriptUsage = {
  in: number;
  out: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
};

export type ScriptedCall =
  | { tool: { name: string; args: unknown }; usage: ScriptUsage }
  | { text: string; usage: ScriptUsage };

/**
 * The AI SDK's own mock, scripted.
 *
 * `MockLanguageModelV4` rather than a hand-rolled object, so the tests are
 * checking the SDK's behaviour and not an imitation of it. One detail is worth
 * pinning because it cost a debugging pass: a V4 provider's `finishReason` is
 * `{ unified, raw }`, not a bare string, and a bare string reads as `undefined`
 * at the `unified` property — so the loop sees no tool call, stops after one
 * step, and the test "proves" a single-step run.
 */
export function scriptedModel(
  calls: ScriptedCall[],
  options: { repeatLast?: boolean; modelId?: string } = {},
): { model: LanguageModelV4; callCount: () => number } {
  let index = 0;
  const model = new MockLanguageModelV4({
    modelId: options.modelId ?? "claude-opus-5",
    provider: "mock-anthropic",
    doGenerate: async (): Promise<LanguageModelV4GenerateResult> => {
      const call = calls[index] ?? (options.repeatLast === true ? calls.at(-1) : undefined);
      if (call === undefined) throw new Error(`the script ran out after ${calls.length} call(s)`);
      index += 1;
      const usage = toUsage(call.usage);
      if ("tool" in call) {
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: `call-${index}`,
              toolName: call.tool.name,
              input: JSON.stringify(call.tool.args),
            },
          ],
          finishReason: { unified: "tool-calls", raw: "tool_use" },
          usage,
          providerMetadata: { "mock-anthropic": { requestId: `req-${index}` } },
          warnings: [],
        };
      }
      return {
        content: [{ type: "text", text: call.text }],
        finishReason: { unified: "stop", raw: "end_turn" },
        usage,
        providerMetadata: { "mock-anthropic": { requestId: `req-${index}` } },
        warnings: [],
      };
    },
  });
  return { model, callCount: () => index };
}

function toUsage(usage: ScriptUsage) {
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const reasoning = usage.reasoning ?? 0;
  return {
    inputTokens: {
      // `total` is the sum of the three, exactly as `@ai-sdk/anthropic`'s own
      // conversion builds it. Anything else would describe a response the
      // provider could not have sent, and the cost arithmetic under test reads
      // the parts rather than the total precisely because of that identity.
      total: usage.in + cacheRead + cacheWrite,
      noCache: usage.in,
      cacheRead,
      cacheWrite,
    },
    outputTokens: { total: usage.out, text: usage.out - reasoning, reasoning },
    totalTokens: usage.in + cacheRead + cacheWrite + usage.out,
  };
}
