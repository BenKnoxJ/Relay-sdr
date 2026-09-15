import type { HoldReason, ProviderIdentityStatus } from "../../../agents/leadgen/output.schema";

import { DEFAULT_EMAIL_POLICY, Knowledge, emailHold, evaluateReveal, type ContactSuppression, type CrmCheck, type EmailPolicy, type OrgKnowledge, type PersonLink } from "./holds";
import { ProviderNotSentError, type ProviderCandidate, type RevealProvider, type RevealedContact } from "./provider";
import type { SearchPricing, SpendEntry, SpendPort } from "./spend";

/**
 * Reveal emails, the second spend gate (lead gen v2.1 §6, §7, §9; v2.2 §9a),
 * provider-free: which kept people Relay already knows, which it asks the
 * provider for, and what each answer comes to. It takes the kept people and
 * everything else as arguments, calls only the provider and the CRM check it
 * was handed, and persists nothing.
 *
 * Only kept people ever reach here; pending and dropped are never revealed.
 * Before anything is bought:
 *   * a provider record already known to be unusable is not bought again;
 *   * an email Relay already owns through that record is reused, for nothing;
 *   * an org-wide opt-out or do-not-contact blocks the person;
 *   * a person the preview says has no email is not bought.
 *
 * Every request keeps the spend invariant: its documented worst case is
 * reserved first, against the maximum the rep approved and the balance read
 * for it, and reconciled to what the provider reported. A request that never
 * left Relay releases its reservation; one that may have been sent keeps its
 * worst case, and the people in it are not bought again automatically.
 */

/** A kept person, as reveal reads them: the stored candidate, and nothing from a provider since. */
export type RevealCandidate = {
  /** The campaign row's id. */
  id: string;
  providerId: string;
  /** Set when the search already reused a Person Relay owns. */
  personId: string | null;
  name: string;
  company: string;
  domain?: string;
  /** The preview says an email exists. */
  hasEmail: boolean;
  /** What the preview said revealing the email costs; null when it did not say. */
  emailRevealCredits: number | null;
};

export type RevealState = "revealed" | "known" | "no_email" | "suppressed" | "held" | "failed";

export type RevealPlanEntry =
  | { kind: "known"; personId: string }
  /** `free`: the preview said this email was revealed for the account before. It is still reserved at the documented price. */
  | { kind: "reveal"; worstCase: number; free: boolean }
  | { kind: "skip"; reveal: "no_email" | "suppressed" | "held"; hold: HoldReason };

/** What the rep sees before approving, and what the approval covers. */
export type RevealCounts = {
  kept: number;
  /** Already owned: attached for no credit. */
  known: number;
  /** Emails Relay will ask the provider for. */
  toReveal: number;
  /** Of those, how many the preview said are already free. */
  free: number;
  /** The most the reveal can spend: every email asked for at its documented worst case. */
  maxCredits: number;
  /** Kept people with no email to reveal. */
  noEmail: number;
  /** Kept people who cannot be contacted or revealed: opted out, do not contact, or an unusable record. */
  unavailable: number;
};

export type RevealPlan = { entries: ReadonlyMap<string, RevealPlanEntry>; counts: RevealCounts };

/**
 * The most revealing one email can cost. Never below the documented per-email
 * price: a preview's "already free" is a snapshot from the search, and the
 * approved maximum must hold even if it was wrong.
 */
export function revealWorstCase(candidate: Pick<RevealCandidate, "emailRevealCredits">, pricing: Pick<SearchPricing, "revealPerEmail">): number {
  return Math.max(candidate.emailRevealCredits ?? pricing.revealPerEmail, pricing.revealPerEmail);
}

/**
 * What Reveal emails would do for these kept people, from what Relay already
 * knows and nothing else: no provider call and no CRM call. The screen's
 * figures and the approval are both this function's answer, so they agree.
 */
