import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createClaudeCode, type ClaudeCodeSettings } from "@relay/claude-code-bridge";

import { echoTools } from "../../agents/echo/tools";
import { RELAY_MCP_SERVER, mcpToolName, relayToolServer } from "@/lib/agents/mcpTools";
import type { AgentSdkObserver } from "@/lib/agents/model";
import {
  agentHome,
  agentSdkSettings,
  credentialKind,
  makeModel,
  subprocessEnv,
  transportFor,
} from "@/lib/agents/provider";
import type { ToolRecorder } from "@/lib/agents/tools";
import { parseEnv } from "@/lib/env";

/** A recorder for building a tool set that is never called. */
function probeRecorder(): ToolRecorder {
  const refuse = (): never => {
    throw new Error("the probe recorder must not be used");
  };
  return {
    orgId: "org_probe",
    jobId: "job_probe",
    runId: "run_probe",
    runKind: "echo",
    replayed: 0,
    takeIndex: refuse,
    key: refuse,
    beginCall: refuse,
    endCall: refuse,
    failCall: refuse,
    noteReplay: refuse,
  };
}

/**
 * One credential leaves the process, and it is the subscription token when there
 * is one — and the token travels on the Agent SDK, the key on the Messages API.
 *
 * No test here holds a real credential, and none needs to: what is being checked
 * is which transport each credential is routed to, the exact settings the SDK
 * subprocess is given (isolation, no built-in tools, no prompt, only Relay's
 * tools by name), and that a process holding both credentials hands the
 * subprocess only the token. The live half — that Anthropic accepts the token
 * through the SDK and that the ledger equals the SDK's own figures — is
 * `scripts/spike/cost-check.ts`, run 2026-09-09 (see the 6c handoff).
 */

const BASE = {
  DATABASE_URL: "postgresql://relay:relay@127.0.0.1:5435/relay_test",
  DIRECT_URL: "postgresql://relay:relay@127.0.0.1:5435/relay_test",
  NODE_ENV: "test",
};

const silent: AgentSdkObserver = { onTurn: async () => {}, onResult: async () => {} };

describe("credentialKind", () => {
  it("prefers the subscription token, and withholds the key when both are set", () => {
    const both = parseEnv({ ...BASE, CLAUDE_CODE_OAUTH_TOKEN: "token", ANTHROPIC_API_KEY: "key" });
    expect(credentialKind(both)).toBe("subscription-token");
    // Not "both": the decision of 2026-09-08 is that the subscription is the
    // billing path, so the key is never read rather than being a fallback that
    // might be.
    expect(transportFor(credentialKind(both))).toBe("agent-sdk");
  });

  it("falls back to the key when no token is configured", () => {
    const keyOnly = parseEnv({ ...BASE, ANTHROPIC_API_KEY: "key" });
    expect(credentialKind(keyOnly)).toBe("api-key");
    expect(transportFor("api-key")).toBe("messages");
  });

  it("reports none when neither is set", () => {
    expect(credentialKind(parseEnv(BASE))).toBe("none");
    expect(transportFor("none")).toBe("none");
  });
});

describe("makeModel", () => {
  it("routes the subscription token to the Agent SDK", () => {
    const handle = makeModel("claude-opus-5", parseEnv({ ...BASE, CLAUDE_CODE_OAUTH_TOKEN: "token" }));
    expect(handle.transport).toBe("agent-sdk");
  });

  it("builds a Messages API model on an API key", () => {
    const handle = makeModel("claude-sonnet-5", parseEnv({ ...BASE, ANTHROPIC_API_KEY: "key" }));
    expect(handle.transport).toBe("messages");
    if (handle.transport !== "messages") throw new Error("unreachable");
    expect((handle.model as { modelId: string }).modelId).toBe("claude-sonnet-5");
  });

  it("names both variables when neither is configured", () => {
    // Rather than returning a model that fails on first use: a worker with no way
    // to call the API should say so before it opens a run.
    expect(() => makeModel("claude-opus-5", parseEnv(BASE))).toThrow(/CLAUDE_CODE_OAUTH_TOKEN.*ANTHROPIC_API_KEY/);
  });

  it("refuses a model the price table does not know", () => {
    expect(() =>
      makeModel("claude-opus-4-8" as "claude-opus-5", parseEnv({ ...BASE, ANTHROPIC_API_KEY: "key" })),
    ).toThrow(/not a pinned Relay model/);
  });

  it("serves the scripted model first, when one is configured", () => {
    const script = JSON.stringify({ calls: [{ text: "{}", usage: { in: 1, out: 1 } }] });
    const handle = makeModel(
      "claude-opus-5",
      parseEnv({ ...BASE, CLAUDE_CODE_OAUTH_TOKEN: "token", RELAY_AGENT_STUB_MODEL: script }),
    );
    expect(handle.transport).toBe("stub");
    if (handle.transport !== "stub") throw new Error("unreachable");
    expect((handle.model as { provider: string }).provider).toBe("relay-stub");
  });
});

