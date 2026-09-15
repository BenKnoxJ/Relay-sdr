import type { SpendSummary } from "../../../agents/leadgen/output.schema";

/**
 * Search spend, leadgen v2.1 §6.
 *
 * Before every search request (retries included):
 *
 *     documentedWorstCaseCharge(request) <= remainingSearchCap
 *
 * where the remaining cap counts reconciled charges at what the provider
 * reported and every open or unreconciled reservation at its documented worst
 * case. The same bound holds against the balance read at Confirm.
 *
 * What this proves is conditional, and says so: spend stays within the cap
 * **provided the provider never charges a request more than its documented
 * worst case**. A reported charge above it is recorded as it is, and flagged.
 */

/** A pricing model for search. Configuration, never a hard-coded fact. */
export type SearchPricing = {
  id: string;
  /** Credits per result returned, when the model charges per result. */
  perResult: number | null;
  /** Credits per block of results, when the model charges by block. */
  perBlock: { size: number; credits: number } | null;
  /** Credits a request costs even when it returns nothing. */
  minimumPerRequest: number;
  /** Credits to reveal one email, when a candidate does not say. */
  revealPerEmail: number;
};

/**
 * The public docs as of 2026-09-14, **unverified**: one page says 1 credit
 * per result, another 1 per block of up to 25 with a minimum of 1 per request,
 * and an email reveal is 1. Taking the maximum across both is what makes the
 * bound hold whichever is true. It is replaced once billing is verified.
 */
export const DOCUMENTED_UNVERIFIED_PRICING: SearchPricing = {
  id: "lusha-public-docs-2026-09-14-unverified",
  perResult: 1,
  perBlock: { size: 25, credits: 1 },
  minimumPerRequest: 1,
  revealPerEmail: 1,
};

/**
 * Lusha V3 on this account, as the zero-spend check read it on 2026-09-14.
 * `GET /v3/account/usage` prices `contactSearch` at 1 credit per 25 results,
 * and a search an earlier client recorded was charged 1 for 24 results. The
 * public docs say "charged per result". The two disagree, so the worst case
 * stays the larger of them (1 per result, minimum 1 a request) until the first
 * paid search settles it; the id says the conflict is unsettled. The same
 * numbers as the documented model: only what they rest on has changed.
 */
export const LUSHA_V3_PRICING: SearchPricing = {
  id: "lusha-v3-2026-09-14-account-per-25-docs-per-result-unsettled",
  perResult: 1,
  perBlock: { size: 25, credits: 1 },
  minimumPerRequest: 1,
  revealPerEmail: 1,
};

/** A frozen pricing id back to its model; null for an id this build does not know. */
export function pricingById(id: string): SearchPricing | null {
  return [DOCUMENTED_UNVERIFIED_PRICING, LUSHA_V3_PRICING].find((pricing) => pricing.id === id) ?? null;
}

/** The most any documented model could charge for one request of `pageSize` results. */
export function documentedWorstCaseCharge(pageSize: number, pricing: SearchPricing): number {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error("documentedWorstCaseCharge: pageSize is a positive whole number");
  const worst = Math.max(
    pricing.minimumPerRequest,
    pricing.perResult === null ? 0 : pageSize * pricing.perResult,
    pricing.perBlock === null ? 0 : Math.ceil(pageSize / pricing.perBlock.size) * pricing.perBlock.credits,
  );
  // A request that could cost nothing would let the search loop run without
  // bound; every request must use up some of the cap.
  if (!(worst >= 1)) throw new Error(`documentedWorstCaseCharge: pricing ${pricing.id} allows a free request`);
  return worst;
}

/**
 * Where a run's spend is kept. In memory for the provider-free core and its
 * tests; persisted, under a lock on the org, for a real job
 * (`src/lib/repo/leadgen.ts`). `tryReserve` decides and records in one step,
 * so a check and a reservation can never be split by another run.
 */
export type SpendPort = {
  canReserve(worstCase: number): Promise<boolean>;
  /** Reserve if the invariant allows it; false (and nothing written) when it does not. */
  tryReserve(key: string, worstCase: number): Promise<boolean>;
  reconcile(key: string, charged: number): Promise<void>;
  markUnknown(key: string): Promise<void>;
  /** The request provably never left Relay: nothing can have been charged, so the reservation counts for nothing. */
  release(key: string): Promise<void>;
  summary(): Promise<SpendSummary>;
  list(): Promise<readonly SpendEntry[]>;
};

