import type { LeadGenHandoff } from "../../../agents/leadgen/input.schema";
import type { ContactSuppressionReason, HoldReason, ProviderIdentityStatus } from "../../../agents/leadgen/output.schema";

import { containsPhrase, domainKey, firmNameKey, norm } from "./normalise";
import type { ProviderCandidate } from "./provider";

/**
 * Reuse, identity and holds, leadgen v2.1 §7 and §9, over what Relay already
 * knows. The knowledge is handed in: the records it mirrors (Person,
 * ProviderIdentity, ContactSuppression, this campaign's enrolments) have no
 * tables yet, and nothing here reads or writes a database.
 *
 * Scope is the point of the split:
 *   * org-wide, about a human or contact: opt-out and do-not-contact only;
 *   * about a provider record: `no_email`, `invalid_id`, `wrong_person`,
 *     which stop Relay buying *that record* again and say nothing about the
 *     human reached through another one;
 *   * everything else holds the candidate for this campaign only.
 */

/** The canonical contact with a revealed email. Whether the email is usable is decided per campaign. */
export type KnownPerson = {
  id: string;
  email: string;
  emailType: "work" | "personal" | "unknown";
  grade: string | null;
};

export type KnownProviderIdentity = {
  provider: "lusha";
  providerId: string;
  personId: string | null;
  status: ProviderIdentityStatus;
};

export type ContactSuppression = { kind: "email" | "domain"; value: string; reason: ContactSuppressionReason };

export type OrgKnowledge = {
  people: KnownPerson[];
  providerIdentities: KnownProviderIdentity[];
  suppressions: ContactSuppression[];
  /** People with an active enrolment in *this* campaign. */
  enrolledPersonIds: string[];
  /**
   * People kept or revealed in the org's *other* campaigns (Relay P1), by
   * provider record and by Person. `revealed` says the email was obtained there.
   */
  inOtherCampaigns?: { providerId: string; personId: string | null; revealed: boolean }[];
};

/**
 * The CRM, best-effort and positive only (v2.1 §10). `true` means a lead
 * marked Customer was found. `false` means none was found, which never proves
 * "not a customer".
 */
export type CrmCheck = {
  isCustomerDomain(domain: string): Promise<boolean>;
  emailStatus(email: string): Promise<{ optOut: boolean; isCustomer: boolean }>;
};

/** Configuration. The provider's grade vocabulary is unverified (v2.1 §7). */
export type EmailPolicy = { allowedGrades: readonly string[] };

/** The proposed conservative default. Not a signed fact about the provider's grades. */
export const DEFAULT_EMAIL_POLICY: EmailPolicy = { allowedGrades: ["A+", "A"] };

/** The knowledge, indexed once per run. */
export class Knowledge {
  private readonly identities = new Map<string, KnownProviderIdentity>();
  private readonly people = new Map<string, KnownPerson>();
  private readonly byEmail = new Map<string, KnownPerson>();
  private readonly suppressed = new Map<string, ContactSuppressionReason>();
  private readonly enrolled: Set<string>;
  /** Provider record (`p:`) or Person (`h:`) taken in another campaign, and whether it was revealed there. */
  private readonly elsewhere = new Map<string, boolean>();

  constructor(knowledge: OrgKnowledge) {
    for (const identity of knowledge.providerIdentities) this.identities.set(identity.providerId, identity);
    for (const person of knowledge.people) {
      this.people.set(person.id, person);
      this.byEmail.set(person.email.toLowerCase(), person);
    }
    for (const suppression of knowledge.suppressions) {
      const value = suppression.kind === "email" ? suppression.value.toLowerCase() : domainKey(suppression.value);
      if (value !== undefined) this.suppressed.set(`${suppression.kind}:${value}`, suppression.reason);
    }
    this.enrolled = new Set(knowledge.enrolledPersonIds);
    for (const taken of knowledge.inOtherCampaigns ?? []) {
      for (const key of [`p:${taken.providerId}`, ...(taken.personId === null ? [] : [`h:${taken.personId}`])]) {
        this.elsewhere.set(key, this.elsewhere.get(key) === true || taken.revealed);
      }
    }
  }

  identity(providerId: string): KnownProviderIdentity | undefined {
    return this.identities.get(providerId);
  }

