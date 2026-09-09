import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";

import { createClaudeCode, type ClaudeCodeSettings } from "@relay/claude-code-bridge";

import { relayToolServer } from "@/lib/agents/mcpTools";
import type { AgentSdkRunOptions, AgentSdkResult, AgentSdkTurn, RunModel } from "@/lib/agents/model";
import { isPricedModel, type PricedModel } from "@/lib/agents/pricing";
import { parseStubScript, stubModel } from "@/lib/agents/stubModel";
import { env } from "@/lib/env";

/**
 * The one place a credential becomes a model handle.
 *
 * **Relay's agents bill to the Claude subscription, not an API key** (decision,
 * Benny-san, 2026-09-08, restated 2026-09-09 with the evidence in
 * `reviews/2026-09-09-spike-runtime-live-D2.md`). The subscription token that
 * `claude setup-token` prints is **refused by the Messages API** — three 429s
 * with an empty message, both models, same minute the fleet's own sessions were
 * answering — and accepted by the Claude Agent SDK. So the token's transport is
 * the Agent SDK, reached from the unchanged AI SDK loop through the
 * `ai-sdk-provider-claude-code` bridge (vendored under `vendor/` for the zod
 * gate; see the comment there). Master §24, amended 2026-09-09: the SDK is a
 * **model transport**, not the runtime — durability, the queue, approval as
 * database state and the ban on `claude -p` in the worker all stand.
 *
 * Three things the SDK path guarantees, each pinned by a test on the settings
 * this file builds rather than trusted from a doc:
 *
 *   * **Isolation.** The subprocess runs with `CLAUDE_CONFIG_DIR` set to a
 *     worker-owned directory (`RELAY_AGENT_HOME`, default `~/.relay/agent-home`)
 *     and `settingSources: []`, so it reads no CLAUDE.md, no settings.json, no
 *     hooks and no MCP servers of the dispatcher's or of any fleet agent's.
 *   * **No built-in tools.** `tools: []` removes every one the SDK ships (Read,
 *     Bash, WebSearch, …); the only tools are Relay's own, exposed as one
 *     in-process MCP server and allowed by exact name. A run whose definition
 *     declares no tools makes zero tool calls; a run cannot read a file.
 *     Verified live 2026-09-09: asked to read `/etc/hostname`, the model
 *     answered `NO_FILE_ACCESS`, and the SDK's own tool list held only the MCP
 *     names.
 *   * **No prompt can block.** `permissionMode: "bypassPermissions"`, which the
 *     SDK requires an explicit acknowledgement for; there is nobody at a
 *     terminal to answer one, and every tool the model can reach is read-only
 *     by construction (research §4) or a Relay function this process owns.
 *
 * One credential leaves the process, still: the subprocess environment is built
 * here with the token and **without** `ANTHROPIC_API_KEY`, so a worker holding
 * both never hands the SDK a choice. The API-key path is unchanged — the
 * Messages API through `@ai-sdk/anthropic`, `x-api-key` — and is the fallback
 * when no token is set.
 *
 * The SDK resolves its own executable: a native binary shipped in the platform
 * package beside `@anthropic-ai/claude-agent-sdk`. Nothing here depends on a
 * `claude` on `PATH`, and the worker unit does not put one there — verified
 * with `PATH=/usr/bin:/bin`.
 */

/** Which credential a process is holding, without saying what it is. */
export type Credential = "subscription-token" | "api-key" | "none";

/**
 * Which credential this environment has, token first.
 *
 * Token first and not "both": the subscription is the billing path the decision
 * names, so when both are configured the key is simply never read. That is the
 * Sales360 rule restated — one credential, chosen here, so that no code further
 * down has to decide.
 */
export function credentialKind(
  source: Pick<ReturnType<typeof env>, "CLAUDE_CODE_OAUTH_TOKEN" | "ANTHROPIC_API_KEY"> = env(),
): Credential {
  if (source.CLAUDE_CODE_OAUTH_TOKEN !== undefined) return "subscription-token";
  if (source.ANTHROPIC_API_KEY !== undefined) return "api-key";
  return "none";
}

/** The transport each credential travels on. */
export function transportFor(kind: Credential): "agent-sdk" | "messages" | "none" {
  switch (kind) {
    case "subscription-token":
      return "agent-sdk";
    case "api-key":
      return "messages";
    case "none":
      return "none";
  }
}

/** Where the SDK subprocess keeps its config: `RELAY_AGENT_HOME`, or the default under `$HOME`. */
export function agentHome(source: Pick<ReturnType<typeof env>, "RELAY_AGENT_HOME"> = env()): string {
  return source.RELAY_AGENT_HOME ?? path.join(homedir(), ".relay", "agent-home");
}

