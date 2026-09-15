import type { Campaign, JobStatus, Prisma, PrismaClient } from "@prisma/client";

import { researchBriefSchema } from "../../../agents/research/input.schema";
import { widenedBrief } from "@/lib/campaigns/brief";
import { executablePlayCount, rankedPlays, type PlayFacts } from "@/lib/campaigns/plays";
import type { LeadGenResult, ResearchResultFacts } from "@/lib/campaigns/stage";
import { revealLedgerOf, spendOf, type LedgerGroup, type PeopleGroup, type ResearchCost, type SummaryInput } from "@/lib/campaigns/summary";

import { LEAD_GEN_JOB, REVEAL_JOB } from "./leadgen";

/**
 * The campaign list's reads (product-truth foundation, 2026-09-15): every
 * campaign's summary facts in a fixed number of queries, however many
 * campaigns the rep has.
 *
 *   1. the rep's campaigns;
 *   2. their jobs, 3. their credit ledger, grouped, and 4. research's recorded
 *      model cost, grouped: in parallel;
 *   5. their result Events, each reduced in SQL to the few fields a summary
 *      reads (a research pack never leaves the database whole);
 *   6. the latest search's candidates, grouped.
 *
 * No Person, provider identity or suppression is read: those are the
 * campaign page's, where Reveal's figures are worked out.
 */

type Db = PrismaClient | Prisma.TransactionClient;
type Owner = { orgId: string; userId: string };

/** The credit ledger of some of an org's campaigns, grouped by version, kind and state. */
export async function ledgerGroupsFor(db: Db, orgId: string, campaignIds: readonly string[]): Promise<(LedgerGroup & { campaignId: string })[]> {
  if (campaignIds.length === 0) return [];
  const groups = await db.creditLedgerEntry.groupBy({
    by: ["campaignId", "briefVersion", "kind", "state"],
    where: { orgId, campaignId: { in: [...campaignIds] } },
    _sum: { charged: true, worstCase: true },
    _count: { _all: true },
  });
  return groups.map((group) => ({
    campaignId: group.campaignId,
    briefVersion: group.briefVersion,
    kind: group.kind,
    state: group.state,
    rows: group._count._all,
    charged: group._sum.charged ?? 0,
    worstCase: group._sum.worstCase ?? 0,
  }));
}

/** Research's recorded model cost per campaign and brief version: the sum of its runs' steps, so a run still going counts what it has spent. */
export async function researchCostsFor(db: Db, orgId: string, campaignIds: readonly string[]): Promise<(ResearchCost & { campaignId: string })[]> {
  if (campaignIds.length === 0) return [];
  const rows = await db.$queryRaw<Array<{ campaignId: string; briefVersion: number; usd: string }>>`
    SELECT j.campaign_id AS "campaignId", j.brief_version AS "briefVersion", COALESCE(SUM(s.cost), 0)::text AS usd
      FROM jobs j
      JOIN agent_runs r ON r.job_id = j.id AND r.org_id = j.org_id
      JOIN agent_run_steps s ON s.run_id = r.id AND s.org_id = r.org_id
     WHERE j.org_id = ${orgId}
       AND j.campaign_id = ANY(${[...campaignIds]}::text[])
       AND j.kind = 'research'
     GROUP BY j.campaign_id, j.brief_version
  `;
  return rows.map((row) => ({ campaignId: row.campaignId, briefVersion: row.briefVersion, usd: Number(row.usd) }));
}

type JobRow = { id: string; campaignId: string | null; briefVersion: number | null; kind: string; status: JobStatus; error: string | null; createdAt: Date };

type EventRow = { kind: string; campaignId: string; jobId: string | null; briefVersion: number | null; projection: unknown };

