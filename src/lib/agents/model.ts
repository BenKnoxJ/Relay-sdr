import type { LanguageModel, ToolSet } from "ai";

/**
 * What `provider.makeModel` hands `runAgent`: a model, and how it is reached.
 *
 * Two transports reach Anthropic and they do not behave alike. On the
 * **Messages API** (`@ai-sdk/anthropic`, the API-key path) the AI SDK owns the
 * loop: every model call is one `generateText` step, every tool runs in this
 * process, and `onLanguageModelCallEnd` fires once per call. On the **Claude
 * Agent SDK** (the subscription path, decision of 2026-09-09) the loop runs
 * inside the SDK's subprocess: the AI SDK sees one call for the whole run,
 * tools reach the model as an in-process MCP server, and the per-turn usage
 * arrives on the SDK's own message stream. A ledger that records one row per
 * model call has to know which of the two it is looking at, so the transport
 * is part of the handle rather than something inferred from the model id.
 *
 * A bare `LanguageModel` is accepted where a handle is, and read as the
 * in-process shape: that is what the scripted model in the tests is, and the
 * stub seam is not touched by any of this.
 */
export type ModelTransport = "messages" | "agent-sdk" | "stub";

/** One assistant turn as the Agent SDK reports it: the Messages API's own usage block, per message. */
export type AgentSdkTurn = {
  messageId: string;
  /** The model the response names — checked against the pinned id, never trusted over it. */
  model: string;
  stopReason: string | null;
  /** The content block types, `tool_use:<name>` for a tool call. For the record, not for logic. */
  blocks: string[];
  usage: AnthropicUsage;
};

/** The Messages API usage block, in the API's own field names. */
export type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
  output_tokens_details?: { thinking_tokens?: number };
  [key: string]: unknown;
};

/** The SDK's per-model totals for one `query()`, the field it says to account from. */
export type AgentSdkModelUsage = {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens?: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
  /** The id the SDK priced under; the record's key may be a dated alias. */
  canonicalModel?: string;
};

/** The SDK's closing message for a run. */
export type AgentSdkResult = {
  subtype: string;
  numTurns: number;
  totalCostUsd: number;
  modelUsage: Record<string, AgentSdkModelUsage>;
  errors?: string[];
};

/** What `runAgent` watches on the Agent SDK transport. Both are awaited, in order. */
export type AgentSdkObserver = {
  onTurn(turn: AgentSdkTurn): Promise<void>;
  onResult(result: AgentSdkResult): Promise<void>;
};

export type AgentSdkRunOptions = {
  /** The run's tool set, already built through `withReplay`; exposed to the model as MCP tools. */
  tools: ToolSet;
  /** The definition's model-step budget. The SDK's `maxTurns` is the cap on this transport. */
  maxTurns: number;
  /** The definition's effort level, when it names one. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  observe: AgentSdkObserver;
};

export type RunModel =
  | { transport: "messages" | "stub"; model: LanguageModel }
  | {
      transport: "agent-sdk";
      /** Built per run, because the tools and the observer are the run's own. */
      forRun(options: AgentSdkRunOptions): LanguageModel;
    };

/** Read a bare `LanguageModel` as the in-process shape. */
export function asRunModel(model: LanguageModel | RunModel): RunModel {
  if (typeof model === "object" && model !== null && "transport" in model) return model;
  return { transport: "messages", model };
}
