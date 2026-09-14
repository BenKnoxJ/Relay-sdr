import type { LeadGenHandoffV1 } from "../../../agents/leadgen/input.schema";
import { env } from "@/lib/env";

import type { LeadGenProvider, ProviderVocabulary } from "./provider";
import { SAMPLE_BALANCE_REMAINING, SAMPLE_SEARCH_CAP, sampleProvider, sampleVocabulary } from "./sample";
import { DOCUMENTED_UNVERIFIED_PRICING } from "./spend";

/**
 * How finding people is set up in this environment, or null when it is not.
 *
 * There is no live provider yet, so the only setup is the sample one
 * (development and test). Anywhere else this is null: Confirm plan is drawn
 * but cannot be pressed, and a lead gen job fails and says so. Nothing ever
 * falls back to sample people.
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
  /** The balance Confirm freezes, read server-side at Confirm. */
  readBalance(orgId: string): Promise<AccountBalance>;
  /** The provider and vocabulary a run uses. */
  environment(handoff: LeadGenHandoffV1): LeadGenEnvironment;
};

export function leadGenSetup(): LeadGenSetup | null {
  const e = env();
  if (e.RELAY_LEADGEN_PROVIDER !== "sample") return null;
  return {
    sample: true,
    searchCreditCap: e.RELAY_LEADGEN_SEARCH_CAP ?? SAMPLE_SEARCH_CAP,
    pricingAssumptions: DOCUMENTED_UNVERIFIED_PRICING.id,
    readBalance: async () => ({ remaining: SAMPLE_BALANCE_REMAINING, readAt: new Date(), source: "sample" }),
    environment: (handoff) => ({ provider: sampleProvider(handoff), vocabulary: sampleVocabulary(handoff) }),
  };
}