export function planReveal(kept: readonly RevealCandidate[], knowledge: Knowledge, pricing: Pick<SearchPricing, "revealPerEmail">): RevealPlan {
  const entries = new Map<string, RevealPlanEntry>();
  const attached = new Set<string>();
  for (const candidate of kept) {
    const identity = knowledge.identity(candidate.providerId);
    // A record already paid for with no usable result, or refused: never bought again (v2.1 §9).
    if (identity !== undefined && identity.status !== "usable") {
      entries.set(candidate.id, identity.status === "no_email" ? { kind: "skip", reveal: "no_email", hold: "no_email" } : { kind: "skip", reveal: "held", hold: "provider_unusable" });
      continue;
    }
    // Reuse only through this provider record, or the Person the search already linked: never by name.
    const personId = identity?.personId ?? candidate.personId;
    const person = personId === null ? undefined : knowledge.person(personId);
    if (person !== undefined) {
      if (attached.has(person.id)) {
        entries.set(candidate.id, { kind: "skip", reveal: "held", hold: "duplicate_in_campaign" });
        continue;
      }
      attached.add(person.id);
      const suppressed = knowledge.suppression("email", person.email) ?? knowledge.suppression("domain", person.email.split("@")[1]);
      entries.set(candidate.id, suppressed === undefined ? { kind: "known", personId: person.id } : { kind: "skip", reveal: "suppressed", hold: suppressed });
      continue;
    }
    const domainSuppressed = knowledge.suppression("domain", candidate.domain);
    if (domainSuppressed !== undefined) {
      entries.set(candidate.id, { kind: "skip", reveal: "suppressed", hold: domainSuppressed });
      continue;
    }
    if (!candidate.hasEmail) {
      entries.set(candidate.id, { kind: "skip", reveal: "no_email", hold: "no_email" });
      continue;
    }
    entries.set(candidate.id, { kind: "reveal", worstCase: revealWorstCase(candidate, pricing), free: candidate.emailRevealCredits === 0 });
  }
  const all = [...entries.values()];
  const reveals = all.filter((entry): entry is Extract<RevealPlanEntry, { kind: "reveal" }> => entry.kind === "reveal");
  return {
    entries,
    counts: {
      kept: kept.length,
      known: all.filter((entry) => entry.kind === "known").length,
      toReveal: reveals.length,
      free: reveals.filter((entry) => entry.free).length,
      maxCredits: reveals.reduce((total, entry) => total + entry.worstCase, 0),
      noEmail: all.filter((entry) => entry.kind === "skip" && entry.reveal === "no_email").length,
      unavailable: all.filter((entry) => entry.kind === "skip" && entry.reveal !== "no_email").length,
    },
  };
}

/** What one kept person's reveal came to, for the caller to persist. */
export type RevealOutcome = {
  id: string;
  providerId: string;
  reveal: RevealState;
  hold: HoldReason | null;
  /** The Person this person resolves to, when they resolve to one. */
  person: PersonLink | null;
  /** The campaign row is linked to that Person: not when another row in the campaign already is. */
  enrol: boolean;
  /** What is now known about the provider record; `toPerson` links it to the outcome's Person. */
  identity: { status: ProviderIdentityStatus; toPerson: boolean } | null;
  /** An org-wide opt-out the CRM reported, to be written. */
  suppress: ContactSuppression | null;
  /** The name the Person is created with: the preview's, as the rep read it. */
  name: string;
};

export type RevealEmailsDeps = {
  provider: RevealProvider;
  knowledge: OrgKnowledge;
  crm: CrmCheck;
  pricing: Pick<SearchPricing, "revealPerEmail">;
  spend: SpendPort;
  /** The request keys' base: `campaign:<id>:reveal:v<n>`; a batch is `:b<k>`, a try `:a<n>`. */
  keyBase: string;
  policy?: EmailPolicy;
  /** Retries of a request that never left Relay: attempts per batch, and the wait before each. */
  retry?: { attempts: number; wait: (attempt: number) => Promise<void> };
};

export type RevealEmailsResult = { plan: RevealPlan; outcomes: RevealOutcome[]; ledger: readonly SpendEntry[] };

const BACKOFF_MS = [1_000, 5_000, 15_000];
const DEFAULT_RETRY = {
  attempts: 3,
  wait: (attempt: number) => new Promise<void>((resolve) => setTimeout(resolve, BACKOFF_MS[attempt - 1] ?? 15_000)),
};

type Asked = { kind: "answer"; contacts: Map<string, RevealedContact> } | { kind: "stopped" };

/**
 * One batch, with its reservation and its retries. Only a request that
 * provably never left Relay is tried again: anything that may have been sent
 * keeps its worst case held, and asking again would reserve it twice.
 */