  person(id: string): KnownPerson | undefined {
    return this.people.get(id);
  }

  personByEmail(email: string): KnownPerson | undefined {
    return this.byEmail.get(email.toLowerCase());
  }

  suppression(kind: "email" | "domain", value: string | undefined): ContactSuppressionReason | undefined {
    if (value === undefined) return undefined;
    const key = kind === "email" ? value.toLowerCase() : domainKey(value);
    return key === undefined ? undefined : this.suppressed.get(`${kind}:${key}`);
  }

  isEnrolled(personId: string): boolean {
    return this.enrolled.has(personId);
  }

  /**
   * Whether this provider record, or this Person, is already in another of the
   * org's campaigns: kept or revealed there, or, with `revealedOnly`, revealed
   * there. Lead gen holds on either; Reveal only on revealed, so two campaigns
   * that both kept someone never hold each other's reveal.
   */
  inOtherCampaign(providerId: string, personId: string | null | undefined, revealedOnly = false): boolean {
    return [`p:${providerId}`, ...(personId === null || personId === undefined ? [] : [`h:${personId}`])].some((key) => {
      const revealed = this.elsewhere.get(key);
      return revealed !== undefined && (revealed || !revealedOnly);
    });
  }
}

export type PreRevealDecision = { kind: "held"; reason: HoldReason } | { kind: "eligible"; reused: KnownPerson | null };

/**
 * v2.1 §7 before reveal, on the preview alone, apart from the CRM check the
 * caller makes (it is asynchronous and cached per domain). Email-based holds
 * are not here: a preview has no email.
 */
export function preRevealChecks(
  candidate: ProviderCandidate,
  handoff: LeadGenHandoff,
  knowledge: Knowledge,
  placeNames: ReadonlySet<string>,
): PreRevealDecision {
  const identity = knowledge.identity(candidate.providerId);
  if (identity !== undefined && identity.status !== "usable") return { kind: "held", reason: "provider_unusable" };
  if (knowledge.inOtherCampaign(candidate.providerId, identity?.personId)) return { kind: "held", reason: "in_other_campaign" };

  const domainSuppression = knowledge.suppression("domain", candidate.domain);
  if (domainSuppression !== undefined) return { kind: "held", reason: domainSuppression };

  if (isExcludedFirm(candidate, handoff)) return { kind: "held", reason: "excluded_firm" };

  const excluded = [...handoff.targeting.excludeTitles, ...handoff.exclusions.roles];
  if (excluded.some((phrase) => containsPhrase(candidate.title, phrase))) return { kind: "held", reason: "excluded_title" };

  if (!inGeography(candidate, handoff, placeNames)) return { kind: "held", reason: "wrong_geography" };

  const person = identity?.personId === null || identity?.personId === undefined ? undefined : knowledge.person(identity.personId);
  return { kind: "eligible", reused: person ?? null };
}

export function isExcludedFirm(candidate: ProviderCandidate, handoff: LeadGenHandoff): boolean {
  const domain = domainKey(candidate.domain);
  return handoff.exclusions.firms.some((firm) =>
    firm.domain !== undefined ? domain !== undefined && domainKey(firm.domain) === domain : firmNameKey(firm.name) === firmNameKey(candidate.company),
  );
}

/**
 * In the recipe's countries, and, when it names places, in one of them. A
 * candidate with no location is out: a missing location is never assumed to
 * be inside the scope.
 */
export function inGeography(candidate: ProviderCandidate, handoff: LeadGenHandoff, placeNames: ReadonlySet<string>): boolean {
  if (candidate.countryIso2 === undefined || !handoff.targeting.countries.includes(candidate.countryIso2)) return false;
  if (handoff.targeting.locations.length === 0) return true;
  return [candidate.state, candidate.city].some((part) => part !== undefined && placeNames.has(norm(part)));
}

/**
 * The checks an email needs (v2.1 §7, after reveal), for a revealed email or
 * a reused one at attach time. Opt-out and do-not-contact first, because they
 * are org-wide; then this campaign's rules.
 */
