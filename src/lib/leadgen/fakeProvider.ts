import {
  ProviderBusyError,
  ProviderNotSentError,
  ProviderUnknownOutcomeError,
  type LeadGenProvider,
  type ProviderCandidate,
  type ProviderSearchPage,
  type ProviderSearchRequest,
  type RevealAnswer,
  type RevealProvider,
  type RevealRequest,
  type RevealedContact,
} from "./provider";

/**
 * A scripted provider for tests and the mock mode. It has no network code at
 * all: every answer is one of the steps it was built with, in order, and a
 * call past the last step throws rather than inventing one.
 */

export type FakeRevealStep = { contacts: Record<string, RevealedContact>; charged: number } | { error: "busy" | "timeout" | "not_sent" | "fail" };

/** A scripted reveal provider: each call takes the next step, and a call past the last throws. */
export class FakeRevealProvider implements RevealProvider {
  readonly provider = "lusha" as const;
  readonly calls: RevealRequest[] = [];

  constructor(
    private readonly steps: readonly FakeRevealStep[],
    readonly maxIds = 100,
  ) {}

  async revealEmails(request: RevealRequest): Promise<RevealAnswer> {
    this.calls.push(structuredClone(request));
    const step = this.steps[this.calls.length - 1];
    if (step === undefined) throw new Error(`FakeRevealProvider: no scripted answer for call ${this.calls.length} (${request.key})`);
    if ("error" in step) {
      if (step.error === "busy") throw new ProviderBusyError();
      if (step.error === "timeout") throw new ProviderUnknownOutcomeError();
      if (step.error === "not_sent") throw new ProviderNotSentError();
      throw new Error("FakeRevealProvider: scripted failure");
    }
    // Only what was asked about comes back, as a provider would answer.
    const asked = new Set(request.providerIds);
    return { contacts: new Map(Object.entries(structuredClone(step.contacts)).filter(([id]) => asked.has(id))), charged: step.charged };
  }
}

export type FakeStep =
  | { candidates: ProviderCandidate[]; charged: number; hasMore: boolean }
  | { error: "busy" | "timeout" | "not_sent" | "fail" };

export class FakeLeadGenProvider implements LeadGenProvider {
  readonly provider = "lusha" as const;
  /** Every attempted call, in order, as it was asked. */
  readonly calls: ProviderSearchRequest[] = [];

  constructor(private readonly steps: readonly FakeStep[]) {}

  async search(request: ProviderSearchRequest): Promise<ProviderSearchPage> {
    this.calls.push(structuredClone(request));
    const step = this.steps[this.calls.length - 1];
    if (step === undefined) {
      throw new Error(`FakeLeadGenProvider: no scripted answer for call ${this.calls.length} (${request.key})`);
    }
    if ("error" in step) {
      if (step.error === "busy") throw new ProviderBusyError();
      if (step.error === "timeout") throw new ProviderUnknownOutcomeError();
      if (step.error === "not_sent") throw new ProviderNotSentError();
      throw new Error("FakeLeadGenProvider: scripted failure");
    }
    return { candidates: structuredClone(step.candidates), charged: step.charged, hasMore: step.hasMore };
  }
}