/** A `SearchSpend` as a `SpendPort`: one run, in memory. */
export function inMemorySpend(spend: SearchSpend): SpendPort {
  return {
    canReserve: async (worstCase) => spend.canReserve(worstCase),
    tryReserve: async (key, worstCase) => {
      if (!spend.canReserve(worstCase)) return false;
      spend.reserve(key, worstCase);
      return true;
    },
    reconcile: async (key, charged) => spend.reconcile(key, charged),
    markUnknown: async (key) => spend.markUnknown(key),
    release: async (key) => spend.release(key),
    summary: async () => spend.summary(),
    list: async () => spend.list(),
  };
}

export type SpendEntry = {
  key: string;
  worstCase: number;
  /** `released`: the request never left Relay, so it counts for nothing (v2.2 note 2). */
  state: "reserved" | "reconciled" | "unreconciled" | "released";
  charged: number | null;
};

export class SpendRefused extends Error {
  constructor(
    readonly key: string,
    readonly worstCase: number,
    readonly remaining: number,
  ) {
    super(`${key}: worst case ${worstCase} exceeds the remaining ${remaining}`);
    this.name = "SpendRefused";
  }
}

/** What one ledger entry counts against the cap: its charge, nothing when released, else its worst case. */
export function held(entry: Pick<SpendEntry, "state" | "charged" | "worstCase">): number {
  if (entry.state === "reconciled") return entry.charged ?? 0;
  if (entry.state === "released") return 0;
  return entry.worstCase;
}

/** The search ledger for one confirmed run. Pure: nothing here calls anything. */
export class SearchSpend {
  private readonly entries: SpendEntry[] = [];
  private exceeded = false;

  constructor(
    readonly cap: number,
    readonly balance: number,
    readonly pricing: SearchPricing,
  ) {}

  /** What counts against the cap: reconciled at their charge, released at nothing, everything else at its worst case. */
  committed(): number {
    return this.entries.reduce((total, entry) => total + held(entry), 0);
  }

  remaining(): number {
    return Math.min(this.cap, this.balance) - this.committed();
  }

  canReserve(worstCase: number): boolean {
    return worstCase <= this.remaining();
  }

  /** Reserve a request's worst case before it runs. Refuses rather than overspend. */
  reserve(key: string, worstCase: number): void {
    if (this.entries.some((entry) => entry.key === key)) throw new Error(`${key}: already reserved`);
    const remaining = this.remaining();
    if (worstCase > remaining) throw new SpendRefused(key, worstCase, remaining);
    this.entries.push({ key, worstCase, state: "reserved", charged: null });
  }

  /** The provider answered: the reservation becomes what it reported. */
  reconcile(key: string, charged: number): void {
    const entry = this.open(key);
    if (!Number.isInteger(charged) || charged < 0) throw new Error(`${key}: a charge is a whole number of credits`);
    entry.state = "reconciled";
    entry.charged = charged;
    if (charged > entry.worstCase) this.exceeded = true;
  }

  /** The outcome is unknown: the reservation stays at its worst case until usage is reconciled. */
  markUnknown(key: string): void {
    this.open(key).state = "unreconciled";
  }

  /** The request provably never left Relay: the reservation is released and counts for nothing. */
  release(key: string): void {
    this.open(key).state = "released";
  }

  list(): readonly SpendEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  summary(): SpendSummary {
    return {
      searchCreditCap: this.cap,
      charged: this.entries.reduce((total, entry) => total + (entry.state === "reconciled" ? (entry.charged ?? 0) : 0), 0),
      // Only what may still be charged: never a request that never left Relay.
      reserved: this.entries.reduce((total, entry) => total + (entry.state === "reserved" || entry.state === "unreconciled" ? entry.worstCase : 0), 0),
      pricingAssumptions: this.pricing.id,
      exceededDocumentedWorstCase: this.exceeded,
    };
  }

  private open(key: string): SpendEntry {
    const entry = this.entries.find((candidate) => candidate.key === key);
    if (entry === undefined || entry.state !== "reserved") throw new Error(`${key}: no open reservation`);
    return entry;
  }
}
