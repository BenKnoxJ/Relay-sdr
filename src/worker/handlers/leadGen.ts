import type { LeadGenHandoffV1 } from "../../../agents/leadgen/input.schema";
import { zohoCrmCheck } from "@/lib/leadgen/crm";
import { findPeople, type FindPeopleDeps } from "@/lib/leadgen/findPeople";
import type { CrmCheck } from "@/lib/leadgen/holds";
import { leadGenSetup, type LeadGenEnvironment } from "@/lib/leadgen/setup";
import { DOCUMENTED_UNVERIFIED_PRICING, type SearchPricing } from "@/lib/leadgen/spend";
import {
  findConfirmByRequest,
  findLeadGenResult,
  handoffOf,
  leadGenJobInputSchema,
  loadOrgKnowledge,
  markStaleReservations,
  persistedSpend,
  recordLeadGenResult,
} from "@/lib/repo/leadgen";
import { services } from "@/lib/services";
import { TerminalError } from "@/worker/errors";
import type { Handler } from "@/worker/handlers/index";

/**
 * The `lead_gen` job (lead gen v2.1; orchestrator A2): the signed core, run
 * on the frozen handoff, with its spend and result persisted. The handler
 * orchestrates and decides nothing the core decides.
 *
 *   1. the input names a Confirm; the handoff is read from that Event and
 *      nothing else, so a brief or research changed since cannot reach it;
 *   2. what the org already knows (people, provider records, suppressions,
 *      this version's enrolments) is read for this job's org only;
 *   3. an earlier attempt's open reservations become unknown, so they stay
 *      counted at their worst case;
 *   4. `findPeople` runs with the persisted spend ledger;
 *   5. the result Event, and People found's candidates, are written once.
 *
 * With no provider set up the job fails and says so. It never finds sample
 * people in place of real ones.
 */

export type LeadGenHandlerDeps = {
  /** The provider and vocabulary for a handoff, or null where none is set up. */
  environment: (handoff: LeadGenHandoffV1) => LeadGenEnvironment | null;
  crm: CrmCheck;
  pricing?: SearchPricing;
  retry?: FindPeopleDeps["retry"];
};

export function defaultLeadGenDeps(): LeadGenHandlerDeps {
  const setup = leadGenSetup();
  return {
    environment: (handoff) => (setup === null ? null : setup.environment(handoff)),
    crm: zohoCrmCheck(services().zoho),
  };
}

export function leadGenHandler(deps: LeadGenHandlerDeps = defaultLeadGenDeps()): Handler {
  return async ({ db, job }) => {
    const parsed = leadGenJobInputSchema.safeParse(job.input);
    if (!parsed.success) throw new TerminalError("lead gen: bad input");
    if (job.campaignId === null || job.briefVersion === null) throw new TerminalError("lead gen: bad input (no campaign)");
    const scope = { orgId: job.orgId, campaignId: job.campaignId, briefVersion: job.briefVersion };

    // Already recorded on an earlier attempt: the Event is the answer.
    const done = await findLeadGenResult(db, { orgId: job.orgId, jobId: job.id });
    if (done !== null) return { eventId: done.id };

    const confirm = await findConfirmByRequest(db, { orgId: job.orgId, campaignId: job.campaignId, requestId: parsed.data.confirmRequestId });
    if (confirm === null) throw new TerminalError("lead gen: bad input (no Confirm for this campaign)");
    let handoff: LeadGenHandoffV1;
    try {
      handoff = handoffOf(confirm);
    } catch {
      throw new TerminalError("lead gen: the frozen handoff does not parse");
    }
    // The handoff is this job's own, never another org's or campaign's.
    if (handoff.campaign.orgId !== job.orgId || handoff.campaign.id !== job.campaignId || handoff.campaign.briefVersion !== job.briefVersion) {
      throw new TerminalError("lead gen: the handoff does not belong to this job");
    }
    const pricing = deps.pricing ?? DOCUMENTED_UNVERIFIED_PRICING;
    if (pricing.id !== handoff.spend.pricingAssumptions) throw new TerminalError("lead gen: the pricing model is not the one Confirm froze");

    const environment = deps.environment(handoff);
    if (environment === null) throw new TerminalError("lead gen: no people provider is set up");

    const knowledge = await loadOrgKnowledge(db, scope);
    await markStaleReservations(db, { orgId: job.orgId, jobId: job.id });
    const spend = persistedSpend(db, {
      ...scope,
      confirmEventId: confirm.id,
      jobId: job.id,
      attempt: job.attempts,
      cap: handoff.spend.searchCreditCap,
      balance: { remaining: handoff.spend.balanceSnapshot.remaining, readAt: new Date(handoff.spend.balanceSnapshot.readAt) },
      pricingAssumptions: handoff.spend.pricingAssumptions,
    });

    const result = await findPeople(handoff, {
      provider: environment.provider,
      vocabulary: environment.vocabulary,
      knowledge,
      crm: deps.crm,
      spend,
      pricing,
      ...(deps.retry === undefined ? {} : { retry: deps.retry }),
      ...(parsed.data.industryChoices === undefined ? {} : { industryChoices: parsed.data.industryChoices }),
    });
    const event = await recordLeadGenResult(db, { orgId: job.orgId, job: { id: job.id, ...scope }, confirmEventId: confirm.id, result, knowledge });
    return { eventId: event.id };
  };
}

export const leadGen: Handler = (context) => leadGenHandler()(context);