/**
 * The subprocess environment, **without** the values.
 *
 * The bridge builds the subprocess environment from an allowlist of this
 * process's (`HOME`, `PATH`, `ANTHROPIC_*`, `CLAUDE_*`, …) and merges these over
 * it; a key set to `undefined` is removed. So the token goes in explicitly, the
 * config dir goes in explicitly, and the API key is removed explicitly — the
 * allowlist would otherwise pass `ANTHROPIC_API_KEY` through, and a subprocess
 * holding both credentials is the thing the one-credential rule exists to
 * prevent.
 */
export function subprocessEnv(configDir: string, token: string): Record<string, string | undefined> {
  return {
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_OAUTH_TOKEN: token,
    ANTHROPIC_API_KEY: undefined,
  };
}

export type AgentSdkSettingsInput = {
  configDir: string;
  token: string;
  run: AgentSdkRunOptions;
};

/**
 * The bridge settings for one run. Pure, so a test can pin every field.
 *
 * `maxTurns` is the model-step budget: on this transport the loop is the SDK's,
 * so `stopWhen` in `runAgent` never fires and the SDK's own cap is the cap.
 * Reaching it ends the query with `error_max_turns`, which the observer sees
 * before the bridge throws, and `runAgent` reports as `cap`.
 */
export function agentSdkSettings({ configDir, token, run }: AgentSdkSettingsInput): ClaudeCodeSettings {
  const server = relayToolServer(run.tools);
  return {
    env: subprocessEnv(configDir, token),
    settingSources: [],
    tools: [],
    mcpServers: server.mcpServers,
    allowedTools: server.allowedTools,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    maxTurns: run.maxTurns,
    // The run is the record; the SDK's transcript would be a second copy of
    // every fetched page under a directory nothing reads.
    persistSession: false,
    logger: false,
    onSdkMessage: async (message) => {
      if (message.type === "assistant") {
        const turn: AgentSdkTurn = {
          messageId: message.message.id,
          model: message.message.model,
          stopReason: message.message.stop_reason ?? null,
          blocks: message.message.content.map((block) =>
            block.type === "tool_use" ? `tool_use:${block.name}` : block.type,
          ),
          usage: message.message.usage as unknown as AgentSdkTurn["usage"],
        };
        await run.observe.onTurn(turn);
      } else if (message.type === "result") {
        const result: AgentSdkResult = {
          subtype: message.subtype,
          numTurns: message.num_turns,
          totalCostUsd: message.total_cost_usd,
          modelUsage: message.modelUsage,
          ...(message.subtype === "success" ? {} : { errors: message.errors }),
        };
        await run.observe.onResult(result);
      }
    },
  };
}

/**
 * A model handle for a pinned model id.
 *
 * Throws when the environment holds no credential, rather than returning a
 * model that fails on first use: a worker with no way to call the API should say
 * so at the job's first step, naming the two variables, not at whatever point
 * the provider happens to notice.
 */
export type MakeModelOptions = {
  /**
   * The `fetch` the Messages API provider should use.
   *
   * A first-class provider option, not a test hook bolted on: it is how a caller
   * proxies, instruments or records a request. The test suite uses it to assert
   * the **actual** headers a request carries. The Agent SDK path has no fetch:
   * the subprocess makes its own requests.
   */
  fetch?: typeof globalThis.fetch;
};

export function makeModel(
  id: PricedModel,
  source: ReturnType<typeof env> = env(),
  options: MakeModelOptions = {},
): RunModel {
  if (!isPricedModel(id)) {
    // Unreachable through the type, reachable through an `as` or a JS caller.
    // Refused here as well as in `pricing.cost` so that an unpriced model can
    // never spend anything at all — a run that cannot be costed is a run §24
    // says must not happen.
    throw new Error(`provider: ${JSON.stringify(id)} is not a pinned Relay model`);
  }

  // The scripted model, before any credential is considered. It can only be set
  // in a development or test environment — `env()` refuses to parse it anywhere
  // else — so this branch is unreachable in production rather than merely
  // unlikely.
  if (source.RELAY_AGENT_STUB_MODEL !== undefined) {
    const script = parseStubScript(source.RELAY_AGENT_STUB_MODEL);
    return { transport: "stub", model: stubModel({ ...script, modelId: id }) };
  }

  const kind = credentialKind(source);
  if (kind === "subscription-token") {
    const token = source.CLAUDE_CODE_OAUTH_TOKEN as string;
    const configDir = agentHome(source);
    return {
      transport: "agent-sdk",
      forRun(run): LanguageModel {
        // Created here rather than at boot: the directory is the worker's, and a
        // worker that cannot create it should fail at the first run, naming it.
        mkdirSync(configDir, { recursive: true });
        return createClaudeCode({ defaultSettings: agentSdkSettings({ configDir, token, run }) })(id);
      },
    };
  }
  if (kind === "api-key") {
    return {
      transport: "messages",
      model: createAnthropic({
        apiKey: source.ANTHROPIC_API_KEY,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      })(id),
    };
  }
  throw new Error(
    "provider: no model credential configured — set CLAUDE_CODE_OAUTH_TOKEN (the subscription token, preferred) or ANTHROPIC_API_KEY",
  );
}
