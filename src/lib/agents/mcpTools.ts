import type { ToolSet } from "ai";

import { createAiSdkMcpServer, type McpSdkServerConfigWithInstance } from "@relay/claude-code-bridge";

/**
 * Relay's tools, as the Agent SDK sees them.
 *
 * On the subscription transport the loop runs inside the Claude Agent SDK, and
 * the SDK does not execute AI SDK tools: a tool reaches the model only as an
 * MCP server. The bridge provides an **in-process** one — `createAiSdkMcpServer`
 * — whose handlers are the tools' own `execute` functions, called in this
 * process, on this event loop, with this database connection. So a tool built
 * through `withReplay` in `agents/<kind>/tools.ts` is unchanged: the step row,
 * the replay key and the stored failure are exactly what they are on the
 * Messages API. The only thing that moves is the transport between the model
 * and the call.
 *
 * Two rules here, both from the 6c brief. The server's tools are **exactly**
 * the run's tool set — `runAgent` has already checked that set against the
 * signed definition — and they are the **only** tools the subprocess may use:
 * `allowedTools` names them one by one under the MCP prefix, and
 * `provider.agentSdkSettings` disables every built-in. A tool the definition
 * did not declare cannot be reached by the model, because it is not on the
 * server, and a built-in cannot be reached because there are none.
 */

/** The MCP server name. Fixed, because the tool names the model sees carry it. */
export const RELAY_MCP_SERVER = "relay";

/** The name the model calls a Relay tool by: the SDK's `mcp__<server>__<tool>`. */
export function mcpToolName(toolName: string): string {
  return `mcp__${RELAY_MCP_SERVER}__${toolName}`;
}

export type RelayToolServer = {
  mcpServers: Record<string, McpSdkServerConfigWithInstance>;
  /** Exactly the run's tools, prefixed, sorted. Nothing else is allowed. */
  allowedTools: string[];
};

/**
 * Wrap a run's tool set as the one MCP server the subprocess is allowed.
 *
 * The bridge accepts a zod 3 object schema as the tool's `inputSchema` — the
 * same schema `tool()` from `ai` took — and refuses a JSON-schema one, so the
 * tools stay on the repository's zod without conversion. The empty set is
 * allowed: an agent that declares no tools gets a server with no tools and an
 * empty allow list, which is a run that can make zero tool calls.
 */
export function relayToolServer(tools: ToolSet): RelayToolServer {
  const names = Object.keys(tools).sort();
  for (const name of names) {
    const tool = tools[name];
    if (typeof tool?.execute !== "function") {
      // The bridge would say the same, less specifically. Said here because a
      // tool with no `execute` is one the model could call and nothing would
      // answer — a definition bug, not a transport one.
      throw new Error(`relayToolServer: tool "${name}" has no execute function and cannot be bridged`);
    }
  }
  return {
    mcpServers: {
      [RELAY_MCP_SERVER]: createAiSdkMcpServer(
        RELAY_MCP_SERVER,
        // The bridge's structural tool type is narrower than `ToolSet` on the
        // schema field (a zod object, which every Relay tool declares). Checked
        // at server creation: a non-object schema throws there, at run start,
        // before any token is spent.
        tools as Parameters<typeof createAiSdkMcpServer>[1],
      ),
    },
    allowedTools: names.map(mcpToolName),
  };
}
