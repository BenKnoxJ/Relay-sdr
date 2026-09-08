import type { Env } from "@/lib/env";

import type { LiveDeps, ZohoService } from "../types";
import { LiveZohoService } from "./live";
import { MockZohoService } from "./mock";

export { LiveZohoService } from "./live";
export { MockZohoService } from "./mock";
export type { ZohoMockCall } from "./mock";

export function createZohoService(env: Env, deps: LiveDeps = {}): ZohoService {
  return env.INTEGRATIONS === "mock" ? new MockZohoService() : new LiveZohoService(env, deps);
}