async function ask(deps: RevealEmailsDeps, retry: NonNullable<RevealEmailsDeps["retry"]>, base: string, providerIds: string[], worstCase: number): Promise<Asked> {
  for (let attempt = 1; ; attempt += 1) {
    const key = `${base}:a${attempt}`;
    if (!(await deps.spend.tryReserve(key, worstCase))) return { kind: "stopped" };
    try {
      const answer = await deps.provider.revealEmails({ key, providerIds });
      await deps.spend.reconcile(key, answer.charged);
      return { kind: "answer", contacts: answer.contacts };
    } catch (error) {
      if (!(error instanceof ProviderNotSentError)) {
        // A busy answer, a timeout, a server fault or anything else: no billing
        // answer came back, so the reservation stays at its worst case, and the
        // batch is recorded as not revealed rather than thrown, because a
        // retried job could only reserve it a second time.
        await deps.spend.markUnknown(key);
        return { kind: "stopped" };
      }
      // Provably never left Relay: nothing can have been charged.
      await deps.spend.release(key);
      if (attempt >= retry.attempts) return { kind: "stopped" };
      await retry.wait(attempt);
    }
  }
}

const TYPE_ORDER: Record<string, number> = { work: 0, personal: 1, unknown: 2 };
const GRADE_ORDER: Record<string, number> = { "A+": 0, A: 1, B: 2, C: 3, D: 4 };

/** The email Relay keeps when several come back: work before personal, then the best grade, then the provider's order. */
export function pickEmail(emails: Extract<RevealedContact, { status: "found" }>["emails"]) {
  return [...emails]
    .map((email, index) => ({ email, index }))
    .sort((a, b) => (TYPE_ORDER[a.email.type] ?? 3) - (TYPE_ORDER[b.email.type] ?? 3) || (GRADE_ORDER[a.email.grade ?? ""] ?? 9) - (GRADE_ORDER[b.email.grade ?? ""] ?? 9) || a.index - b.index)[0]?.email;
}

function* batches<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let start = 0; start < items.length; start += size) yield items.slice(start, start + size);
}

export async function revealEmails(kept: readonly RevealCandidate[], deps: RevealEmailsDeps): Promise<RevealEmailsResult> {
  const knowledge = new Knowledge(deps.knowledge);
  const policy = deps.policy ?? DEFAULT_EMAIL_POLICY;
  const retry = deps.retry ?? DEFAULT_RETRY;
  const plan = planReveal(kept, knowledge, deps.pricing);
  const outcomes = new Map<string, RevealOutcome>();
  // One human, one enrolment in the campaign: Persons already attached by this reveal, and new emails.
  const attachedPersons = new Set<string>();
  const attachedEmails = new Set<string>();
  const base = (candidate: RevealCandidate) => ({ id: candidate.id, providerId: candidate.providerId, name: candidate.name });
  const none = { person: null, enrol: false, identity: null, suppress: null };

  // Nothing is bought for these: already known, or not to be revealed at all.
  for (const candidate of kept) {
    const entry = plan.entries.get(candidate.id)!;
    if (entry.kind === "skip") {
      outcomes.set(candidate.id, { ...base(candidate), ...none, reveal: entry.reveal, hold: entry.hold });
      continue;
    }
    if (entry.kind !== "known") continue;
    const person = knowledge.person(entry.personId)!;
    attachedPersons.add(person.id);
    // This campaign's checks on the email Relay owns, at attach time, with no provider call (v2.1 §9).
    const hold = await emailHold({ address: person.email, type: person.emailType, grade: person.grade }, knowledge, deps.crm, policy);
    outcomes.set(candidate.id, {
      ...base(candidate),
      reveal: hold === null ? "known" : hold.reason === "opted_out" || hold.reason === "dnc" ? "suppressed" : "held",
      hold: hold?.reason ?? null,
      person: { existing: true, personId: person.id },
      enrol: true,
      identity: null,
      suppress: hold?.suppress ?? null,
    });
  }

  const toReveal = kept.filter((candidate) => plan.entries.get(candidate.id)!.kind === "reveal");
  let index = 0;
  for (const batch of batches(toReveal, deps.provider.maxIds)) {
    const worstCase = batch.reduce((total, candidate) => total + (plan.entries.get(candidate.id) as Extract<RevealPlanEntry, { kind: "reveal" }>).worstCase, 0);
    const asked = await ask(deps, retry, `${deps.keyBase}:b${index}`, batch.map((candidate) => candidate.providerId), worstCase);
    index += 1;
    for (const candidate of batch) {
      const contact = asked.kind === "answer" ? asked.contacts.get(candidate.providerId) : undefined;
      if (contact === undefined || contact.status === "failed") {
        outcomes.set(candidate.id, { ...base(candidate), ...none, reveal: "failed", hold: null });
        continue;
      }
      if (contact.status === "not_found") {
        outcomes.set(candidate.id, { ...base(candidate), ...none, reveal: "held", hold: "invalid_id", identity: { status: "invalid_id", toPerson: false } });
        continue;
      }
      if (contact.status === "restricted") {
        outcomes.set(candidate.id, { ...base(candidate), ...none, reveal: "held", hold: "provider_unusable", identity: { status: "restricted", toPerson: false } });
        continue;
      }
      outcomes.set(candidate.id, await decide(candidate, contact, knowledge, deps.crm, policy, attachedPersons, attachedEmails));
    }
  }

  return { plan, outcomes: kept.map((candidate) => outcomes.get(candidate.id)!), ledger: await deps.spend.list() };
}