describe("the Agent SDK subprocess", () => {
  it("is given the token and the config dir, and never the API key", () => {
    // Set to `undefined` rather than omitted: the bridge inherits `ANTHROPIC_*`
    // from this process by allowlist, and an explicit undefined is what removes
    // a key from the merged environment.
    const env = subprocessEnv("/tmp/relay-home", "token");
    expect(env).toEqual({
      CLAUDE_CONFIG_DIR: "/tmp/relay-home",
      CLAUDE_CODE_OAUTH_TOKEN: "token",
      ANTHROPIC_API_KEY: undefined,
    });
    expect(Object.keys(env)).toContain("ANTHROPIC_API_KEY");
  });

  it("uses RELAY_AGENT_HOME, or a directory under the home directory", () => {
    expect(agentHome(parseEnv({ ...BASE, RELAY_AGENT_HOME: "/srv/relay/agent-home" }))).toBe("/srv/relay/agent-home");
    expect(agentHome(parseEnv(BASE))).toMatch(/\/\.relay\/agent-home$/);
  });

  it("runs isolated, with no built-in tools, no prompt, and only Relay's tools by name", () => {
    const tools = echoTools(probeRecorder());
    const settings = agentSdkSettings({
      configDir: "/tmp/relay-home",
      token: "token",
      run: { tools, maxTurns: 4, observe: silent },
    });
    // Isolation: nothing from disk, and a config dir that is the worker's.
    expect(settings.settingSources).toEqual([]);
    expect(settings.env).toMatchObject({ CLAUDE_CONFIG_DIR: "/tmp/relay-home" });
    expect(settings.persistSession).toBe(false);
    // No built-in tool: `tools: []` is the SDK's "none", not its "default".
    expect(settings.tools).toEqual([]);
    // Only Relay's, by exact name, under the one server.
    expect(settings.allowedTools).toEqual([mcpToolName("shout")]);
    expect(Object.keys(settings.mcpServers ?? {})).toEqual([RELAY_MCP_SERVER]);
    // No prompt can block, and the SDK's acknowledgement for that is set.
    expect(settings.permissionMode).toBe("bypassPermissions");
    expect(settings.allowDangerouslySkipPermissions).toBe(true);
    // The cap is the definition's model-step budget.
    expect(settings.maxTurns).toBe(4);
  });

  it("gives a definition with no tools a server with none, and an empty allow list", () => {
    const settings = agentSdkSettings({
      configDir: "/tmp/relay-home",
      token: "token",
      run: { tools: {}, maxTurns: 3, observe: silent },
    });
    expect(settings.allowedTools).toEqual([]);
    expect(settings.tools).toEqual([]);
  });

  it("relays each assistant turn and the closing result to the observer, in the SDK's own terms", async () => {
    const turns: unknown[] = [];
    const results: unknown[] = [];
    const settings = agentSdkSettings({
      configDir: "/tmp/relay-home",
      token: "token",
      run: {
        tools: {},
        maxTurns: 3,
        observe: {
          onTurn: async (turn) => {
            turns.push(turn);
          },
          onResult: async (result) => {
            results.push(result);
          },
        },
      },
    });
    const onSdkMessage = settings.onSdkMessage;
    if (onSdkMessage === undefined) throw new Error("no onSdkMessage");
    const usage = {
      input_tokens: 2,
      cache_creation_input_tokens: 754,
      cache_read_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 754 },
      output_tokens: 24,
    };
    await onSdkMessage({
      type: "assistant",
      message: {
        id: "msg_1",
        model: "claude-opus-5",
        stop_reason: null,
        content: [{ type: "tool_use", name: "mcp__relay__shout" }],
        usage,
      },
    } as never);
    await onSdkMessage({ type: "user" } as never);
    await onSdkMessage({
      type: "result",
      subtype: "error_max_turns",
      num_turns: 1,
      total_cost_usd: 0.00815,
      modelUsage: {},
      errors: ["Reached maximum number of turns (1)"],
    } as never);
    expect(turns).toEqual([
      { messageId: "msg_1", model: "claude-opus-5", stopReason: null, blocks: ["tool_use:mcp__relay__shout"], usage },
    ]);
    expect(results).toEqual([
      {
        subtype: "error_max_turns",
        numTurns: 1,
        totalCostUsd: 0.00815,
        modelUsage: {},
        errors: ["Reached maximum number of turns (1)"],
      },
    ]);
  });
});

