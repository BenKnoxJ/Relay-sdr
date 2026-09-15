import type { LeadGenHandoff } from "../../../agents/leadgen/input.schema";
import { env } from "@/lib/env";
import { createLushaClient } from "@/lib/services/lusha";

import { LushaRevealer, lushaBalance, lushaEnvironment } from "./lusha";
import type { LeadGenProvider, ProviderVocabulary, RevealProvider } from "./provider";
import { SAMPLE_BALANCE_REMAINING, SAMPLE_SEARCH_CAP, SampleRevealProvider, sampleProvider, sampleVocabulary } from "./sample";
import { DOCUMENTED_UNVERIFIED_PRICING, LUSHA_V3_PRICING, type SearchPricing } from "./spend";

/**
 * How finding people is set up in this environment, or null when it is not.
 *
 * - `lusha`: Lusha V3. Live with `LUSHA_API_KEY` under `INTEGRATIONS=live`;
 *   recorded answers under `INTEGRATIONS=mock`, which the environment accepts
 *   only in development and test. The search limit is configuration and
 *   required: there is no default until billing is settled.
 * - `sample`: made-up people and credits, development and test only.
 *
 * Anywhere else this is null: Confirm plan is drawn but cannot be pressed, and
 * a lead gen job fails and says so. Nothing ever falls back to sample people.
 */

/** A balance, and where it came from. `sample` is never presented as a live account. */
export type AccountBalance = { remaining: number; used?: number; total?: number; readAt: Date; source: "sample" | "live" };

export type LeadGenEnvironment = { provider: LeadGenProvider; vocabulary: ProviderVocabulary };

export type LeadGenSetup = {
  /** True when people and credits are samples. */
  sample: boolean;
  /** The search credit cap a Confirm approves (v2.1 §6). Configuration. */
  searchCreditCap: number;
  pricingAssumptions: string;
  /** The pricing model whose id is `pricingAssumptions`: Confirm freezes the id, the job uses the model. */
  pricing: SearchPricing;
  /** The balance Confirm freezes, read server-side at Confirm. Throws when it cannot be read. */
  readBalance(orgId: string): Promise<AccountBalance>;
  /** The provider and vocabulary a run uses. A live provider reads its metadata here. */
  environment(handoff: LeadGenHandoff): Promise<LeadGenEnvironment>;
  /** The provider Reveal emails uses: emails only. */
  revealer(): RevealProvider;
};

export function leadGenSetup(): LeadGenSetup | null {
  const e = env();
  if (e.RELAY_LEADGEN_PROVIDER === "lusha") {
    // The environment guarantees the cap, and the key where the mode is live.
    if (e.RELAY_LEADGEN_SEARCH_CAP === undefined) return null;
    const client = createLushaClient(e);
    return {
      sample: false,
      searchCreditCap: e.RELAY_LEADGEN_SEARCH_CAP,
      pricingAssumptions: LUSHA_V3_PRICING.id,
      pricing: LUSHA_V3_PRICING,
      readBalance: () => lushaBalance(client),
      environment: (handoff) => lushaEnvironment(client, handoff),
      revealer: () => new LushaRevealer(client),
    };
  }
  if (e.RELAY_LEADGEN_PROVIDER !== "sample") return null;
  return {
    sample: true,
    searchCreditCap: e.RELAY_LEADGEN_SEARCH_CAP ?? SAMPLE_SEARCH_CAP,
    pricingAssumptions: DOCUMENTED_UNVERIFIED_PRICING.id,
    pricing: DOCUMENTED_UNVERIFIED_PRICING,
    readBalance: async () => ({ remaining: SAMPLE_BALANCE_REMAINING, readAt: new Date(), source: "sample" }),
    environment: async (handoff) => ({ provider: sampleProvider(handoff), vocabulary: sampleVocabulary(handoff) }),
    revealer: () => new SampleRevealProvider(),
  };
}
