import type { Env } from "@/lib/env";

import { LushaClient } from "./client";
import { LUSHA_FIXTURES, recordedLushaFetch } from "./mock";

export * from "./client";
export { LUSHA_FIXTURES, locationFixtureName, recordedLushaFetch } from "./mock";

/**
 * The Lusha client for this process: recorded answers under
 * `INTEGRATIONS=mock`, the live API with `LUSHA_API_KEY` otherwise. The
 * environment refuses the live mode without a key, so reaching here without
 * one is a fault, not a configuration.
 */
export function createLushaClient(env: Pick<Env, "INTEGRATIONS" | "LUSHA_API_KEY">): LushaClient {
  if (env.INTEGRATIONS === "mock") return new LushaClient("recorded", { fetchImpl: recordedLushaFetch(), cacheKey: `recorded:${LUSHA_FIXTURES}` });
  if (env.LUSHA_API_KEY === undefined) throw new Error("lusha: LUSHA_API_KEY is not set");
  return new LushaClient(env.LUSHA_API_KEY);
}