describe("the environment the SDK subprocess is actually spawned with", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });

  /**
   * Through the real bridge and the real SDK, up to the moment of `spawn`.
   *
   * The bridge builds the subprocess environment from an allowlist of this
   * process's variables — `ANTHROPIC_*` and `CLAUDE_*` among them — and merges
   * `env` over it. `subprocessEnv` relies on an explicit `undefined` removing a
   * key from that merge. A pure-function test cannot show that; this one hands
   * the SDK a `spawnClaudeCodeProcess` that records what it was asked to spawn
   * and refuses, so the exact `env` a real run would give the CLI is captured
   * without starting one.
   */
  async function spawnEnvFor(settings: ClaudeCodeSettings): Promise<Record<string, string | undefined>> {
    let captured: Record<string, string | undefined> | undefined;
    const model = createClaudeCode({
      defaultSettings: {
        ...settings,
        spawnClaudeCodeProcess: (options) => {
          captured = { ...options.env };
          throw new Error("captured the spawn; not starting a subprocess in a test");
        },
      },
    })("claude-opus-5");
    await (model as unknown as { doGenerate: (options: unknown) => Promise<unknown> })
      .doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })
      .catch(() => undefined);
    if (captured === undefined) throw new Error("the bridge never reached spawn");
    return captured;
  }

  it("carries the token and the config dir, and not the API key this process holds", async () => {
    // Both credentials in this process, the way a worker with both variables
    // configured would be. The allowlist would inherit both; the explicit map
    // must leave exactly one.
    process.env.ANTHROPIC_API_KEY = "key_in_process_example";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "tok_in_process_example";
    const env = await spawnEnvFor(
      agentSdkSettings({
        configDir: "/tmp/relay-home-spawn-test",
        token: "tok_relay_example",
        run: { tools: {}, maxTurns: 1, observe: silent },
      }),
    );
    expect(env.CLAUDE_CONFIG_DIR).toBe("/tmp/relay-home-spawn-test");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok_relay_example");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(Object.values(env).join(" ")).not.toContain("key_in_process_example");
  });

  it("would have inherited the key without the explicit removal, which is why the removal is there", async () => {
    process.env.ANTHROPIC_API_KEY = "key_in_process_example";
    const settings = agentSdkSettings({
      configDir: "/tmp/relay-home-spawn-test",
      token: "tok_relay_example",
      run: { tools: {}, maxTurns: 1, observe: silent },
    });
    const withoutTheRemoval = Object.fromEntries(Object.entries(settings.env ?? {}).filter(([key]) => key !== "ANTHROPIC_API_KEY"));
    const env = await spawnEnvFor({ ...settings, env: withoutTheRemoval });
    expect(env.ANTHROPIC_API_KEY).toBe("key_in_process_example");
  });
});

describe("relayToolServer", () => {
  it("accepts the repository's zod 3 schemas, which is the whole zod gate", () => {
    // The bridge and the Agent SDK peer on zod 4 and are installed with their
    // own, nested (see vendor/claude-code-bridge). A tool's `inputSchema` is a
    // zod 3 object from the root install; the bridge reads its `.shape` and the
    // SDK builds the MCP schema from it. If that ever stopped working, this is
    // the line that would throw.
    expect(z.object({}).constructor.name).toBe("ZodObject");
    const server = relayToolServer(echoTools(probeRecorder()));
    expect(server.allowedTools).toEqual(["mcp__relay__shout"]);
    expect(server.mcpServers[RELAY_MCP_SERVER]).toMatchObject({ type: "sdk", name: RELAY_MCP_SERVER });
  });

  it("refuses a tool with nothing to execute", () => {
    expect(() =>
      relayToolServer({ nothing: { description: "x", inputSchema: z.object({}) } } as never),
    ).toThrow(/no execute function/);
  });
});