/** The result Events, each reduced to what a summary reads. */
async function resultEventsFor(db: Db, orgId: string, campaignIds: readonly string[]): Promise<EventRow[]> {
  return db.$queryRaw<EventRow[]>`
    SELECT e.kind,
           e.campaign_id AS "campaignId",
           e.after->>'jobId' AS "jobId",
           CASE WHEN jsonb_typeof(e.after->'briefVersion') = 'number' THEN (e.after->>'briefVersion')::int END AS "briefVersion",
           CASE e.kind
             WHEN 'research.completed' THEN jsonb_build_object(
               'outcome', e.after->'outcome',
               'hasPack', jsonb_typeof(e.after->'pack') = 'object',
               'insufficient', (e.after->'pack'->'insufficient') IS NOT NULL,
               'partial', e.after->'pack'->'partial',
               'widenings', e.after->'pack'->'insufficient'->'widenings',
               'archetypeIds', jsonb_path_query_array(e.after, '$.pack.modules.m03 ? (@.status == "complete").archetypes[*].id'),
               'recipeArchetypeIds', jsonb_path_query_array(e.after, '$.pack.modules.m04 ? (@.status == "complete").perArchetype[*] ? (exists(@.recipe)).archetypeId'),
               'candidates', jsonb_path_query_array(e.after, '$.pack.modules.m16 ? (@.status == "complete").candidates[*]')
             )
             WHEN 'campaign.confirmed' THEN jsonb_build_object(
               'buyerGroup', e.after->'handoff'->'buyerGroup',
               'play', e.after->'handoff'->'play',
               'cap', e.after->'handoff'->'spend'->'searchCreditCap'
             )
             WHEN 'leadgen.picked' THEN jsonb_build_object('phase', e.after->'output'->'phase')
             WHEN 'leadgen.halted' THEN jsonb_build_object('reason', e.after->'output'->'reason', 'choices', e.after->'output'->'choices')
             WHEN 'campaign.reveal_confirmed' THEN jsonb_build_object('leadGenJobId', e.after->'leadGenJobId', 'maxCredits', e.after->'maxCredits')
           END AS projection
      FROM events e
     WHERE e.org_id = ${orgId}
       AND e.campaign_id = ANY(${[...campaignIds]}::text[])
       AND e.kind IN ('research.completed', 'campaign.confirmed', 'leadgen.picked', 'leadgen.halted', 'campaign.reveal_confirmed', 'leadgen.revealed')
     ORDER BY e.at ASC, e.id ASC
  `;
}

const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
const numberOr = (value: unknown, fallback: number | null): number | null => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

function playFactsOfProjection(projection: Record<string, unknown>): PlayFacts {
  const candidates = (Array.isArray(projection.candidates) ? projection.candidates : []).flatMap((value) => {
    const candidate = record(value);
    return typeof candidate.id === "string" && typeof candidate.archetypeId === "string" && typeof candidate.rank === "number"
      ? [{ id: candidate.id, rank: candidate.rank, archetypeId: candidate.archetypeId }]
      : [];
  });
  return { archetypeIds: strings(projection.archetypeIds), recipeArchetypeIds: strings(projection.recipeArchetypeIds), candidates };
}

/** The latest job of one kind at the campaign's current version. */
function latest(jobs: readonly JobRow[], campaign: Campaign, kind: string): JobRow | null {
  return (
    jobs
      .filter((job) => job.campaignId === campaign.id && job.briefVersion === campaign.briefVersion && job.kind === kind)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))[0] ?? null
  );
}

export type CampaignSummaryRecord = { campaign: Campaign; input: SummaryInput };