/** One found contact, through this campaign's post-reveal checks (v2.1 §7, §9). */
async function decide(
  candidate: RevealCandidate,
  contact: Extract<RevealedContact, { status: "found" }>,
  knowledge: Knowledge,
  crm: CrmCheck,
  policy: EmailPolicy,
  attachedPersons: Set<string>,
  attachedEmails: Set<string>,
): Promise<RevealOutcome> {
  const best = pickEmail(contact.emails);
  const preview: ProviderCandidate = {
    providerId: candidate.providerId,
    name: candidate.name,
    title: "",
    company: candidate.company,
    ...(candidate.domain === undefined ? {} : { domain: candidate.domain }),
    hasEmail: candidate.hasEmail,
    emailRevealCredits: candidate.emailRevealCredits,
  };
  const base = { id: candidate.id, providerId: candidate.providerId, name: candidate.name, suppress: null };

  // Two records in one reveal that return the same new address are one human.
  if (best !== undefined && knowledge.personByEmail(best.address) === undefined && attachedEmails.has(best.address)) {
    return {
      ...base,
      reveal: "held",
      hold: "duplicate_in_campaign",
      person: { existing: false, email: best.address, emailType: best.type, grade: best.grade },
      enrol: false,
      identity: { status: "usable", toPerson: true },
    };
  }

  const decided = await evaluateReveal(
    preview,
    { status: "ok", name: contact.name, ...(contact.domain === undefined ? {} : { domain: contact.domain }), ...(best === undefined ? {} : { email: best.address }), emailType: best?.type ?? "unknown", grade: best?.grade ?? null },
    knowledge,
    crm,
    policy,
    attachedPersons,
  );
  if (!("person" in decided)) {
    // Wrong person or no email: the record is marked so it is never bought again. No Person is made.
    const reason = decided.reason as "invalid_id" | "wrong_person" | "no_email";
    return { ...base, reveal: reason === "no_email" ? "no_email" : "held", hold: reason, person: null, enrol: false, identity: { status: decided.identity.status, toPerson: false } };
  }
  const enrol = !(decided.kind === "held" && decided.reason === "duplicate_in_campaign");
  if (enrol) {
    if (decided.person.existing) attachedPersons.add(decided.person.personId);
    else attachedEmails.add(decided.person.email);
  }
  if (decided.kind === "ready") return { ...base, reveal: "revealed", hold: null, person: decided.person, enrol, identity: { status: "usable", toPerson: true } };
  return {
    ...base,
    reveal: decided.reason === "opted_out" || decided.reason === "dnc" ? "suppressed" : "held",
    hold: decided.reason,
    person: decided.person,
    enrol,
    identity: { status: "usable", toPerson: true },
    suppress: decided.suppress ?? null,
  };
}

/** Outcomes, counted the way the screen and the Event say them. */
export function revealTally(outcomes: readonly Pick<RevealOutcome, "reveal">[]): Record<RevealState, number> {
  const tally: Record<RevealState, number> = { revealed: 0, known: 0, no_email: 0, suppressed: 0, held: 0, failed: 0 };
  for (const outcome of outcomes) tally[outcome.reveal] += 1;
  return tally;
}