describe("the headers a Messages API request actually carries", () => {
  /**
   * Through a recording `fetch`, not through a description of the headers.
   *
   * The subscription token no longer travels this way at all — it goes to the
   * Agent SDK subprocess, whose environment is pinned above — so the one thing
   * left to check on the wire is that the API key is on `x-api-key` and nothing
   * else, and that a process holding both credentials never gets here with the
   * key: `makeModel` routes both-set to the SDK.
   */
  async function headersFor(source: Parameters<typeof makeModel>[1]): Promise<Headers> {
    let seen: Headers | undefined;
    const handle = makeModel("claude-opus-5", source, {
      fetch: async (input, init) => {
        seen = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        // Enough of a Messages response for the provider to parse; the call's
        // content is irrelevant, only the request headers are under test.
        return new Response(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-opus-5",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    if (handle.transport !== "messages") throw new Error(`expected the Messages API, got ${handle.transport}`);
    // Through `unknown`: `LanguageModel` is a union that includes the V2 and V3
    // specifications, whose `doGenerate` returns a `PromiseLike` rather than a
    // `Promise`, so the direct cast is not an overlap TypeScript will accept.
    await (handle.model as unknown as { doGenerate: (options: unknown) => Promise<unknown> }).doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 16,
    });
    if (seen === undefined) throw new Error("the provider made no request");
    return seen;
  }

  it("sends an API key as x-api-key, with no bearer token and no OAuth beta", async () => {
    const headers = await headersFor(parseEnv({ ...BASE, ANTHROPIC_API_KEY: "key_example" }));
    expect(headers.get("x-api-key")).toBe("key_example");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("anthropic-beta")).toBeNull();
  });

  it("never reaches the Messages API when a token is set beside the key", () => {
    const handle = makeModel(
      "claude-opus-5",
      parseEnv({ ...BASE, CLAUDE_CODE_OAUTH_TOKEN: "tok_live_example", ANTHROPIC_API_KEY: "key_example" }),
    );
    expect(handle.transport).toBe("agent-sdk");
  });
});

describe("the stub model's guard", () => {
  it("refuses to boot a production environment that has one set", () => {
    // The same allowlist `DEV_USER_EMAIL` rides, and for a worse failure: a stub
    // model makes every agent in the org answer from a fixture and every run look
    // healthy.
    expect(() =>
      parseEnv({
        ...BASE,
        NODE_ENV: "production",
        RELAY_AGENT_STUB_MODEL: JSON.stringify({ calls: [{ text: "{}", usage: { in: 1, out: 1 } }] }),
      }),
    ).toThrow(/RELAY_AGENT_STUB_MODEL is a local-only scripted model/);
  });

  it("refuses it during a build too, unlike the sign-in bypass", () => {
    // `next build` is carved out of the `DEV_USER_EMAIL` guard because a build
    // loads a developer's env file and serves no request. A build makes no model
    // call at all, so there is nothing to carve out here.
    expect(() =>
      parseEnv({
        ...BASE,
        NODE_ENV: "production",
        NEXT_PHASE: "phase-production-build",
        RELAY_AGENT_STUB_MODEL: JSON.stringify({ calls: [{ text: "{}", usage: { in: 1, out: 1 } }] }),
      }),
    ).toThrow(/RELAY_AGENT_STUB_MODEL/);
  });

  it("names what is wrong with a malformed script", () => {
    const env = parseEnv({ ...BASE, RELAY_AGENT_STUB_MODEL: "not json" });
    expect(() => makeModel("claude-opus-5", env)).toThrow(/not valid JSON/);
    const empty = parseEnv({ ...BASE, RELAY_AGENT_STUB_MODEL: JSON.stringify({ calls: [] }) });
    expect(() => makeModel("claude-opus-5", empty)).toThrow(/not a valid script/);
  });
});
