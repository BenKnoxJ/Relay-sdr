import { leadGenHandoffSchema, type LeadGenHandoff, type LeadGenHandoffV2 } from "../../../agents/leadgen/input.schema";
import {
  HOLD_REASONS,
  haltSchema,
  leadgenOutputSchema,
  type Halt,
  type HoldReason,
  type Person,
  type Pick,
} from "../../../agents/leadgen/output.schema";

import { allocate, targetAccountsFor, type Placed } from "./allocate";
import { DEFAULT_EMAIL_POLICY, Knowledge, emailHold, preRevealChecks, type CrmCheck, type EmailPolicy, type OrgKnowledge } from "./holds";
import { domainKey, norm } from "./normalise";
import { ProviderBusyError, ProviderNotSentError, ProviderUnknownOutcomeError, type LeadGenProvider, type ProviderCandidate, type ProviderFilters, type ProviderSearchPage, type ProviderVocabulary } from "./provider";
import { rankCandidates, type Eligible, type Scored } from "./rank";
import { PART_ORDER, roleTable, titlesByPart, type RolePart } from "./roles";
import { DOCUMENTED_UNVERIFIED_PRICING, SearchSpend, documentedWorstCaseCharge, inMemorySpend, type SearchPricing, type SpendEntry, type SpendPort } from "./spend";
import { INDUSTRY_ALIASES, locationNames, translate, type Translation } from "./translate";

/**
 * Finding people for one confirmed run: leadgen v2.1 §4 to §8 for a V1
 * handoff, and the account-led search of v2.2 §4a and §8a for a V2 one, end
 * to end, provider-free. It takes the frozen handoff and everything else it
 * needs as arguments, calls only the provider it was handed, and persists
 * nothing.
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
  /** Where spend is kept. In memory, from the handoff's cap and balance, when not given. */
  spend?: SpendPort;
};

export type FindPeopleResult = {
  output: Pick | Halt;
  translation: Translation | null;
  ledger: readonly SpendEntry[];
  holds: { providerId: string; reason: HoldReason }[];
  stoppedBy: "enough" | "cap_reached" | "no_more_results" | "fewer_strong_matches" | "halt";
};

const BACKOFF_MS = [1_000, 5_000, 15_000];
const DEFAULT_RETRY = {
  attempts: 3,
  wait: (attempt: number) => new Promise<void>((resolve) => setTimeout(resolve, BACKOFF_MS[attempt - 1] ?? 15_000)),
};

type Run = {
  deps: FindPeopleDeps;
  pricing: SearchPricing;
  policy: EmailPolicy;
  retry: NonNullable<FindPeopleDeps["retry"]>;
  spend: SpendPort;
  holds: FindPeopleResult["holds"];
  translated: Translation;
  knowledge: Knowledge;
  placeNames: Set<string>;
  customerDomains: Map<string, boolean>;
  seen: Set<string>;
  halt: (fields: Omit<Halt, "phase" | "spend">, translation: Translation | null) => Promise<FindPeopleResult>;
};

/** One request, with its reservation and its retries (v2.1 §6): an answer, the cap, or a reason to halt. */
type Asked = { kind: "answer"; page: ProviderSearchPage } | { kind: "cap" } | { kind: "halt"; reason: "provider_busy" | "took_too_long" };

async function ask(run: Run, base: string, filters: ProviderFilters, page: number, pageSize: number): Promise<Asked> {
  const worstCase = documentedWorstCaseCharge(pageSize, run.pricing);
  for (let attempt = 1; ; attempt += 1) {
    // The invariant, before every request, retries included: decided and
    // reserved in one step, so no other run can spend in between.
    const key = `${base}:a${attempt}`;
    if (!(await run.spend.tryReserve(key, worstCase))) return { kind: "cap" };
    try {
      const returned = await run.deps.provider.search({ key, filters, page, pageSize });
      await run.spend.reconcile(key, returned.charged);
      return { kind: "answer", page: returned };
    } catch (error) {
      if (error instanceof ProviderNotSentError) {
        // Provably never left Relay: nothing can have been charged, so nothing stays held.
        await run.spend.release(key);
      } else {
        // No billing answer came back, so the reservation stays at its worst case.
        await run.spend.markUnknown(key);
        if (!(error instanceof ProviderBusyError || error instanceof ProviderUnknownOutcomeError)) throw error;
      }
      if (attempt >= run.retry.attempts) return { kind: "halt", reason: error instanceof ProviderUnknownOutcomeError ? "took_too_long" : "provider_busy" };
      await run.retry.wait(attempt);
    }
  }
}

