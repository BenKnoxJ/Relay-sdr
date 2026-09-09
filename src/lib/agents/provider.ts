import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";

import { env } from "@/lib/env";
import { isPricedModel, type PricedModel } from "@/lib/agents/pricing";
import { parseStubScript, stubModel } from "@/lib/agents/stubModel";

/**
 * The one place a credential becomes a model handle.
 *
 * **Relay's agents bill to the Claude subscription, not an API key** (decision,
 * Benny-san, 2026-09-08). The fleet precedent is Sales360's runner, which
 * passes a `CLAUDE_CODE_OAUTH_TOKEN` — the long-lived token `claude
 * setup-token` prints — and passes exactly one credential at a time. Relay
 * cannot reuse the rest of that shape, because §24 forbids `claude -p` in the
 * worker: the token has to reach the Messages API through the AI SDK's own
 * provider.
 *
 * On the wire that means `Authorization: Bearer <token>` plus the beta header
 * `oauth-2025-04-20`, and **no** `x-api-key` — an OAuth token in the API key
 * header is rejected. `@ai-sdk/anthropic` has a first-class option for exactly
 * this: `authToken` sends the bearer header and, unlike `apiKey`, does not set
 * `x-api-key` at all, and the provider itself throws when both are given. So
 * the "exactly one credential leaves the process" rule is the library's
 * invariant here rather than ours to re-implement, and there is no `fetch`
 * wrapper stripping a header the provider should never have set.
 *
 * **The live half is unverified.** Nothing in this repository has yet made a
 * successful Messages API call with a subscription token on the SDK transport —
 * the brief's R8 phase 0 asks for that probe, and this dispatch had no token to
 * probe with (see the handoff). The header shape below is what the API
 * documents and what the tests pin; whether Anthropic accepts it for a product
 * worker is decision D2, and `scripts/spike/cost-check.ts` is the script that
 * answers it the moment a token exists.
 */

/** The beta the Messages API requires for a subscription OAuth token. */
export const OAUTH_BETA = "oauth-2025-04-20";

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
export function credentialKind(source: Pick<ReturnType<typeof env>, "CLAUDE_CODE_OAUTH_TOKEN" | "ANTHROPIC_API_KEY"> = env()): Credential {
  if (source.CLAUDE_CODE_OAUTH_TOKEN !== undefined) return "subscription-token";
  if (source.ANTHROPIC_API_KEY !== undefined) return "api-key";
  return "none";
}

/**
 * The headers a request will carry, **without** either credential's value.
 *
 * Exported so the test suite can pin the shape — which header name carries
 * which credential, and that the beta rides along with the token — without a
 * test ever needing a real one. Nothing here is logged: the names are safe, the
 * values never appear.
 */
export function headerShape(kind: Credential): { auth: string; beta: string[] } {
  switch (kind) {
    case "subscription-token":
      return { auth: "authorization", beta: [OAUTH_BETA] };
    case "api-key":
      return { auth: "x-api-key", beta: [] };
    case "none":
      return { auth: "none", beta: [] };
  }
}

/**
 * A language model handle for a pinned model id.
 *
 * Throws when the environment holds no credential, rather than returning a
 * model that fails on first use: a worker with no way to call the API should say
 * so at the job's first step, naming the two variables, not at whatever point
 * the provider happens to notice.
 */
export type MakeModelOptions = {
  /**
   * The `fetch` the provider should use.
   *
   * A first-class provider option, not a test hook bolted on: it is how a caller
   * proxies, instruments or records a request. The test suite uses it to assert
   * the **actual** headers a request carries, because the one-credential rule is
   * a property of the wire and a test of a helper function that production does
   * not call would keep passing if `makeModel` started putting the OAuth token
   * on `x-api-key`.
   */
  fetch?: typeof globalThis.fetch;
};

export function makeModel(
  id: PricedModel,
  source: ReturnType<typeof env> = env(),
  options: MakeModelOptions = {},
): LanguageModel {
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
    return stubModel({ ...script, modelId: id });
  }

  const kind = credentialKind(source);
  if (kind === "subscription-token") {
    return createAnthropic({
      authToken: source.CLAUDE_CODE_OAUTH_TOKEN,
      headers: { "anthropic-beta": OAUTH_BETA },
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    })(id);
  }
  if (kind === "api-key") {
    return createAnthropic({
      apiKey: source.ANTHROPIC_API_KEY,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    })(id);
  }
  throw new Error(
    "provider: no model credential configured — set CLAUDE_CODE_OAUTH_TOKEN (the subscription token, preferred) or ANTHROPIC_API_KEY",
  );
}
