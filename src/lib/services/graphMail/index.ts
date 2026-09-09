import type { Env } from "@/lib/env";

import type { GraphMailService } from "../types";
import { LiveGraphMailService, type GraphMailDeps } from "./live";
import { MockGraphMailService } from "./mock";

export { LiveGraphMailService } from "./live";
export type { GraphMailDeps } from "./live";
export { MockGraphMailService } from "./mock";
export type { GraphMockCall } from "./mock";
export {
  authorizeUrl,
  authorizeGraphUrl,
  exchangeCode,
  exchangeGraphCode,
  BASE_SCOPES,
  SEND_SCOPE,
  MOCK_EXCHANGE_TOKENS,
} from "./auth";
export type { AuthEnv, AuthorizeInput, ExchangedTokens, ExchangeDeps } from "./auth";

export function createGraphMailService(env: Env, deps: GraphMailDeps = {}): GraphMailService {
  return env.INTEGRATIONS === "mock" ? new MockGraphMailService() : new LiveGraphMailService(env, deps);
}