/** Each new preview through the pre-reveal holds (v2.1 §7): eligible ones are added to `eligible`. */
async function admit(run: Run, handoff: LeadGenHandoff, candidates: readonly ProviderCandidate[], eligible: Eligible[]): Promise<void> {
  for (const candidate of candidates) {
    if (run.seen.has(candidate.providerId)) continue;
    run.seen.add(candidate.providerId);
    const decision = await evaluate(candidate, handoff, run.knowledge, run.placeNames, run.customerDomains, run.deps.crm, run.policy);
    if (decision.kind === "held") run.holds.push({ providerId: candidate.providerId, reason: decision.reason });
    else eligible.push({ candidate, reusedPersonId: decision.reusedPersonId });
  }
}

export async function findPeople(input: unknown, deps: FindPeopleDeps): Promise<FindPeopleResult> {
  const handoff = leadGenHandoffSchema.parse(input);
  const pricing = deps.pricing ?? DOCUMENTED_UNVERIFIED_PRICING;
  const spend = deps.spend ?? inMemorySpend(new SearchSpend(handoff.spend.searchCreditCap, handoff.spend.balanceSnapshot.remaining, pricing));
  const holds: FindPeopleResult["holds"] = [];

  const halt = async (fields: Omit<Halt, "phase" | "spend">, translation: Translation | null): Promise<FindPeopleResult> => ({
    output: haltSchema.parse({ phase: "needs_you", ...fields, spend: await spend.summary() }),
    translation,
    ledger: await spend.list(),
    holds,
    stoppedBy: "halt",
  });

  const translated = translate(handoff, deps.vocabulary, {
    industryAliases: deps.industryAliases ?? INDUSTRY_ALIASES,
    ...(deps.industryChoices === undefined ? {} : { industryChoices: deps.industryChoices }),
  });
  if (!translated.ok) return halt(translated.halt, null);

  const placeNames = new Set(handoff.targeting.locations.flatMap((term) => [...locationNames(term, handoff)]));
  for (const location of translated.effective.locations) placeNames.add(norm(location.value));
  const run: Run = {
    deps,
    pricing,
    policy: deps.policy ?? DEFAULT_EMAIL_POLICY,
    retry: deps.retry ?? DEFAULT_RETRY,
    spend,
    holds,
    translated,
    knowledge: new Knowledge(deps.knowledge),
    placeNames,
    customerDomains: new Map(),
    seen: new Set(),
    halt,
  };
  return handoff.version === 2 ? accountLed(run, handoff) : titleLed(run, handoff);
}

/** v2.1 §4 and §8: pages of the whole recipe, ranked by score. A V1 handoff runs this and nothing else. */
async function titleLed(run: Run, handoff: LeadGenHandoff): Promise<FindPeopleResult> {
  const { deps, pricing, spend, holds, translated } = run;
  // One page size for the whole run (v2.1 §4), within the provider's limits and never above 50.
  const pageSize = Math.max(deps.vocabulary.pageSize.min, Math.min(handoff.howMany, deps.vocabulary.pageSize.max, 50));
  if (!(await spend.canReserve(documentedWorstCaseCharge(pageSize, pricing)))) return run.halt({ reason: "over_cap" }, translated);

  const eligible: Eligible[] = [];
  const rankOptions = { titles: handoff.targeting.titles, seedFirms: handoff.seedFirms, perCompanyMax: handoff.perCompanyMax, howMany: handoff.howMany };

  let stoppedBy: FindPeopleResult["stoppedBy"] = "no_more_results";
  for (let page = 0; ; page += 1) {
    const asked = await ask(run, `campaign:${handoff.campaign.id}:lead_gen:v${handoff.campaign.briefVersion}:p${page}`, translated.filters, page, pageSize);
    if (asked.kind === "halt") return run.halt({ reason: asked.reason }, translated);
    if (asked.kind === "cap") {
      stoppedBy = "cap_reached";
      break;
    }
    await admit(run, handoff, asked.page.candidates, eligible);
    if (rankCandidates(eligible, rankOptions).chosen.length >= handoff.howMany) {
      stoppedBy = "enough";
      break;
    }
    if (!asked.page.hasMore) {
      stoppedBy = "no_more_results";
      break;
    }
  }

  const ranked = rankCandidates(eligible, rankOptions);
  holds.push(...ranked.held);
  if (ranked.chosen.length === 0) return run.halt({ reason: "no_candidates" }, translated);
  return picked(run, handoff, ranked.chosen, ranked.spare, ranked.chosen.length < handoff.howMany ? (stoppedBy === "cap_reached" ? "cap_reached" : "no_more_results") : undefined, stoppedBy);
}

