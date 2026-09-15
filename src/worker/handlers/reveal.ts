import { NO_CRM, zohoCrmCheck } from "@/lib/leadgen/crm";
import type { CrmCheck } from "@/lib/leadgen/holds";
import type { RevealProvider } from "@/lib/leadgen/provider";
import { revealEmails, type RevealEmailsDeps } from "@/lib/leadgen/reveal";
import { leadGenSetup } from "@/lib/leadgen/setup";
import { DOCUMENTED_UNVERIFIED_PRICING, type SearchPricing } from "@/lib/leadgen/spend";
import {
  findRevealConfirmByRequest,
  findRevealResult,
  loadOrgKnowledge,
  markStaleReservations,
  persistedSpend,
  recordReveal,
  revealCandidateOf,
  revealConfirmedSchema,
  revealJobInputSchema,
  revealJobKey,
} from "@/lib/repo/leadgen";
import { services } from "@/lib/services";
import { TerminalError } from "@/worker/errors";
import type { Handler } from "@/worker/handlers/index";
import { zohoConnected } from "@/worker/handlers/leadGen";

/**
 * The `reveal` job (lead gen v2.1 §6, §7, §9, §11; v2.2 §9a): Reveal emails
 * for the kept people the rep approved, with the spend and the outcomes
 * persisted. The handler orchestrates; the core decides.
 *
 *   1. the input names a reveal confirm; the people and the credit maximum
 *      are read from that Event and nothing else;
 *   2. the people are this job's campaign rows, still chosen and kept, every
 *      one of them, or the job refuses to run;
 *   3. an earlier attempt's open reservations become unknown, so they stay
 *      counted at their worst case and a retry cannot pass the maximum;
 *   4. `revealEmails` runs with the persisted ledger, kind `reveal`;
 *   5. the outcomes and the `leadgen.revealed` Event are written once.
 *
 * With no provider set up the job fails and says so. Emails only: the
 * provider interface has no way to ask for anything else.
 */

export type RevealHandlerDeps = {
  /** The reveal provider, or null where none is set up. */
  revealer: () => RevealProvider | null;
  crm: CrmCheck;
  pricing?: SearchPricing;
  retry?: RevealEmailsDeps["retry"];
  now?: () => Date;
};

export function defaultRevealDeps(): RevealHandlerDeps {
  const setup = leadGenSetup();
  return {
    revealer: () => (setup === null ? null : setup.revealer()),
    crm: zohoConnected() ? zohoCrmCheck(services().zoho) : NO_CRM,
    ...(setup === null ? {} : { pricing: setup.pricing }),
  };
}

export function revealHandler(deps: RevealHandlerDeps = defaultRevealDeps()): Handler {
  return async ({ db, job }) => {
    const parsed = revealJobInputSchema.safeParse(job.input);
    if (!parsed.success) throw new TerminalError("reveal: bad input");
    if (job.campaignId === null || job.briefVersion === null) throw new TerminalError("reveal: bad input (no campaign)");
    const scope = { orgId: job.orgId, campaignId: job.campaignId, briefVersion: job.briefVersion };

    // Already recorded on an earlier attempt: the Event is the answer.
    const done = await findRevealResult(db, { orgId: job.orgId, jobId: job.id });
    if (done !== null) return { eventId: done.id };

    const confirm = await findRevealConfirmByRequest(db, { orgId: job.orgId, campaignId: job.campaignId, requestId: parsed.data.revealRequestId });
    if (confirm === null) throw new TerminalError("reveal: bad input (no reveal confirm for this campaign)");
    const approved = revealConfirmedSchema.safeParse(confirm.after);
    if (!approved.success) throw new TerminalError("reveal: the reveal confirm does not parse");
    const after = approved.data;
    // The approval is this job's own, for this search's people.
    if (after.jobId !== job.id || after.briefVersion !== job.briefVersion || after.leadGenJobId !== parsed.data.leadGenJobId) {
      throw new TerminalError("reveal: the reveal confirm does not belong to this job");
    }
    const pricing = deps.pricing ?? DOCUMENTED_UNVERIFIED_PRICING;
    if (pricing.id !== after.pricingAssumptions) throw new TerminalError("reveal: the pricing model is not the one the reveal was approved with");

    const provider = deps.revealer();
    if (provider === null) throw new TerminalError("reveal: no people provider is set up");

    // Exactly the people approved: this campaign's rows from that search, still chosen and kept.
    const rows = await db.campaignPerson.findMany({
      where: { ...scope, jobId: after.leadGenJobId, id: { in: after.people }, status: "chosen", review: "kept" },
      orderBy: [{ rank: "asc" }, { id: "asc" }],
    });
    if (rows.length !== after.people.length) throw new TerminalError("reveal: the kept people are not the ones the reveal was approved for");

    const knowledge = await loadOrgKnowledge(db, scope);
    await markStaleReservations(db, { orgId: job.orgId, jobId: job.id });
    const spend = persistedSpend(db, {
      ...scope,
      confirmEventId: confirm.id,
      jobId: job.id,
      attempt: job.attempts,
      cap: after.maxCredits,
      balance: { remaining: after.balanceSnapshot.remaining, readAt: new Date(after.balanceSnapshot.readAt) },
      pricingAssumptions: after.pricingAssumptions,
      kind: "reveal",
    });

    const result = await revealEmails(rows.map(revealCandidateOf), {
      provider,
      knowledge,
      crm: deps.crm,
      pricing,
      spend,
      keyBase: revealJobKey(job.campaignId, job.briefVersion),
      ...(deps.retry === undefined ? {} : { retry: deps.retry }),
    });
    const summary = await spend.summary();
    const event = await recordReveal(db, {
      orgId: job.orgId,
      job: { id: job.id, campaignId: job.campaignId, briefVersion: job.briefVersion },
      revealConfirmEventId: confirm.id,
      leadGenJobId: after.leadGenJobId,
      outcomes: result.outcomes,
      spend: { charged: summary.charged, reserved: summary.reserved },
      at: (deps.now ?? (() => new Date()))(),
    });
    return { eventId: event.id };
  };
}

export const reveal: Handler = (context) => revealHandler()(context);
