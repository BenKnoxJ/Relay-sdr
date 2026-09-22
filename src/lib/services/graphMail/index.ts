import type { Env } from "@/lib/env";

import type { GraphMailService } from "../types";
import { LiveGraphMailService, type GraphMailDeps } from "./live";
import { MockGraphMailService, emptyMockMailbox, type MockMailbox } from "./mock";

export { LiveGraphMailService } from "./live";
export type { GraphMailDeps } from "./live";
export { MockGraphMailService, MOCK_REPLIER, emptyMockMailbox } from "./mock";
export type { GraphMockCall, MockMailbox } from "./mock";
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

/**
 * One mock mailbox per process, held on `globalThis`: Next can load this
 * module more than once in a development server (route handlers, server
 * actions and pages are bundled apart), and an Email 2 must find the Email 1
 * an earlier request sent, as it would in a real mailbox.
 */
const shared = globalThis as typeof globalThis & { __relayMockMailbox?: MockMailbox };

export function createGraphMailService(env: Env, deps: GraphMailDeps = {}): GraphMailService {
  if (env.INTEGRATIONS !== "mock") return new LiveGraphMailService(env, deps);
  shared.__relayMockMailbox ??= emptyMockMailbox();
  return new MockGraphMailService(shared.__relayMockMailbox);
}