/**
 * v2.2 §4a and §8a: accounts first, found through the confirmed group's
 * `runs` titles one person per company, falling back to the next part's
 * titles while a pass finds no lead account; then one search for the roles
 * those accounts lack, inside their domains; then the four passes.
 */
async function accountLed(run: Run, handoff: LeadGenHandoffV2): Promise<FindPeopleResult> {
  const { deps, pricing, spend, holds, translated } = run;
  const roles = roleTable(handoff.buyerRoles);
  const byPart = titlesByPart(handoff.targeting.titles, roles);
  const parts = PART_ORDER.filter((part) => byPart[part].length > 0);

  const pageMin = deps.vocabulary.pageSize.min;
  const pageMax = Math.min(deps.vocabulary.pageSize.max, 50);
  const clampPage = (size: number) => Math.max(pageMin, Math.min(size, pageMax));
  const worst = (size: number) => documentedWorstCaseCharge(size, pricing);
  const target = targetAccountsFor(handoff.howMany);
  const discoveryPage = clampPage(target);
  // Room kept for the smallest complement request: discovery never spends it.
  const complementFloor = parts.length < 2 ? 0 : worst(pageMin);
  if (!(await spend.canReserve(worst(discoveryPage) + complementFloor))) return run.halt({ reason: "over_cap" }, translated);

  const options = { titles: handoff.targeting.titles, seedFirms: handoff.seedFirms, perCompanyMax: handoff.perCompanyMax, howMany: handoff.howMany, roles };
  const base = `campaign:${handoff.campaign.id}:lead_gen:v${handoff.campaign.briefVersion}`;
  const eligible: Eligible[] = [];
  let capStopped = false;

  // Search 1: account discovery, one part's titles a pass. A pass that finds
  // no lead account hands over to the next part, inside the same cap.
  let discoveryPart: RolePart | null = null;
  const passes = parts.length === 0 ? [null] : parts;
  for (const [index, part] of passes.entries()) {
    if (index > 0 && !(await spend.canReserve(worst(discoveryPage) + complementFloor))) {
      capStopped = true;
      break;
    }
    discoveryPart = part;
    const titles = part === null ? handoff.targeting.titles : byPart[part];
    // The first pass keeps its original key, so its spend reservations match earlier runs.
    const pass = index === 0 ? "accounts" : `accounts:${part}`;
    for (let page = 0; ; page += 1) {
      const asked = await ask(run, `${base}:${pass}:p${page}`, { ...translated.filters, titles: [...titles], maxContactsPerCompany: 1 }, page, discoveryPage);
      if (asked.kind === "halt") return run.halt({ reason: asked.reason }, translated);
      if (asked.kind === "cap") {
        capStopped = true;
        break;
      }
      await admit(run, handoff, asked.page.candidates, eligible);
      // v2.2 §4a: page only while fewer than the target have a lead, and more remain.
      const leads = allocate(eligible, options).leadAccounts.length;
      if (leads >= target || !asked.page.hasMore) break;
      // A page that leaves this pass with no lead hands over to the next part,
      // rather than paging weak or held results to the cap.
      if (leads === 0 && index < passes.length - 1) break;
      if (!(await spend.canReserve(worst(discoveryPage) + complementFloor))) {
        capStopped = true;
        break;
      }
    }
    if (capStopped || allocate(eligible, options).leadAccounts.length > 0) break;
  }
  const complementParts = parts.filter((part) => part !== discoveryPart);
  const complementTitles = complementParts.flatMap((part) => byPart[part]);

  // Search 2: the roles the lead accounts lack, inside those accounts only.
  const first = allocate(eligible, options);
  const leadAccounts = new Set(first.leadAccounts);
  const domains = [
    ...new Set(first.chosen.filter((entry) => leadAccounts.has(entry.companyKey)).flatMap((entry) => domainKey(entry.candidate.domain) ?? [])),
  ].sort();
  const remaining = handoff.howMany - first.leadAccounts.length;
  if (complementTitles.length > 0 && domains.length > 0 && remaining > 0) {
    const perAccount = Math.min(handoff.perCompanyMax - 1, complementParts.length);
    let size = clampPage(Math.min(remaining, domains.length * perAccount));
    // Never over the cap: a smaller page, down to the provider's minimum, or no search at all.
    while (size >= pageMin && !(await spend.canReserve(worst(size)))) size -= 1;
    if (size < pageMin) {
      capStopped = true;
    } else {
      const asked = await ask(
        run,
        `${base}:complement`,
        { ...translated.filters, titles: complementTitles, maxContactsPerCompany: perAccount, companyDomains: domains },
        0,
        size,
      );
      if (asked.kind === "halt") return run.halt({ reason: asked.reason }, translated);
      if (asked.kind === "cap") capStopped = true;
      else {
        const inside = new Set(domains);
        // Anyone outside the accounts asked about was not asked for.
        await admit(
          run,
          handoff,
          asked.page.candidates.filter((candidate) => inside.has(domainKey(candidate.domain) ?? "")),
          eligible,
        );
      }
    }
  }

  const allocated = allocate(eligible, options);
  holds.push(...allocated.held);
  // Nobody found because the cap stopped the search is the cap's doing, not the recipe's.
  if (allocated.chosen.length === 0) return run.halt({ reason: capStopped ? "over_cap" : "no_candidates" }, translated);
  // v2.2 §8a: short is `cap_reached` when the cap stopped a search, and
  // otherwise `fewer_strong_matches`.
  const shortfall = allocated.chosen.length >= handoff.howMany ? undefined : capStopped ? ("cap_reached" as const) : ("fewer_strong_matches" as const);
  return picked(run, handoff, allocated.chosen, allocated.spare, shortfall, shortfall ?? "enough");
}