export async function emailHold(
  email: { address: string; type: KnownPerson["emailType"]; grade: string | null },
  knowledge: Knowledge,
  crm: CrmCheck,
  policy: EmailPolicy,
): Promise<{ reason: HoldReason; suppress?: ContactSuppression } | null> {
  const suppressed = knowledge.suppression("email", email.address) ?? knowledge.suppression("domain", email.address.split("@")[1]);
  if (suppressed !== undefined) return { reason: suppressed };
  const crmStatus = await crm.emailStatus(email.address);
  if (crmStatus.optOut) {
    // A CRM opt-out is written org-wide (v2.1 §7, item 3). Returned, not written: nothing here persists.
    return { reason: "opted_out", suppress: { kind: "email", value: email.address.toLowerCase(), reason: "opted_out" } };
  }
  if (crmStatus.isCustomer) return { reason: "customer" };
  if (email.type !== "work") return { reason: "not_work_email" };
  if (email.grade === null || !policy.allowedGrades.includes(email.grade)) return { reason: "grade" };
  return null;
}

/** What a reveal returned for one candidate. */
export type RevealAnswer =
  | { status: "invalid_id" }
  | { status: "ok"; name: string; domain?: string; email?: string; emailType: KnownPerson["emailType"]; grade: string | null };

export type PersonLink =
  | { existing: true; personId: string }
  | { existing: false; email: string; emailType: KnownPerson["emailType"]; grade: string | null };

export type IdentityUpdate = { provider: "lusha"; providerId: string; status: ProviderIdentityStatus; personId: string | null };

export type RevealOutcome =
  | { kind: "held"; reason: "invalid_id" | "wrong_person" | "no_email"; identity: IdentityUpdate }
  | { kind: "held"; reason: HoldReason; person: PersonLink; identity: IdentityUpdate; suppress?: ContactSuppression }
  | { kind: "ready"; person: PersonLink; identity: IdentityUpdate };

/**
 * One reveal, decided (v2.1 §7 after reveal, §9 canonicalisation). Pure apart
 * from the CRM read; it returns what should be recorded and records nothing.
 *
 * `alreadyInCampaign` holds Person ids this run has already attached, so two
 * provider records for one human never become two enrolments.
 */
export async function evaluateReveal(
  candidate: ProviderCandidate,
  answer: RevealAnswer,
  knowledge: Knowledge,
  crm: CrmCheck,
  policy: EmailPolicy,
  alreadyInCampaign: ReadonlySet<string>,
): Promise<RevealOutcome> {
  const unusable = (status: "invalid_id" | "wrong_person" | "no_email"): RevealOutcome => ({
    kind: "held",
    reason: status,
    identity: { provider: "lusha", providerId: candidate.providerId, status, personId: null },
  });
  if (answer.status === "invalid_id") return unusable("invalid_id");

  const answerDomain = domainKey(answer.domain);
  const previewDomain = domainKey(candidate.domain);
  if (norm(answer.name) !== norm(candidate.name) || (answerDomain !== undefined && previewDomain !== undefined && answerDomain !== previewDomain)) {
    return unusable("wrong_person");
  }
  if (answer.email === undefined || answer.email.trim() === "") return unusable("no_email");

  const existing = knowledge.personByEmail(answer.email);
  const person: PersonLink =
    existing === undefined
      ? { existing: false, email: answer.email, emailType: answer.emailType, grade: answer.grade }
      : { existing: true, personId: existing.id };
  const identity: IdentityUpdate = { provider: "lusha", providerId: candidate.providerId, status: "usable", personId: existing?.id ?? null };

  // A Person existing elsewhere in Relay is never itself a hold; the same
  // Person already enrolled here is.
  if (existing !== undefined && (knowledge.isEnrolled(existing.id) || alreadyInCampaign.has(existing.id))) {
    return { kind: "held", reason: "duplicate_in_campaign", person, identity };
  }
  if (existing !== undefined && knowledge.inOtherCampaign(candidate.providerId, existing.id, true)) {
    return { kind: "held", reason: "in_other_campaign", person, identity };
  }
  const hold = await emailHold({ address: answer.email, type: answer.emailType, grade: answer.grade }, knowledge, crm, policy);
  if (hold !== null) return { kind: "held", reason: hold.reason, person, identity, ...(hold.suppress === undefined ? {} : { suppress: hold.suppress }) };
  return { kind: "ready", person, identity };
}
