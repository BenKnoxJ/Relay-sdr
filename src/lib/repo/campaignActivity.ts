import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * A campaign's activity (final MVP pass): its own Events, newest first, each
 * reduced in SQL to the few fields a line needs. One query on
 * `(campaign_id, at)`; a research pack or a handoff never leaves the database
 * whole. The words are put on in `src/lib/campaigns/activity.ts`.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export type ActivityRow = {
  id: string;
  kind: string;
  at: Date;
  /** The rep who did it, or null for Relay's own work. */
  actorName: string | null;
  projection: unknown;
};

export const ACTIVITY_KINDS = [
  "campaign.created",
  "campaign.brief_changed",
  "research.completed",
  "campaign.research_retried",
  "campaign.confirmed",
  "leadgen.picked",
  "leadgen.halted",
  "leadgen.rerun",
  "campaign.people_reviewed",
  "campaign.reveal_confirmed",
  "leadgen.revealed",
  "campaign.reveal_retried",
] as const;

export async function campaignActivityFor(db: Db, scope: { orgId: string; campaignId: string }, limit = 40): Promise<ActivityRow[]> {
  return db.$queryRaw<ActivityRow[]>`
    SELECT e.id,
           e.kind,
           e.at,
           u.name AS "actorName",
           CASE e.kind
             WHEN 'campaign.brief_changed' THEN jsonb_build_object('cause', e.after->'cause', 'briefVersion', e.after->'briefVersion')
             WHEN 'research.completed' THEN jsonb_build_object('outcome', e.after->'outcome', 'partial', e.after->'partial')
             WHEN 'campaign.confirmed' THEN jsonb_build_object(
               'groupName', e.after->'handoff'->'buyerGroup'->'name',
               'selection', e.after->'selection',
               'cap', e.after->'handoff'->'spend'->'searchCreditCap',
               'lawfulBasis', e.after->'handoff'->'lawfulBasis'->'text'
             )
             WHEN 'leadgen.picked' THEN jsonb_build_object('n', e.after->'output'->'found'->'n', 'ofM', e.after->'output'->'found'->'ofM')
             WHEN 'leadgen.halted' THEN jsonb_build_object('reason', e.after->'output'->'reason')
             WHEN 'leadgen.rerun' THEN jsonb_build_object('cause', e.after->'cause')
             WHEN 'campaign.people_reviewed' THEN jsonb_build_object(
               'scope', e.after->'scope',
               'decision', e.after->'decision',
               'count', CASE WHEN jsonb_typeof(e.after->'people') = 'array' THEN jsonb_array_length(e.after->'people') ELSE 0 END
             )
             WHEN 'campaign.reveal_confirmed' THEN jsonb_build_object('toReveal', e.after->'counts'->'toReveal', 'known', e.after->'counts'->'known', 'maxCredits', e.after->'maxCredits')
             WHEN 'leadgen.revealed' THEN jsonb_build_object('tally', e.after->'tally')
             ELSE '{}'::jsonb
           END AS projection
      FROM events e
      LEFT JOIN users u ON u.id = e.actor_user_id
     WHERE e.org_id = ${scope.orgId}
       AND e.campaign_id = ${scope.campaignId}
       AND e.kind = ANY(${[...ACTIVITY_KINDS]}::text[])
     ORDER BY e.at DESC, e.id DESC
     LIMIT ${limit}
  `;
}
