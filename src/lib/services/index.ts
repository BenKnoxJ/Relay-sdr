import { env } from "@/lib/env";

import { createGraphMailService, type GraphMailDeps } from "./graphMail";
import { createZohoService } from "./zoho";
import type { GraphMailService, ZohoService } from "./types";

export * from "./types";
export { encryptToken, decryptToken } from "./crypto";
export { createGraphMailService } from "./graphMail";
export { createZohoService } from "./zoho";
// The research tools' providers are built per run by `agents/research/tools.ts`
// — the one place a Tavily or Firecrawl client is constructed — and are not
// part of the memoised process-wide set below.
export { createTavilyService, COUNTRY_NAMES, countryName, timeRange, type ResearchServiceMode } from "./tavily";
export { createFirecrawlService } from "./firecrawl";
export { searchDiscriminator, fetchDiscriminator } from "./research/discriminator";
export { readRecording, writeRecording, recordingPath } from "./research/recordings";

/**
 * What the caller wants to happen when a token is refreshed or refused.
 *
 * Both are optional and both default to doing nothing, because this module is
 * on the wrong side of the write path: persisting a rotated refresh token is a
 * state change and belongs in `src/lib/repo` behind `mutate`. Task 10b supplies
 * the pair that writes to `ConnectedAccount`; until then the live Graph client
 * refreshes in memory and the new token lives as long as the process does.
 *
 * **Neither hook may throw.** They run inside a request that has already
 * succeeded — a failed bookkeeping write must not turn a delivered mail into an
 * error. `services()` wraps whatever it is given to make that true regardless of
 * what 10b passes.
 */
export type ServicesDeps = {
  /** The rotated token blob, for the caller to persist against `account`. */
  onTokenRefresh?: GraphMailDeps["onTokenRefresh"];
  /** The refusal (400/401 means the refresh token is spent or revoked). */
  onRefreshFailed?: GraphMailDeps["onRefreshFailed"];
};

export type Services = {
  graphMail: GraphMailService;
  zoho: ZohoService;
};

/**
 * The default deps: no hooks at all.
 *
 * A module constant rather than a fresh `{}` per call, because `services()`
 * memoises on the deps object's identity and a new literal each time would
 * rebuild the adapter set — and with it the live Graph client's token cache —
 * on every call.
 */
export const defaultServicesDeps: ServicesDeps = {};

let cached: Services | undefined;
let cachedDeps: ServicesDeps | undefined;

/**
 * The process-wide adapter set: mocks under `INTEGRATIONS=mock`, live otherwise.
 *
 * One set for the process, which is right while Relay is one org: the Zoho
 * credentials are org-level and the Graph token cache is keyed per account
 * anyway. A second tenant makes this a per-org instance keyed on the org id —
 * an H2 change, and this function is where it lands.
 * Memoised per `deps` identity — pass the same object (or none) to reuse the set;
 * a different object rebuilds it, so hold the deps in a module constant rather
 * than building a fresh literal per call.
 */
export function services(deps: ServicesDeps = defaultServicesDeps): Services {
  if (cached && cachedDeps === deps) return cached;
  const e = env();
  cached = {
    graphMail: createGraphMailService(e, guardHooks(deps)),
    zoho: createZohoService(e),
  };
  cachedDeps = deps;
  return cached;
}

/** Test-only: drop the memoised set so a later call re-reads the environment. */
export function resetServices(): void {
  cached = undefined;
  cachedDeps = undefined;
}

/**
 * Wrap a caller's hooks so neither can throw at the adapter.
 *
 * This is what makes the "neither hook may throw" contract true rather than
 * merely documented, and it is applied to whatever `services()` is handed, so
 * the guarantee does not depend on Task 10b remembering it. Exported because
 * anything building a live client directly — the connect flow, a smoke probe —
 * needs the same guarantee, and because a rule this load-bearing should be
 * testable without reaching inside a constructed client.
 */
export function guardHooks(deps: ServicesDeps): ServicesDeps {
  return {
    onTokenRefresh: neverThrows(deps.onTokenRefresh),
    onRefreshFailed: neverThrows(deps.onRefreshFailed),
  };
}

/**
 * Swallow whatever a hook does wrong, synchronous throw and rejected promise
 * alike.
 *
 * Silently, and not logged: `src/lib/services` has no logger, and the failure a
 * caller actually needs to see — a mailbox that can no longer refresh — is the
 * `ServiceError` the adapter throws anyway. What must not happen is a delivered
 * mail reported as an error, because the retry sends it twice.
 */
function neverThrows<A extends unknown[]>(
  hook: ((...args: A) => void | Promise<void>) | undefined,
): ((...args: A) => Promise<void>) | undefined {
  if (!hook) return undefined;
  return async (...args: A) => {
    try {
      await hook(...args);
    } catch {
      // Deliberately ignored — see above.
    }
  };
}
