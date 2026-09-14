import { leadGenHandoffV1Schema, type LeadGenHandoffV1 } from "../../../agents/leadgen/input.schema";
import {
  HOLD_REASONS,
  haltSchema,
  leadgenOutputSchema,
  type Halt,
  type HoldReason,
  type Person,
  type Pick,
} from "../../../agents/leadgen/output.schema";

import { DEFAULT_EMAIL_POLICY, Knowledge, emailHold, preRevealChecks, type CrmCheck, type EmailPolicy, type OrgKnowledge } from "./holds";
import { domainKey, norm } from "./normalise";
import { ProviderBusyError, ProviderUnknownOutcomeError, type LeadGenProvider, type ProviderCandidate, type ProviderSearchPage, type ProviderVocabulary } from "./provider";
import { rankCandidates, type Eligible, type Scored } from "./rank";
import { DOCUMENTED_UNVERIFIED_PRICING, SearchSpend, documentedWorstCaseCharge, type SearchPricing, type SpendEntry } from "./spend";
import { INDUSTRY_ALIASES, locationNames, translate, type Translation } from "./translate";

/**
 * Finding people for one confirmed run: leadgen v2.1 §4 to §8, end to end,
 * provider-free. It takes the frozen handoff and everything else it needs as
 * arguments, calls only the provider it was handed, and persists nothing.
 *
 * The buyer group is the handoff's. Nothing here reads `sourceRank`, looks at
 * another group, or widens a term to reach the count: fewer than asked is
 * People found, X of N, and none is Needs you.
 */

export type FindPeopleDeps = {
  provider: LeadGenProvider;
  vocabulary: ProviderVocabulary;
  knowledge: OrgKnowledge;
  crm: CrmCheck;
  pricing?: SearchPricing;
  policy?: EmailPolicy;
  industryAliases?: Readonly<Record<string, string>>;
  industryChoices?: Readonly<Record<string, string>>;
  /** Busy or unknown-outcome retries: attempts per page, and the wait before each retry. */
  retry?: { attempts: number; wait: (attempt: number) => Promise<void> };
};

export type FindPeopleResult = {
  output: Pick | Halt;
  translation: Translation | null;
  ledger: readonly SpendEntry[];
  holds: { providerId: string; reason: HoldReason }[];
  stoppedBy: "enough" | "cap_reached" | "no_more_results" | "halt";
};

const BACKOFF_MS = [1_000, 5_000, 15_000];
const DEFAULT_RETRY = {
  attempts: 3,
  wait: (attempt: number) => new Promise<void>((resolve) => setTimeout(resolve, BACKOFF_MS[attempt - 1] ?? 15_000)),
};