export async function campaignSummariesForOwner(db: PrismaClient, owner: Owner, options: { leadGenAvailable: boolean }): Promise<CampaignSummaryRecord[]> {
  const campaigns = await db.campaign.findMany({ where: { orgId: owner.orgId, ownerUserId: owner.userId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  if (campaigns.length === 0) return [];
  const ids = campaigns.map((campaign) => campaign.id);

  const [jobs, ledger, costs, events] = await Promise.all([
    db.job.findMany({
      where: { orgId: owner.orgId, campaignId: { in: ids }, kind: { in: ["research", LEAD_GEN_JOB, REVEAL_JOB] } },
      select: { id: true, campaignId: true, briefVersion: true, kind: true, status: true, error: true, createdAt: true },
    }),
    ledgerGroupsFor(db, owner.orgId, ids),
    researchCostsFor(db, owner.orgId, ids),
    resultEventsFor(db, owner.orgId, ids),
  ]);

  // The first Event of a kind for a job is its result, as the campaign page reads it.
  const firstFor = (kinds: readonly string[], jobId: string | undefined) => (jobId === undefined ? null : (events.find((event) => kinds.includes(event.kind) && event.jobId === jobId) ?? null));

  const partial = campaigns.map((campaign) => {
    const researchJob = latest(jobs, campaign, "research");
    const leadGenJob = latest(jobs, campaign, LEAD_GEN_JOB);
    const researchEvent = firstFor(["research.completed"], researchJob?.id);
    const confirm = events.find((event) => event.kind === "campaign.confirmed" && event.campaignId === campaign.id && event.briefVersion === campaign.briefVersion) ?? null;
    const leadGenEvent = confirm === null ? null : firstFor(["leadgen.picked", "leadgen.halted"], leadGenJob?.id);
    const picked = leadGenEvent?.kind === "leadgen.picked" && record(leadGenEvent.projection).phase === "pick";
    const revealConfirm =
      picked && leadGenJob !== null
        ? (events.find((event) => event.kind === "campaign.reveal_confirmed" && event.campaignId === campaign.id && record(event.projection).leadGenJobId === leadGenJob.id) ?? null)
        : null;
    const revealJob = revealConfirm?.jobId === null || revealConfirm === null ? null : (jobs.find((job) => job.id === revealConfirm.jobId && job.kind === REVEAL_JOB) ?? null);
    const revealResult = firstFor(["leadgen.revealed"], revealJob?.id);
    return { campaign, researchJob, leadGenJob, researchEvent, confirm, leadGenEvent, picked, revealConfirm, revealJob, revealResult };
  });

  const pickedJobs = partial.flatMap((row) => (row.picked && row.leadGenJob !== null ? [row.leadGenJob.id] : []));
  const people =
    pickedJobs.length === 0
      ? []
      : await db.campaignPerson.groupBy({
          by: ["campaignId", "jobId", "status", "review", "reveal", "rolePart", "companyKey"],
          where: { orgId: owner.orgId, jobId: { in: pickedJobs } },
          _count: { _all: true },
        });

  return partial.map((row): CampaignSummaryRecord => {
    const { campaign } = row;
    const research = researchFactsOf(row.researchEvent, campaign);
    const leadGenResult: LeadGenResult | null =
      row.leadGenEvent === null
        ? null
        : row.leadGenEvent.kind === "leadgen.picked"
          ? row.picked
            ? { kind: "picked" }
            : { kind: "unreadable" }
          : typeof record(row.leadGenEvent.projection).reason === "string"
            ? { kind: "halted", reason: record(row.leadGenEvent.projection).reason as string, choices: strings(record(row.leadGenEvent.projection).choices).length }
            : { kind: "unreadable" };
    const campaignLedger = ledger.filter((group) => group.campaignId === campaign.id);
    const confirmProjection = record(row.confirm?.projection);
    const buyerGroup = record(confirmProjection.buyerGroup);
    const play = record(confirmProjection.play);
    const groups: PeopleGroup[] =
      row.picked && row.leadGenJob !== null
        ? people
            .filter((group) => group.campaignId === campaign.id && group.jobId === row.leadGenJob?.id)
            .map((group) => ({ status: group.status, review: group.review, reveal: group.reveal, rolePart: group.rolePart, companyKey: group.companyKey, count: group._count._all }))
        : [];
    return {
      campaign,
      input: {
        campaign: { id: campaign.id, name: campaign.name, briefVersion: campaign.briefVersion, createdAt: campaign.createdAt, updatedAt: campaign.updatedAt },
        stage: {
          research: { job: row.researchJob, result: research.stage },
          confirmed: row.confirm !== null,
          leadGen: row.confirm === null ? null : { job: row.leadGenJob, result: leadGenResult },
          reveal: row.revealConfirm === null ? null : { job: row.revealJob, hasResult: row.revealResult !== null, ledger: revealLedgerOf(campaignLedger, campaign.briefVersion) },
          revealPlan: null,
          leadGenAvailable: options.leadGenAvailable,
        },
        research: research.summary,
        confirmed:
          row.confirm === null || typeof buyerGroup.id !== "string" || typeof buyerGroup.name !== "string"
            ? null
            : { groupId: buyerGroup.id, groupName: buyerGroup.name, playId: typeof play.id === "string" ? play.id : null, sourceRank: numberOr(buyerGroup.sourceRank, 1) ?? 1 },
        people: row.picked ? groups : null,
        spend: spendOf(
          campaignLedger,
          costs.filter((cost) => cost.campaignId === campaign.id),
          { briefVersion: campaign.briefVersion, searchCap: row.confirm === null ? null : numberOr(confirmProjection.cap, null), revealMax: row.revealConfirm === null ? null : numberOr(record(row.revealConfirm.projection).maxCredits, null) },
        ),
      },
    };
  });
}

/** Research's result as a summary reads it, from the Event's reduced projection. */
function researchFactsOf(event: EventRow | null, campaign: Campaign): { stage: ResearchResultFacts | null; summary: SummaryInput["research"] } {
  if (event === null) return { stage: null, summary: null };
  const projection = record(event.projection);
  if (projection.hasPack !== true) return { stage: { readable: false }, summary: null };
  if (projection.insufficient === true) {
    const brief = researchBriefSchema.safeParse(campaign.brief);
    const options = Array.isArray(projection.widenings) ? projection.widenings : [];
    const usable = brief.success ? options.filter((option) => widenedBrief(brief.data, option).ok).length : 0;
    return { stage: { readable: true, outcome: "insufficient", usableWidenings: usable }, summary: { outcome: "insufficient", plays: 0, viablePlays: 0 } };
  }
  const facts = playFactsOfProjection(projection);
  const viablePlays = executablePlayCount(facts);
  const outcome = projection.partial === true ? "partial" : "complete";
  return { stage: { readable: true, outcome, executablePlays: viablePlays }, summary: { outcome, plays: rankedPlays(facts).length, viablePlays } };
}
