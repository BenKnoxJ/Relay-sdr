import type { LanguageModelV4, LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { z } from "zod";

/**
 * A scripted language model, for proving the runtime end to end without a
 * credential.
 *
 * `tests/agents/echo.test.ts` has to run the **real worker process** — `npm run
 * worker -- --once`, the loop with its claim, its lease and its completion — and
 * a spawned process cannot be handed a mock object. The only seam a child
 * process has is its environment, so this is that seam: a script in
 * `RELAY_AGENT_STUB_MODEL`, read by `makeModel` and nowhere else.
 *
 * **It is gated the way `DEV_USER_EMAIL` is gated**, and for the same reason.
 * `src/lib/env.ts` accepts the variable only when `NODE_ENV` is explicitly
 * `development` or `test`; silence is production and production refuses to boot
 * with it set. A stub model in production would be worse than a sign-in bypass:
 * it would make every agent answer from a fixture and every run look healthy.
 * That is why the guard lives in the schema, where the process dies, rather than
 * in a branch here, where it would only mean an odd-looking run.
 *
 * It is not `MockLanguageModelV4` from `ai/test`, deliberately: that lives in a
 * dev dependency, and a dev dependency reached from `src/lib` is a dev
 * dependency in the worker's production bundle. The unit tests use the real mock
 * directly, where it belongs.
 */

const usageSchema = z
  .object({
    in: z.number().int().nonnegative(),
    out: z.number().int().nonnegative(),
    cacheRead: z.number().int().nonnegative().default(0),
    cacheWrite: z.number().int().nonnegative().default(0),
    reasoning: z.number().int().nonnegative().default(0),
  })
  .strict();

const callSchema = z.union([
  z
    .object({
      /** Ask for a tool. The loop will run it and come back for the next entry. */
      tool: z.object({ name: z.string().min(1), args: z.unknown() }).strict(),
      usage: usageSchema,
    })
    .strict(),
  z
    .object({
      /** Answer. For a structured output this is the JSON, as text. */
      text: z.string(),
      usage: usageSchema,
    })
    .strict(),
]);

export const stubScriptSchema = z
  .object({
    modelId: z.string().min(1).default("claude-opus-5"),
    calls: z.array(callSchema).min(1).max(20),
    /**
     * What to do once the script runs out: repeat the last entry, or throw.
     *
     * `repeat` is how the cap test gets a model that never stops calling tools
     * from a finite script.
     */
    whenExhausted: z.enum(["repeat-last", "throw"]).default("throw"),
  })
  .strict();

export type StubScript = z.infer<typeof stubScriptSchema>;

export function parseStubScript(raw: string): StubScript {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error("RELAY_AGENT_STUB_MODEL is not valid JSON", { cause: error });
  }
  const parsed = stubScriptSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `RELAY_AGENT_STUB_MODEL is not a valid script: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`).join("; ")}`,
    );
  }
  return parsed.data;
}

/** A model that answers from the script, in order. */
export function stubModel(script: StubScript): LanguageModelV4 {
  let index = 0;
  return {
    specificationVersion: "v4",
    provider: "relay-stub",
    modelId: script.modelId,
    supportedUrls: {},
    async doGenerate(): Promise<LanguageModelV4GenerateResult> {
      const call = script.calls[index] ?? (script.whenExhausted === "repeat-last" ? script.calls.at(-1) : undefined);
      if (call === undefined) {
        throw new Error(`RELAY_AGENT_STUB_MODEL ran out after ${script.calls.length} call(s)`);
      }
      index += 1;
      const usage = {
        inputTokens: {
          // The provider contract's `total` is the sum of the three details, and
          // the runtime prices the details. A script that gave a total of its own
          // could describe a response no provider would send.
          total: call.usage.in + call.usage.cacheRead + call.usage.cacheWrite,
          noCache: call.usage.in,
          cacheRead: call.usage.cacheRead,
          cacheWrite: call.usage.cacheWrite,
        },
        outputTokens: {
          total: call.usage.out,
          text: call.usage.out - call.usage.reasoning,
          reasoning: call.usage.reasoning,
        },
        totalTokens: call.usage.in + call.usage.cacheRead + call.usage.cacheWrite + call.usage.out,
      };
      if ("tool" in call) {
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: `stub-${index}`,
              toolName: call.tool.name,
              input: JSON.stringify(call.tool.args ?? {}),
            },
          ],
          finishReason: { unified: "tool-calls", raw: "tool_use" },
          usage,
          providerMetadata: { "relay-stub": { call: index } },
          warnings: [],
        };
      }
      return {
        content: [{ type: "text", text: call.text }],
        finishReason: { unified: "stop", raw: "end_turn" },
        usage,
        providerMetadata: { "relay-stub": { call: index } },
        warnings: [],
      };
    },
    doStream() {
      // The worker never streams (§24: there is no screen waiting on a token),
      // so this is unreachable rather than unimplemented.
      throw new Error("the stub model does not stream");
    },
  };
}