export async function findPeople(input: unknown, deps: FindPeopleDeps): Promise<FindPeopleResult> {
  const handoff = leadGenHandoffV1Schema.parse(input);
  const pricing = deps.pricing ?? DOCUMENTED_UNVERIFIED_PRICING;
  const policy = deps.policy ?? DEFAULT_EMAIL_POLICY;
  const retry = deps.retry ?? DEFAULT_RETRY;
  const spend = new SearchSpend(handoff.spend.searchCreditCap, handoff.spend.balanceSnapshot.remaining, pricing);
  const holds: FindPeopleResult["holds"] = [];

  const halt = (fields: Omit<Halt, "phase" | "spend">, translation: Translation | null): FindPeopleResult => ({
    output: haltSchema.parse({ phase: "needs_you", ...fields, spend: spend.summary() }),
    translation,
    ledger: spend.list(),
    holds,
    stoppedBy: "halt",
  });

  const translated = translate(handoff, deps.vocabulary, {
    industryAliases: deps.industryAliases ?? INDUSTRY_ALIASES,
    ...(deps.industryChoices === undefined ? {} : { industryChoices: deps.industryChoices }),
  });
  if (!translated.ok) return halt(translated.halt, null);

  // One page size for the whole run (v2.1 §4), within the provider's limits and never above 50.
  const pageSize = Math.max(deps.vocabulary.pageSize.min, Math.min(handoff.howMany, deps.vocabulary.pageSize.max, 50));
  const worstCase = documentedWorstCaseCharge(pageSize, pricing);
  if (!spend.canReserve(worstCase)) return halt({ reason: "over_cap" }, translated);

  const knowledge = new Knowledge(deps.knowledge);
  const placeNames = new Set(handoff.targeting.locations.flatMap((term) => [...locationNames(term, handoff)]));
  for (const location of translated.effective.locations) placeNames.add(norm(location.value));
  const customerDomains = new Map<string, boolean>();
  const seen = new Set<string>();
  const eligible: Eligible[] = [];
  const rankOptions = { titles: handoff.targeting.titles, seedFirms: handoff.seedFirms, perCompanyMax: handoff.perCompanyMax, howMany: handoff.howMany };

  let stoppedBy: FindPeopleResult["stoppedBy"] = "no_more_results";
  for (let page = 0; ; page += 1) {
    let answer: ProviderSearchPage | null = null;
    for (let attempt = 1; answer === null; attempt += 1) {
      // The invariant, before every request, retries included.
      if (!spend.canReserve(worstCase)) break;
      const key = `campaign:${handoff.campaign.id}:lead_gen:v${handoff.campaign.briefVersion}:p${page}:a${attempt}`;
      spend.reserve(key, worstCase);
      try {
        answer = await deps.provider.search({ key, filters: translated.filters, page, pageSize });
        spend.reconcile(key, answer.charged);
      } catch (error) {
        // No billing answer came back, so the reservation stays at its worst case.
        spend.markUnknown(key);
        if (!(error instanceof ProviderBusyError || error instanceof ProviderUnknownOutcomeError)) throw error;
        if (attempt >= retry.attempts) return halt({ reason: error instanceof ProviderBusyError ? "provider_busy" : "took_too_long" }, translated);
        await retry.wait(attempt);
      }
    }
    if (answer === null) {
      stoppedBy = "cap_reached";
      break;
    }

    for (const candidate of answer.candidates) {
      if (seen.has(candidate.providerId)) continue;
      seen.add(candidate.providerId);
      const decision = await evaluate(candidate, handoff, knowledge, placeNames, customerDomains, deps.crm, policy);
      if (decision.kind === "held") holds.push({ providerId: candidate.providerId, reason: decision.reason });
      else eligible.push({ candidate, reusedPersonId: decision.reusedPersonId });
    }

    if (rankCandidates(eligible, rankOptions).chosen.length >= handoff.howMany) {
      stoppedBy = "enough";
      break;
    }
    if (!answer.hasMore) {
      stoppedBy = "no_more_results";
      break;
    }
  }

  const ranked = rankCandidates(eligible, rankOptions);
  holds.push(...ranked.held);
  if (ranked.chosen.length === 0) return halt({ reason: "no_candidates" }, translated);

  const chosen = ranked.chosen.map((entry) => toPerson(entry, entry.rank));
  const toBuy = ranked.chosen.filter((entry) => entry.reusedPersonId === null && entry.candidate.hasEmail && revealCost(entry, pricing) > 0);
  const pick: Pick = {
    phase: "pick",
    chosen,
    spare: ranked.spare.map((entry, index) => toPerson(entry, ranked.chosen.length + index + 1)),
    found: { n: chosen.length, ofM: handoff.howMany },
    ...(chosen.length < handoff.howMany ? { shortfall: stoppedBy === "cap_reached" ? ("cap_reached" as const) : ("no_more_results" as const) } : {}),
    spend: spend.summary(),
    revealEstimate: {
      toBuy: toBuy.length,
      reused: ranked.chosen.filter((entry) => entry.reusedPersonId !== null).length,
      credits: toBuy.reduce((total, entry) => total + revealCost(entry, pricing), 0),
    },
    holdsApplied: HOLD_REASONS.map((reason) => ({ reason, count: holds.filter((hold) => hold.reason === reason).length })).filter((hold) => hold.count > 0),
  };
  return { output: leadgenOutputSchema.parse(pick) as Pick, translation: translated, ledger: spend.list(), holds, stoppedBy };
}

type Decision = { kind: "held"; reason: HoldReason } | { kind: "eligible"; reusedPersonId: string | null };

async function evaluate(
  candidate: ProviderCandidate,
  handoff: LeadGenHandoffV1,
  knowledge: Knowledge,
  placeNames: ReadonlySet<string>,
  customerDomains: Map<string, boolean>,
  crm: CrmCheck,
  policy: EmailPolicy,
): Promise<Decision> {
  const pre = preRevealChecks(candidate, handoff, knowledge, placeNames);
  if (pre.kind === "held") return pre;

  // Customer company: one CRM read per domain per run, positive only.
  const domain = domainKey(candidate.domain);
  if (domain !== undefined) {
    if (!customerDomains.has(domain)) customerDomains.set(domain, await crm.isCustomerDomain(domain));
    if (customerDomains.get(domain) === true) return { kind: "held", reason: "customer" };
  }

  if (pre.reused === null) return { kind: "eligible", reusedPersonId: null };
  // Reused: this campaign's checks on the email Relay already owns, with no provider call.
  if (knowledge.isEnrolled(pre.reused.id)) return { kind: "held", reason: "duplicate_in_campaign" };
  const hold = await emailHold({ address: pre.reused.email, type: pre.reused.emailType, grade: pre.reused.grade }, knowledge, crm, policy);
  if (hold !== null) return { kind: "held", reason: hold.reason };
  return { kind: "eligible", reusedPersonId: pre.reused.id };
}

function revealCost(entry: Scored, pricing: SearchPricing): number {
  return entry.candidate.emailRevealCredits ?? pricing.revealPerEmail;
}

function toPerson(entry: Scored, rank: number): Person {
  const { candidate } = entry;
  const domain = domainKey(candidate.domain);
  return {
    id: candidate.providerId,
    lushaId: candidate.providerId,
    name: candidate.name,
    title: candidate.title,
    company: candidate.company,
    ...(domain === undefined ? {} : { domain }),
    // Eligible candidates are inside the recipe's countries (`inGeography`).
    country: candidate.countryIso2!,
    ...(candidate.city === undefined ? {} : { city: candidate.city }),
    ...(isWebUrl(candidate.linkedinUrl) ? { linkedinUrl: candidate.linkedinUrl } : {}),
    hasEmail: entry.hasEmail,
    score: entry.score,
    whyPicked: entry.whyPicked,
    rank,
    companyKey: entry.companyKey,
    source: entry.reusedPersonId === null ? "bought" : "reused",
  };
}

function isWebUrl(value: string | undefined): value is string {
  if (value === undefined) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