async function picked(
  run: Run,
  handoff: LeadGenHandoff,
  ranked: readonly ((Scored | Placed) & { rank: number })[],
  spare: readonly (Scored | Placed)[],
  shortfall: Pick["shortfall"],
  stoppedBy: FindPeopleResult["stoppedBy"],
): Promise<FindPeopleResult> {
  const { pricing, spend, holds, translated } = run;
  const chosen = ranked.map((entry) => toPerson(entry, entry.rank));
  const toBuy = ranked.filter((entry) => entry.reusedPersonId === null && entry.candidate.hasEmail && revealCost(entry, pricing) > 0);
  const pick: Pick = {
    phase: "pick",
    chosen,
    spare: spare.map((entry, index) => toPerson(entry, ranked.length + index + 1)),
    found: { n: chosen.length, ofM: handoff.howMany },
    ...(shortfall === undefined ? {} : { shortfall }),
    spend: await spend.summary(),
    revealEstimate: {
      toBuy: toBuy.length,
      reused: ranked.filter((entry) => entry.reusedPersonId !== null).length,
      credits: toBuy.reduce((total, entry) => total + revealCost(entry, pricing), 0),
    },
    holdsApplied: HOLD_REASONS.map((reason) => ({ reason, count: holds.filter((hold) => hold.reason === reason).length })).filter((hold) => hold.count > 0),
  };
  return { output: leadgenOutputSchema.parse(pick) as Pick, translation: translated, ledger: await spend.list(), holds, stoppedBy };
}

type Decision = { kind: "held"; reason: HoldReason } | { kind: "eligible"; reusedPersonId: string | null };

async function evaluate(
  candidate: ProviderCandidate,
  handoff: LeadGenHandoff,
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

function toPerson(entry: Scored | Placed, rank: number): Person {
  const { candidate } = entry;
  // The provider's own domain, as returned: the registrable domain is for
  // matching and keying (`companyKey`), not for what the rep reads.
  const domain = candidate.domain?.trim();
  const role = "role" in entry ? entry.role : null;
  return {
    id: candidate.providerId,
    lushaId: candidate.providerId,
    name: candidate.name,
    title: candidate.title,
    company: candidate.company,
    ...(domain === undefined || domain === "" || domain.length > 253 ? {} : { domain }),
    // Eligible candidates are inside the recipe's countries (`inGeography`).
    country: candidate.countryIso2!,
    ...(candidate.city === undefined ? {} : { city: candidate.city }),
    ...(isWebUrl(candidate.linkedinUrl) ? { linkedinUrl: candidate.linkedinUrl } : {}),
    hasEmail: entry.hasEmail,
    score: entry.score,
    whyPicked: entry.whyPicked,
    rank,
    companyKey: entry.companyKey,
    ...(candidate.companyId === undefined || candidate.companyId.length > 120 ? {} : { companyId: candidate.companyId }),
    ...(role === null ? {} : { role: { part: role.part, title: role.title, how: role.how } }),
    emailRevealCredits: candidate.emailRevealCredits === null ? null : Math.max(0, Math.round(candidate.emailRevealCredits)),
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
